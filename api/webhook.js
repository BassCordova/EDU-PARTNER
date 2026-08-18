// POST/GET /api/webhook
// Recibe las notificaciones (IPN/Webhooks) de Mercado Pago. Cuando llega un
// pago, lo verifica y confirma la orden (asigna los números de ticket).
// Responde siempre 200 para que Mercado Pago no reintente en bucle.
import { ensureSchema, getPayment, finalizeOrder, readJson } from './_lib.js';
import crypto from 'crypto';

// Verifica la firma x-signature que manda Mercado Pago (ver Developers →
// Webhooks → "Firma secreta"). Es opcional: si MP_WEBHOOK_SECRET no está
// configurado, no bloquea nada (igual que antes) — el pago de todas formas
// se re-verifica siempre contra la API real de Mercado Pago antes de emitir
// tickets, así que esto es una capa extra, no la única defensa.
function verifySignature(req, dataId) {
  const secret = (process.env.MP_WEBHOOK_SECRET || '').trim();
  if (!secret) return true;
  const sigHeader = req.headers['x-signature'];
  const reqId = req.headers['x-request-id'];
  if (!sigHeader || !reqId || !dataId) return false;
  const parts = {};
  String(sigHeader).split(',').forEach(p => {
    const [k, v] = p.split('=').map(s => (s || '').trim());
    if (k) parts[k] = v;
  });
  if (!parts.ts || !parts.v1) return false;
  const manifest = 'id:' + String(dataId).toLowerCase() + ';request-id:' + reqId + ';ts:' + parts.ts + ';';
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return expected === parts.v1;
}

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
      if (!verifySignature(req, q['data.id'] || q.id || paymentId)) {
        console.error('Webhook: firma inválida, se ignora la notificación');
      } else {
        const pay = await getPayment(paymentId);
        if (pay && pay.status === 'approved' && pay.external_reference) {
          await finalizeOrder(pay.external_reference, paymentId);
        }
      }
    }
  } catch (e) {
    // Registrar pero no fallar: evita reintentos agresivos de Mercado Pago.
    console.error('webhook error:', e);
  }
  res.status(200).send('ok');
}
