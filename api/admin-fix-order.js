// POST /api/admin-fix-order?key=TU_ADMIN_KEY
// Herramienta de soporte manual para casos puntuales: un comprador pagó de
// verdad en Mercado Pago pero su orden quedó 'pending' o 'expired' (el
// webhook nunca llegó y el cron de reconciliación diario todavía no pasó, o
// la orden ya se había marcado 'expired' antes de que el pago apareciera).
//
// A diferencia del cron (que solo revisa 'pending'), este endpoint acepta
// cualquier estado no-aprobado y vuelve a verificar el pago directo contra
// Mercado Pago por external_reference. Si lo encuentra, confirma la orden
// (asigna tickets y envía el correo) exactamente igual que el webhook.
//
// También permite corregir el email de contacto antes de reintentar (por si
// el comprador escribió mal su correo y por eso el envío fallaba).
//
// Parámetros (query string):
//   ref       — ref exacto de la orden (uuid). Tiene prioridad sobre email.
//   email     — si no se conoce el ref, busca la orden más reciente con ese email.
//   newEmail  — opcional: corrige el email de contacto antes de reintentar.
//   authCode  — opcional, alternativa cuando no hay ref/email: código de
//               autorización de Mercado Pago (el "N° de operación" que ve el
//               comprador). Busca entre los pagos aprobados recientes el que
//               tenga ese código y usa su external_reference para ubicar la orden.
import { ensureSchema, findApprovedPaymentByRef, finalizeOrder } from './_lib.js';
import { sql } from '@vercel/postgres';

async function findRefByAuthCode(authCode) {
  const token = (process.env.MP_ACCESS_TOKEN || '').trim();
  const url = 'https://api.mercadopago.com/v1/payments/search?' + new URLSearchParams({
    sort: 'date_created', criteria: 'desc', status: 'approved', limit: '50'
  });
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  let data;
  try { data = await r.json(); } catch (_) { return null; }
  const results = (data && data.results) || [];
  const match = results.find(p => p.authorization_code === authCode);
  return match ? match.external_reference : null;
}

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY) { res.status(500).json({ error: 'Falta ADMIN_KEY' }); return; }
  if (req.query.key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'No autorizado' }); return; }

  try {
    await ensureSchema();

    let ref = (req.query.ref || '').toString().trim();
    const email = (req.query.email || '').toString().trim();
    const newEmail = (req.query.newEmail || '').toString().trim();
    const authCode = (req.query.authCode || '').toString().trim();

    if (!ref && authCode) {
      ref = await findRefByAuthCode(authCode);
      if (!ref) {
        res.status(404).json({ error: 'No se encontró ningún pago aprobado reciente con ese N° de operación' });
        return;
      }
    }

    if (!ref && email) {
      const { rows } = await sql`
        SELECT ref FROM orders WHERE lower(email) = lower(${email})
        ORDER BY created_at DESC LIMIT 1`;
      if (!rows[0]) { res.status(404).json({ error: 'No hay ninguna orden con ese email' }); return; }
      ref = rows[0].ref;
    }

    if (!ref) { res.status(400).json({ error: 'Falta ref, email o authCode' }); return; }

    const { rows: orderRows } = await sql`SELECT * FROM orders WHERE ref = ${ref}`;
    const order = orderRows[0];
    if (!order) { res.status(404).json({ error: 'Orden no encontrada', ref }); return; }

    if (newEmail) {
      await sql`UPDATE orders SET email = ${newEmail} WHERE ref = ${ref}`;
    }

    if (order.status === 'approved') {
      const { rows: t } = await sql`SELECT number FROM tickets WHERE order_ref = ${ref} ORDER BY number`;
      res.status(200).json({
        ok: true, ref, accion: 'ya_estaba_aprobada',
        tickets: t.map(x => x.number), email_actualizado: !!newEmail
      });
      return;
    }

    const payment = await findApprovedPaymentByRef(ref);
    if (!payment) {
      res.status(200).json({
        ok: false, ref, accion: 'sin_pago_aprobado_en_mercadopago',
        estado_actual: order.status, email_actualizado: !!newEmail,
        mensaje: 'No se encontró un pago aprobado en Mercado Pago para esta orden. Puede que el pago no se haya completado, o que esté con otro estado (rechazado, en revisión, etc.).'
      });
      return;
    }

    const result = await finalizeOrder(ref, payment.id);
    res.status(200).json({ ok: true, ref, accion: 'reconciliada', resultado: result, email_actualizado: !!newEmail });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
