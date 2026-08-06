// POST /api/create-preference
// Crea una preferencia de pago en Mercado Pago (Checkout Pro) y devuelve
// el init_point al que el navegador debe redirigir.
import { ensureSchema, calcAmount, baseUrl, readJson, uuid, TICKETS_TOTAL } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  const MP_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();
  if (!MP_TOKEN) { res.status(500).json({ error: 'Mercado Pago no está configurado (falta MP_ACCESS_TOKEN)' }); return; }

  try {
    const body = await readJson(req);
    const name = (body.name || '').toString().trim();
    const email = (body.email || '').toString().trim();
    const phone = (body.phone || '').toString().trim();
    const rut = (body.rut || '').toString().trim();
    const quantity = parseInt(body.quantity, 10);
    const amount = calcAmount(quantity);

    if (!amount) { res.status(400).json({ error: 'Cantidad inválida' }); return; }
    if (name.length < 3 || !email) { res.status(400).json({ error: 'Datos incompletos' }); return; }

    await ensureSchema();

    // Aviso temprano si ya no quedan tickets suficientes (el cupo real se
    // vuelve a verificar de forma atómica al confirmar el pago en _lib.js).
    const { rows: sold } = await sql`SELECT COUNT(*)::int AS n FROM tickets`;
    if (sold[0].n + quantity > TICKETS_TOTAL) {
      res.status(409).json({ error: 'No quedan suficientes tickets disponibles para esta cantidad' });
      return;
    }

    const ref = uuid();
    await sql`INSERT INTO orders (ref, name, email, phone, rut, quantity, amount)
              VALUES (${ref}, ${name}, ${email}, ${phone}, ${rut}, ${quantity}, ${amount})`;

    const base = baseUrl(req);
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + MP_TOKEN
      },
      body: JSON.stringify({
        items: [{
          title: 'Tickets Sorteo Tarmac SL7 — Specialized 105 Di2',
          description: quantity + ' ticket(s) del sorteo',
          quantity: 1,
          unit_price: amount,
          currency_id: 'CLP'
        }],
        payer: { name, email },
        external_reference: ref,
        back_urls: {
          success: base + '/?pago=success',
          failure: base + '/?pago=failure',
          pending: base + '/?pago=pending'
        },
        auto_return: 'approved',
        notification_url: base + '/api/webhook',
        statement_descriptor: 'EDUCYCLING'
      })
    });

    // Leer como texto primero: si Mercado Pago responde con un body vacío o
    // no-JSON (token inválido, error de cuenta, etc.), evita que .json()
    // reviente con "Unexpected end of JSON input" y esconda la causa real.
    const rawText = await prefRes.text();
    let pref = null;
    try { pref = rawText ? JSON.parse(rawText) : null; } catch (_) { pref = null; }

    if (!pref) {
      console.error('Mercado Pago devolvió una respuesta no-JSON:', prefRes.status, rawText.slice(0, 500));
      res.status(502).json({
        error: 'Mercado Pago no devolvió una respuesta válida',
        detail: { status: prefRes.status, raw: rawText.slice(0, 300) }
      });
      return;
    }

    // En modo de prueba (token TEST-…) Mercado Pago usa sandbox_init_point.
    const isTest = MP_TOKEN.startsWith('TEST-');
    const redirectUrl = (isTest && pref.sandbox_init_point) ? pref.sandbox_init_point : pref.init_point;
    if (!prefRes.ok || !redirectUrl) {
      console.error('Mercado Pago rechazó la preferencia:', prefRes.status, JSON.stringify(pref));
      res.status(502).json({ error: 'No se pudo crear el pago', detail: pref });
      return;
    }
    res.status(200).json({ init_point: redirectUrl, ref });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
