// GET /api/cron-reconcile — llamado automáticamente por Vercel Cron (ver
// vercel.json). Rescata órdenes que quedaron en 'pending' porque el webhook
// de Mercado Pago nunca llegó y el comprador tampoco volvió a la página de
// éxito: busca el pago directo en Mercado Pago por external_reference (sin
// necesitar el payment_id de antemano) y, si está aprobado, confirma la
// orden igual que lo haría el webhook. Después, expira las pendientes que
// llevan más de 24 horas sin pagarse de verdad, para que el panel no se
// llene de intentos abandonados.
import { ensureSchema, findApprovedPaymentByRef, finalizeOrder, expireStaleOrders } from './_lib.js';
import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  // Si CRON_SECRET está configurado, exige el header que Vercel agrega
  // automáticamente a las llamadas de su scheduler (evita que cualquiera
  // dispare este endpoint desde afuera). Si no está configurado, sigue
  // funcionando igual (compatibilidad hacia atrás).
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  }

  try {
    await ensureSchema();

    // Solo órdenes con al menos 5 minutos (le da tiempo al flujo normal —
    // webhook o regreso del navegador — de confirmarlas primero) y menos de
    // 24 horas (esas ya se dan por perdidas y se expiran más abajo).
    const { rows: stale } = await sql`
      SELECT ref FROM orders
      WHERE status = 'pending'
        AND created_at < now() - interval '5 minutes'
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at ASC
      LIMIT 50`;

    const results = [];
    for (const { ref } of stale) {
      try {
        const payment = await findApprovedPaymentByRef(ref);
        if (payment) {
          const r = await finalizeOrder(ref, payment.id);
          results.push({ ref, status: r.status });
        }
      } catch (e) {
        results.push({ ref, error: String(e && e.message || e) });
      }
    }

    const expired = await expireStaleOrders(24);

    res.status(200).json({
      revisadas: stale.length,
      rescatadas: results.filter(r => r.status === 'approved').length,
      expiradas: expired,
      detalle: results
    });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor', detail: String(e && e.message || e) });
  }
}
