// GET /api/admin?key=TU_ADMIN_KEY
// Lista los participantes con pago aprobado y sus números de ticket.
//
// Para BORRAR todos los datos (ej. limpiar pruebas antes de lanzar):
//   GET /api/admin?key=TU_ADMIN_KEY&action=reset&confirm=BORRAR
// Esto vacía órdenes y tickets y reinicia la numeración en 000001.
//
// Protegido con la variable de entorno ADMIN_KEY.
import { ensureSchema, resetAllData, TICKETS_TOTAL } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY) { res.status(500).json({ error: 'Falta ADMIN_KEY' }); return; }
  if (req.query.key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'No autorizado' }); return; }

  try {
    await ensureSchema();

    // Reset: borra todo y reinicia el contador de tickets.
    if (req.query.action === 'reset') {
      if (req.query.confirm !== 'BORRAR') {
        res.status(400).json({ error: 'Para confirmar agrega &confirm=BORRAR a la URL' });
        return;
      }
      await resetAllData();
      res.status(200).json({ ok: true, mensaje: 'Datos borrados. Los 2.000 números vuelven a estar disponibles.' });
      return;
    }

    const { rows: orders } = await sql`
      SELECT o.ref, o.name, o.email, o.phone, o.rut, o.quantity, o.amount, o.status,
             o.payment_id, o.created_at, o.email_status, o.email_sent_at,
             COALESCE(array_agg(t.number ORDER BY t.number) FILTER (WHERE t.number IS NOT NULL), '{}') AS tickets
      FROM orders o
      LEFT JOIN tickets t ON t.order_ref = o.ref
      GROUP BY o.ref
      ORDER BY o.created_at DESC`;

    const { rows: stats } = await sql`SELECT COUNT(*)::int AS vendidos FROM tickets WHERE order_ref IS NOT NULL`;
    const aprobadas = orders.filter(o => o.status === 'approved').length;
    res.status(200).json({
      tickets_vendidos: stats[0].vendidos,
      tickets_disponibles: TICKETS_TOTAL - stats[0].vendidos,
      total_ordenes: orders.length,
      ordenes_aprobadas: aprobadas,
      ordenes_pendientes: orders.length - aprobadas,
      ordenes: orders
    });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
