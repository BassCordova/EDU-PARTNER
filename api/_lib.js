// ============================================================
// EDU PARTNER — utilidades compartidas del backend
// Base de datos (Vercel Postgres) + lógica de precios + confirmación
// de pagos con Mercado Pago (Checkout Pro).
// ============================================================
import { sql, createPool } from '@vercel/postgres';
import crypto from 'crypto';

export const TICKETS_TOTAL = 2000;
export const PRECIO_UNITARIO = 9990;
const PAQUETES = { 1: 9990, 5: 44950, 10: 84990 };

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
    order_ref   TEXT NOT NULL REFERENCES orders(ref),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  schemaReady = true;
}

// ---- Mercado Pago ----
export async function getPayment(paymentId) {
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(paymentId), {
    headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN }
  });
  if (!r.ok) return null;
  return r.json();
}

// ---- Confirmación de orden (idempotente y atómica) ----
// Verifica el pago con Mercado Pago, marca la orden como aprobada y asigna
// los números de ticket en una transacción. Si ya estaba aprobada, devuelve
// los tickets existentes (no duplica).
const pool = createPool();

export async function finalizeOrder(ref, paymentId) {
  const client = await pool.connect();
  try {
    await client.sql`BEGIN`;
    const { rows } = await client.sql`SELECT * FROM orders WHERE ref = ${ref} FOR UPDATE`;
    const order = rows[0];
    if (!order) { await client.sql`ROLLBACK`; return { status: 'not_found' }; }

    // Ya confirmada antes → devolver tickets existentes.
    if (order.status === 'approved') {
      const { rows: t } = await client.sql`SELECT number FROM tickets WHERE order_ref = ${ref} ORDER BY number`;
      await client.sql`COMMIT`;
      return { status: 'approved', tickets: t.map(x => x.number), quantity: order.quantity };
    }

    // Verificar el pago realmente en Mercado Pago.
    const pay = paymentId ? await getPayment(paymentId) : null;
    const ok = pay
      && pay.status === 'approved'
      && String(pay.external_reference) === String(ref)
      && Math.round(Number(pay.transaction_amount)) === Number(order.amount);

    if (!ok) {
      await client.sql`ROLLBACK`;
      return { status: order.status }; // sigue pendiente/rechazada
    }

    const { rows: t } = await client.sql`
      INSERT INTO tickets (order_ref)
      SELECT ${ref} FROM generate_series(1, ${order.quantity})
      RETURNING number`;
    await client.sql`UPDATE orders SET status = 'approved', payment_id = ${String(paymentId)} WHERE ref = ${ref}`;
    await client.sql`COMMIT`;
    return { status: 'approved', tickets: t.map(x => x.number), quantity: order.quantity };
  } catch (e) {
    try { await client.sql`ROLLBACK`; } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
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
