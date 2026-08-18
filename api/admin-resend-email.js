// POST /api/admin-resend-email?key=TU_ADMIN_KEY&ref=REF_DE_LA_ORDEN
// Reenvía el correo de confirmación de una orden ya aprobada (por ejemplo,
// si el primer envío falló). Protegido con ADMIN_KEY, igual que /api/admin.
import { ensureSchema, sendTicketEmail } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY) { res.status(500).json({ error: 'Falta ADMIN_KEY' }); return; }
  if (req.query.key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'No autorizado' }); return; }

  const ref = req.query.ref;
  if (!ref) { res.status(400).json({ error: 'Falta el parámetro ref' }); return; }

  try {
    await ensureSchema();
    const { rows } = await sql`SELECT * FROM orders WHERE ref = ${ref}`;
    const order = rows[0];
    if (!order) { res.status(404).json({ error: 'Orden no encontrada' }); return; }
    if (order.status !== 'approved') { res.status(400).json({ error: 'La orden no está aprobada, no tiene tickets que enviar' }); return; }

    const { rows: t } = await sql`SELECT number FROM tickets WHERE order_ref = ${ref} ORDER BY number`;
    const tickets = t.map(x => x.number);

    await sendTicketEmail({ ref, name: order.name, email: order.email, tickets, quantity: order.quantity });

    const { rows: updated } = await sql`SELECT email_status FROM orders WHERE ref = ${ref}`;
    res.status(200).json({ ok: true, email_status: updated[0].email_status });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
