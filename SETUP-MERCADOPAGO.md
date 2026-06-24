# Dejar EduPartner cobrando con Mercado Pago

La página ya tiene todo el código de pagos listo (Checkout Pro + base de datos).
Solo faltan **3 cosas que se configuran una vez** en Vercel y Mercado Pago.
No hay que tocar código.

---

## 1. Conectar la base de datos (Vercel Postgres)

1. Entra a tu proyecto en **vercel.com → pestaña _Storage_**.
2. **Create Database → Postgres** (Neon). Acepta el nombre por defecto.
3. En _Connect Project_, conéctala a este proyecto en **Production** (y Preview).

Listo: Vercel inyecta solo las variables `POSTGRES_URL`… No tienes que copiar nada.
Las tablas se crean solas la primera vez que entra un pago.

---

## 2. Sacar el Access Token de Mercado Pago

1. Entra a **https://www.mercadopago.cl/developers/panel/app** con tu cuenta.
2. **Crear aplicación**:
   - Nombre: `EduPartner`
   - Producto: **Pagos online → Checkout Pro**
3. Entra a la aplicación → menú **Credenciales**.
4. Verás dos juegos de credenciales:
   - **Credenciales de prueba** → para testear sin plata real.
   - **Credenciales de producción** → para cobrar de verdad (puede pedir
     completar datos de tu cuenta/comercio antes de habilitarse).
5. Copia el **Access Token** (el campo largo que empieza con `TEST-…` en prueba
   o `APP_USR-…` en producción). **Ese es el único dato que necesito.**

> 🔒 El Access Token es secreto: NO lo pegues en el chat ni en el código.
> Va directo en Vercel (siguiente paso).

---

## 3. Cargar las variables en Vercel

En **vercel.com → tu proyecto → Settings → Environment Variables**, agrega:

| Nombre | Valor | Entorno |
|---|---|---|
| `MP_ACCESS_TOKEN` | el Access Token de Mercado Pago | Production (y Preview para testear) |
| `ADMIN_KEY` | una clave larga inventada por ti (para ver participantes) | Production |

Guarda y haz **Redeploy** (Deployments → … → Redeploy) para que tome las variables.

---

## ¡Listo! Cómo queda funcionando

- El comprador llena el formulario → **Confirmar y Pagar** → se va a Mercado Pago.
- Paga con tarjeta, débito, transferencia o saldo MP.
- Vuelve a la página y ve su **número de ticket** real en pantalla.
- El ticket queda guardado en la base de datos (y Mercado Pago te abona la plata).

### Probar antes de cobrar de verdad
Usa el **Access Token de _prueba_** y las
[tarjetas de prueba de Mercado Pago](https://www.mercadopago.cl/developers/es/docs/checkout-pro/additional-content/test-cards).
Cuando todo funcione, cambia `MP_ACCESS_TOKEN` por el de **producción** y Redeploy.

### Ver la lista de participantes (para el sorteo)
Entra a:
```
https://TU-DOMINIO/api/admin?key=TU_ADMIN_KEY
```
Te muestra cada comprador con sus números de ticket y el total vendido.

---

## Qué se construyó (resumen técnico)

```
/api/create-preference   → crea el pago en Mercado Pago y redirige
/api/webhook             → recibe la confirmación de MP y asigna tickets
/api/order               → consulta estado + números de ticket (pantalla de éxito)
/api/admin               → lista de participantes (protegida con ADMIN_KEY)
/api/_lib.js             → base de datos, precios y verificación de pagos
```

- El **monto siempre se calcula en el servidor** (no se confía en el navegador).
- La asignación de números es **atómica e idempotente**: no hay duplicados ni
  doble cobro aunque el webhook llegue dos veces.
- Precios: 1 = $9.990 · 5 = $44.950 · 10 = $84.990 · otras cantidades = $9.990 c/u.
  (Se editan en `api/_lib.js`, constante `PAQUETES`.)
