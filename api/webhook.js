// POST/GET /api/webhook
// Recibe las notificaciones (IPN/Webhooks) de Mercado Pago. Cuando llega un
// pago, lo verifica y confirma la orden (asigna los números de ticket).
// Responde siempre 200 para que Mercado Pago no reintente en bucle.
import { ensureSchema, getPayment, finalizeOrder, readJson } from './_lib.js';

export default async function handler(req, res) {
  try {
    await ensureSchema();

    const q = req.query || {};
    let type = q.type || q.topic;
    let paymentId = q['data.id'] || q.id;

    if (req.method === 'POST') {
      const body = await readJson(req);
      type = type || body.type || body.action;
      paymentId = paymentId || (body.data && body.data.id) || body.id;
    }

    if (type && String(type).includes('payment') && paymentId) {
      const pay = await getPayment(paymentId);
      if (pay && pay.status === 'approved' && pay.external_reference) {
        await finalizeOrder(pay.external_reference, paymentId);
      }
    }
  } catch (e) {
    // Registrar pero no fallar: evita reintentos agresivos de Mercado Pago.
    console.error('webhook error:', e);
  }
  res.status(200).send('ok');
}
