# Dejar EDU Cycling cobrando con Mercado Pago

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
   - Nombre: `EDU Cycling`
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

También existe un panel visual completo en `https://TU-DOMINIO/admin.html`
(pide la misma `ADMIN_KEY`), con órdenes, estado de envío de correo, ingresos
totales y un botón para reenviar el correo de confirmación por orden.

---

---

## Email de confirmación (Resend)

Cuando un pago se aprueba, el comprador recibe su número de ticket por correo.

1. Crea una cuenta gratis en **https://resend.com**.
2. **API Keys → Create API Key** → copia la clave (empieza con `re_…`).
3. En Vercel → Environment Variables, agrega:
   - `RESEND_API_KEY` = la clave `re_…`
4. **Para enviar desde tu dominio** (`sorteos@edupartner.cl`):
   - En Resend → **Domains → Add Domain** → `edupartner.cl`.
   - Te da unos registros DNS (DKIM/SPF) → agrégalos en NIC Chile.
   - Cuando Resend lo marque verificado, agrega en Vercel:
     `MAIL_FROM` = `EDU Cycling <sorteos@edupartner.cl>`
5. Redeploy.

> Mientras verificas el dominio, si dejas `MAIL_FROM` vacío usa el remitente de
> prueba de Resend (`onboarding@resend.dev`), que **solo envía a tu propio correo**.
> Sirve para probar, pero para enviar a los compradores reales necesitas el dominio verificado.

Si algún comprador no recibió el correo (falla puntual de envío), puedes
reenviarlo sin tocar la base de datos desde el panel `/admin.html` (botón
"Reenviar correo" en cada orden aprobada), o directo por URL:
```
https://TU-DOMINIO/api/admin-resend-email?key=TU_ADMIN_KEY&ref=REF_DE_LA_ORDEN
```

---

## Limpiar los datos de prueba (antes de lanzar)

Para borrar las compras de prueba y que la numeración vuelva a `000001`, abre en el navegador:

```
https://TU-DOMINIO/api/admin?key=TU_ADMIN_KEY&action=reset&confirm=BORRAR
```

Hazlo **una vez, justo antes de salir a producción**. Después de eso, el primer
comprador real recibe el ticket 000001.

---

## Pasar a PRODUCCIÓN (cobrar de verdad)

1. Tu cuenta de Mercado Pago debe estar **habilitada para producción** (completar
   datos del negocio/cuenta si te lo pide).
2. En **Developers → tu app → Credenciales → "Credenciales de producción"**,
   copia el **Access Token de producción**.
3. En Vercel, reemplaza `MP_ACCESS_TOKEN` por el de producción. (El código detecta
   solo que ya no es de prueba y enruta a pagos reales.)
4. Asegúrate de tener `PUBLIC_BASE_URL = https://edupartner.cl`.
5. **Redeploy.**
6. Haz **una compra real chica** para verificar de punta a punta (te llega la plata
   a tu cuenta de Mercado Pago y el email al comprador).
7. **Limpia los datos** una última vez con el enlace de reset de arriba.

> Orden recomendado: deja primero todo probado con credenciales de **prueba**.
> El cambio a producción es el último paso del lanzamiento.

También registra el webhook en **Mercado Pago → Developers → tu app → Webhooks**
(sección aparte de la URL de notificación dinámica que ya manda el código):
agrega `https://edupartner.cl/api/webhook` para el evento **Pagos**. Esto es
la vía principal para confirmar pagos; el cron de reconciliación (ver abajo)
es el respaldo si esa notificación no llega.

---

## Reconciliación automática (respaldo si el webhook no llega)

Además del webhook, hay un cron job (`/api/cron-reconcile`, **una vez al día**,
configurado en `vercel.json`) que revisa las órdenes que quedaron en
`pending` por más de 5 minutos, busca el pago directo en Mercado Pago por
`external_reference` y, si está aprobado, confirma la orden igual que lo
haría el webhook. Las que llevan más de 24 horas sin pagarse se marcan como
`expired` para no ensuciar el panel. No requiere configuración: funciona
apenas se despliega. Vercel lo muestra en **Settings → Cron Jobs**.

> El plan **Hobby** de Vercel solo permite cron jobs con frecuencia diaria —
> una frecuencia menor (ej. cada 10 minutos) hace que Vercel **rechace el
> deployment completo** antes de crearlo (ni siquiera aparece como fallido
> en la lista de Deployments). Si más adelante se sube a un plan de pago y
> se quiere una reconciliación más frecuente, se puede ajustar el `schedule`
> en `vercel.json` (ej. `*/10 * * * *`).

### Variables opcionales (endurecen la plataforma, no son obligatorias)

| Nombre | Para qué sirve | Si no la configuras |
|---|---|---|
| `CRON_SECRET` | Exige que solo el scheduler de Vercel pueda llamar `/api/cron-reconcile` | El endpoint sigue funcionando igual, sin ese candado extra |
| `MP_WEBHOOK_SECRET` | Verifica la firma que manda Mercado Pago en cada webhook (Developers → tu app → Webhooks → "Firma secreta") | El webhook sigue funcionando igual; cada pago de todas formas se re-verifica contra la API real de Mercado Pago antes de emitir tickets |

---

## Qué se construyó (resumen técnico)

```
/api/create-preference   → crea el pago en Mercado Pago y redirige
/api/webhook             → recibe la confirmación de MP y asigna tickets
/api/cron-reconcile      → respaldo automático si el webhook no llega (diario)
/api/order               → consulta estado + números de ticket (pantalla de éxito)
/api/admin               → lista de participantes en JSON (protegida con ADMIN_KEY)
/api/admin-resend-email  → reenvía el correo de confirmación de una orden
/api/_lib.js             → base de datos, precios y verificación de pagos
admin.html               → panel visual (centro de control) del sorteo
```

- El **monto siempre se calcula en el servidor** (no se confía en el navegador).
- El **RUT también se valida en el servidor** (dígito verificador), no solo en el navegador.
- La asignación de números es **atómica, aleatoria e idempotente**: no hay
  duplicados ni doble cobro aunque el webhook llegue dos veces.
- Precios: 1 = $3.000 · 2 = $5.000 · 5 = $10.000 · otras cantidades = $3.000 c/u.
  (Se editan en `api/_lib.js`, constante `PAQUETES`, y en el JS de `index.html`.)
