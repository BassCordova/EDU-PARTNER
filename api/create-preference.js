// POST /api/create-preference
// Crea una preferencia de pago en Mercado Pago (Checkout Pro) y devuelve
// el init_point al que el navegador debe redirigir.
import { ensureSchema, calcAmount, baseUrl, readJson, uuid } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  if (!process.env.MP_ACCESS_TOKEN) { res.status(500).json({ error: 'Mercado Pago no está configurado (falta MP_ACCESS_TOKEN)' }); return; }

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
    const ref = uuid();
    await sql`INSERT INTO orders (ref, name, email, phone, rut, quantity, amount)
              VALUES (${ref}, ${name}, ${email}, ${phone}, ${rut}, ${quantity}, ${amount})`;

    const base = baseUrl(req);
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        items: [{
          title: 'Tickets Sorteo Partner — Peugeot Partner',
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
        statement_descriptor: 'EDUPARTNER'
      })
    });

    const pref = await prefRes.json();
    if (!prefRes.ok || !pref.init_point) {
      res.status(502).json({ error: 'No se pudo crear el pago', detail: pref });
      return;
    }
    res.status(200).json({ init_point: pref.init_point, ref });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
