// GET /api/order?ref=...&payment_id=...
// Devuelve el estado de una orden y, si el pago está aprobado, sus números de
// ticket. También intenta confirmar la orden en el momento (por si el webhook
// aún no llegó), de forma idempotente.
import { ensureSchema, finalizeOrder } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const ref = req.query.ref;
    const paymentId = req.query.payment_id || '';
    if (!ref) { res.status(400).json({ error: 'Falta el parámetro ref' }); return; }

    let result = null;
    try { result = await finalizeOrder(ref, paymentId); } catch (_) { result = null; }

    if (result && result.status !== 'not_found') {
      res.status(200).json(result);
      return;
    }

    const { rows } = await sql`SELECT status, quantity FROM orders WHERE ref = ${ref}`;
    if (!rows[0]) { res.status(404).json({ error: 'Orden no encontrada' }); return; }
    res.status(200).json({ status: rows[0].status, tickets: [], quantity: rows[0].quantity });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
}
