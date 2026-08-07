// ============================================================
// EDU CYCLING — utilidades compartidas del backend
// Base de datos (Vercel Postgres) + lógica de precios + confirmación
// de pagos con Mercado Pago (Checkout Pro).
// ============================================================
import { sql, createPool } from '@vercel/postgres';
import crypto from 'crypto';

export const TICKETS_TOTAL = 2000;
export const PRECIO_UNITARIO = 3000;
const PAQUETES = { 1: 3000, 2: 5000, 5: 10000 };

// Calcula el monto en CLP a partir de la cantidad. Devuelve null si es inválida.
// IMPORTANTE: el monto SIEMPRE se calcula en el servidor; nunca se confía en el cliente.
export function calcAmount(qtyRaw) {
  const qty = parseInt(qtyRaw, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > TICKETS_TOTAL) return null;
  return PAQUETES[qty] || qty * PRECIO_UNITARIO;
}

export const uuid = () => crypto.randomUUID();

// ---- Esquema (idempotente, se asegura en cada request) ----
let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS orders (
    ref         TEXT PRIMARY KEY,
    name        TEXT,
    email       TEXT,
    phone       TEXT,
    rut         TEXT,
    quantity    INT  NOT NULL,
    amount      INT  NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    payment_id  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS tickets (
    number      SERIAL PRIMARY KEY,
    order_ref   TEXT REFERENCES orders(ref),
    created_at  TIMESTAMPTZ
  )`;
  // Migración segura para bases ya existentes (creadas antes de que el pool
  // permitiera números sin dueño): la columna venía NOT NULL / con default.
  await sql`ALTER TABLE tickets ALTER COLUMN order_ref DROP NOT NULL`;
  await sql`ALTER TABLE tickets ALTER COLUMN created_at DROP NOT NULL`;
  await sql`ALTER TABLE tickets ALTER COLUMN created_at DROP DEFAULT`;
  await populateTicketPool();
  schemaReady = true;
}

// Rellena los números 1..TICKETS_TOTAL que aún no existan en el pool
// (idempotente: no toca los que ya están, sea cual sea su estado).
export async function populateTicketPool() {
  await sql`
    INSERT INTO tickets (number)
    SELECT n FROM generate_series(1, ${TICKETS_TOTAL}) AS n
    ON CONFLICT (number) DO NOTHING`;
}

// Borra todas las órdenes/tickets y repuebla el pool desde cero (000001..N,
// todos disponibles). Usado por /api/admin?action=reset.
export async function resetAllData() {
  await sql`TRUNCATE tickets, orders`;
  await populateTicketPool();
}

// ---- Mercado Pago ----
export async function getPayment(paymentId) {
  const token = (process.env.MP_ACCESS_TOKEN || '').trim();
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(paymentId), {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch (_) { return null; }
}

// ---- Confirmación de orden (idempotente y atómica) ----
// Verifica el pago con Mercado Pago, marca la orden como aprobada y asigna
// los números de ticket en una transacción. Si ya estaba aprobada, devuelve
// los tickets existentes (no duplica).
const pool = createPool();

export async function finalizeOrder(ref, paymentId) {
  const client = await pool.connect();
  let result = { status: 'not_found' };
  let emailData = null; // se setea solo en la transición a aprobada (para no duplicar correos)
  try {
    await client.sql`BEGIN`;
    const { rows } = await client.sql`SELECT * FROM orders WHERE ref = ${ref} FOR UPDATE`;
    const order = rows[0];

    if (!order) {
      await client.sql`ROLLBACK`;
    } else if (order.status === 'approved') {
      // Ya confirmada antes → devolver tickets existentes (idempotente, sin reenviar email).
      const { rows: t } = await client.sql`SELECT number FROM tickets WHERE order_ref = ${ref} ORDER BY number`;
      await client.sql`COMMIT`;
      result = { status: 'approved', tickets: t.map(x => x.number), quantity: order.quantity };
    } else {
      // Verificar el pago realmente en Mercado Pago.
      const pay = paymentId ? await getPayment(paymentId) : null;
      const ok = pay
        && pay.status === 'approved'
        && String(pay.external_reference) === String(ref)
        && Math.round(Number(pay.transaction_amount)) === Number(order.amount);

      if (!ok) {
        await client.sql`ROLLBACK`;
        result = { status: order.status }; // sigue pendiente/rechazada
      } else {
        // Asigna números al azar entre los que quedan libres en el pool (no
        // secuenciales). FOR UPDATE SKIP LOCKED hace la reserva atómica y
        // segura ante pagos concurrentes, sin necesidad de un lock aparte:
        // si dos compras se aprueban al mismo tiempo, cada una toma números
        // distintos y ninguna espera a la otra.
        const { rows: t } = await client.sql`
          UPDATE tickets
          SET order_ref = ${ref}, created_at = now()
          WHERE number IN (
            SELECT number FROM tickets
            WHERE order_ref IS NULL
            ORDER BY random()
            LIMIT ${order.quantity}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING number`;

        if (t.length < order.quantity) {
          // No quedan suficientes números libres: no se puede completar esta
          // compra (no debería pasar salvo que el sorteo se agote de verdad).
          await client.sql`ROLLBACK`;
          result = { status: 'sold_out', quantity: order.quantity };
        } else {
          await client.sql`UPDATE orders SET status = 'approved', payment_id = ${String(paymentId)} WHERE ref = ${ref}`;
          await client.sql`COMMIT`;
          const tickets = t.map(x => x.number);
          result = { status: 'approved', tickets, quantity: order.quantity };
          emailData = { name: order.name, email: order.email, tickets, quantity: order.quantity };
        }
      }
    }
  } catch (e) {
    try { await client.sql`ROLLBACK`; } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  // Enviar el email FUERA de la transacción y solo en la transición (no bloquea la confirmación si falla).
  if (emailData) {
    try { await sendTicketEmail(emailData); }
    catch (e) { console.error('Error enviando email:', e); }
  }
  return result;
}

// ---- Email (Resend) ----
// Opcional: si no hay RESEND_API_KEY, simplemente no envía (no rompe el pago).
export async function sendTicketEmail({ name, email, tickets, quantity }) {
  if (!process.env.RESEND_API_KEY || !email) return;
  const from = process.env.MAIL_FROM || 'EDU Cycling <onboarding@resend.dev>';
  const nums = (tickets || []).map(n => String(n).padStart(6, '0'));
  const lista = nums.map(n => '<span style="display:inline-block;font-family:monospace;font-size:22px;letter-spacing:4px;color:#fff;background:#1B3A4B;border:1px solid #FF5C00;border-radius:8px;padding:10px 16px;margin:4px;">' + n + '</span>').join('');
  const plural = nums.length > 1 ? 's' : '';
  const html =
    '<div style="background:#0D2B38;color:#fff;font-family:Arial,Helvetica,sans-serif;padding:32px;border-radius:12px;max-width:560px;margin:auto;">' +
      '<h1 style="font-size:26px;margin:0 0 4px;font-style:italic;">EDU <span style="color:#FF5C00;">CYCLING</span></h1>' +
      '<p style="color:#FF5C00;font-weight:bold;letter-spacing:1px;margin:0 0 24px;">¡Pago confirmado!</p>' +
      '<p style="font-size:16px;line-height:1.6;">Hola ' + (name || '') + ', ya eres parte del <strong>Sorteo Tarmac SL7 105 Di2</strong>.</p>' +
      '<p style="font-size:14px;color:#bbb;margin-top:24px;">Tu' + plural + ' número' + plural + ' de ticket:</p>' +
      '<div style="margin:8px 0 24px;">' + lista + '</div>' +
      '<p style="font-size:14px;color:#bbb;line-height:1.6;">Guarda este correo: ' + (nums.length > 1 ? 'estos son tus pases' : 'este es tu pase') + ' al sorteo en vivo. El sorteo se transmite por Instagram y TikTok, con número ganador aleatorio y verificable.</p>' +
      '<p style="font-size:12px;color:#8AA3AD;margin-top:28px;">EDU Cycling · Cada número es un pedaleo más cerca de tu sueño.</p>' +
    '</div>';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: '🎟️ Tu' + plural + ' ticket' + plural + ' — Sorteo Tarmac SL7 EDU Cycling',
      html
    })
  });
  if (!r.ok) console.error('Resend respondió', r.status, await r.text());
}

// ---- Helpers HTTP ----
export function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + host;
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    return req.body;
  }
  return await new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
