// GET /api/admin?key=TU_ADMIN_KEY
// Lista los participantes con pago aprobado y sus números de ticket.
// Protegido con la variable de entorno ADMIN_KEY.
import { ensureSchema } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY) { res.status(500).json({ error: 'Falta ADMIN_KEY' }); return; }
  if (req.query.key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'No autorizado' }); return; }

  try {
    await ensureSchema();
    const { rows: orders } = await sql`
      SELECT o.ref, o.name, o.email, o.phone, o.rut, o.quantity, o.amount, o.status,
             o.payment_id, o.created_at,
             COALESCE(array_agg(t.number ORDER BY t.number) FILTER (WHERE t.number IS NOT NULL), '{}') AS tickets
      FROM orders o
      LEFT JOIN tickets t ON t.order_ref = o.ref
      GROUP BY o.ref
      ORDER BY o.created_at DESC`;

    const { rows: stats } = await sql`SELECT COUNT(*)::int AS vendidos FROM tickets`;
    res.status(200).json({
      tickets_vendidos: stats[0].vendidos,
      total_ordenes: orders.length,
      ordenes: orders
    });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
