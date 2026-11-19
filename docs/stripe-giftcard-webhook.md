# Webhook de Stripe de gift cards en pottery-gym

Estado: **borrador, no desplegado**. No hay migración aplicada en `ilkrcakrduibgsfqfzti`, ni funciones
desplegadas, ni secretos nuevos, ni cambios en Stripe. Nada de esto se publica, se apunta ni se activa
sin el OK literal de Erick en el chat de RIO.

## Resumen para Erick (sin jerga)

Hoy, cuando alguien compra una tarjeta regalo en la web, Stripe avisa a la página de bonos y esa página
anota el pago en pottery-gym. Usted ha pedido que el aviso llegue directo a pottery-gym, que es donde
ya se guardan los bonos.

He preparado el cambio en un borrador, sin publicarlo y sin tocar Stripe. El plan seguro es este: primero
se instala la recepción nueva *junto* a la actual (las dos pueden convivir: un mismo pago nunca crea dos
bonos). Se comprueba que la nueva funciona. Solo entonces se apaga la antigua. Así no se pierde ningún
pago ni se duplica ninguno. El PDF y la consulta que hace asistonto cada 5 minutos pueden seguir en la
página de bonos hasta un último paso, porque ya leen lo que hay en pottery-gym.

Hace falta su OK en estos momentos: 1) publicar el código y la migración en pottery-gym; 2) guardar los
secretos de Stripe en Supabase y crear el endpoint nuevo (sin apagar el actual); 3) apagar el endpoint
antiguo cuando la nueva vía esté comprobada; 4) más adelante, retirar el código viejo de la página de
bonos y, si procede, mover también la cola/PDF de asistonto.

## Por qué una Edge Function de Supabase (opción A), no una ruta en Vercel (opción B)

La app `pottery-gym-app` en Vercel es una página (SPA): `vercel.json` reescribe todas las rutas a
`index.html` y no hay API. El bono, la idempotencia (`gift_cards.code` único) y la cola
(`external_metadata.source = stripe-webhook`) ya viven en el proyecto Supabase `ilkrcakrduibgsfqfzti`,
junto a `bonos-write`, `asistonto-read` y `asistonto-write`.

Una Edge Function `stripe-giftcard-webhook` recibe a Stripe en el mismo sitio donde se crea el bono
(RPC `external_create_gift_card_with_temporal_student`), sin un salto extra ni claves de `bonos-write`.
Los secretos se guardan en Supabase (Secrets de Edge Functions), no en Vercel de pottery-gym-app.

## Piezas (solo en esta rama)

| Pieza | Archivo |
| --- | --- |
| Núcleo (firma, filtro, tipo, código, alta, cola, aviso) | `supabase/functions/_shared/stripe-giftcard.ts` |
| Recepción de Stripe | `supabase/functions/stripe-giftcard-webhook/index.ts` |
| Cola para asistonto (equivalente a `/api/gift-cards/pending`) | `supabase/functions/stripe-giftcard-pending/index.ts` |
| `verify_jwt = false` (la auth es la firma de Stripe o la huella de asistonto) | `supabase/config.toml` |
| Índice único por `stripeSessionId` (no aplicado) | `supabase/migrations/20261119102000_gift_cards_stripe_session_unique.sql` |
| Pruebas unitarias | `tests/stripe-giftcard-webhook.test.mjs` |

## Comportamiento (igual que el webhook actual de bono-gift-card)

1. Verifica `Stripe-Signature` con `STRIPE_WEBHOOK_SECRET` (cuerpo crudo, 5 min). Firma mala → **400**. Sin secreto → **503**.
2. Solo `checkout.session.completed` y `checkout.session.async_payment_succeeded`. El resto → 200 `ignored`.
3. Es gift card si: metadata `source=casa_rosier_web`, `gift_format` virtual\|physical, `classes` 1–4, y el Payment Link está en la lista de 8 (o `STRIPE_GIFT_CARD_PAYMENT_LINKS`). Si no → 200 `ignored` (el curso de 50 € y el bono de 100 € no se tocan).
4. Si hay `STRIPE_SECRET_KEY`, relee la sesión en Stripe. Solo continúa si `payment_status = paid`.
5. Crea el bono en la sede configurada (`ASISTONTO_SEDE_ID` o `BONOS_API_SEDE_ID`):
   - código determinista `CR-<ddmmaa>-<iniciales>-<iniciales>-<4 del hash de la sesión>` (el mismo que ahora);
   - tipo `modelado` o `torno` (`metadata.type` o `class_type`; si falta, `modelado` y `typeDefaulted: true`);
   - importe (`price`), comprador, destinatario, teléfono/email internos, dedicatoria, formato digital/físico, 12 meses, 2 h.
6. Idempotencia: busca primero por `stripeSessionId`; el alta choca con el índice único de `code` (y, cuando se aplique la migración, también con el de sesión). Un reintento o el webhook antiguo → 200 `duplicate`, sin segundo bono.
7. Aviso opcional a asistonto (HMAC, igual que ahora). Si falla, el bono no se toca y queda en la cola.
8. Cola `GET/POST /functions/v1/stripe-giftcard-pending`, con la misma clave de asistonto (`x-api-key` / Bearer, huella `ASISTONTO_KEY_SHA256`). Misma forma de respuesta que `/api/gift-cards/pending`. `GET ?code=` genera el PDF oficial en `pdfBase64` (misma lib, fuentes y diseño que bono-gift-card). Cualquier bono (diseñador, formulario, W1 o Stripe) también puede pedirse con `GET /functions/v1/asistonto-read?op=bono_pdf&code=`.

## Plan de corte (sin dobles ni pagos perdidos)

Los dos webhooks pueden convivir: usan el mismo código y el mismo `stripeSessionId`. El primero crea el bono; el segundo responde `duplicate`. **No se apaga el actual hasta comprobar el nuevo.** **No se cambian Payment Links ni presupuestos.**

Cada endpoint de Stripe tiene su propio secreto de firma: el nuevo **no** reutiliza el `STRIPE_WEBHOOK_SECRET` de Vercel (bono-gift-card).

| # | Paso | ¿OK de Erick? |
| --- | --- | --- |
| 0 | Este PR queda en borrador. Nada se fusiona ni se despliega. | — (ya es preparación) |
| 1 | Fusionar este PR en `main` de pottery-gym (no publica el webhook hacia Stripe todavía: sin secreto la función responde 503). Aplicar la migración del índice único en `ilkrcakrduibgsfqfzti` (recomendado **antes** de que las dos vías convivan). Desplegar las dos Edge Functions. | **Sí** (producción: merge, migración, deploy) |
| 2 | En el panel de Stripe (cuenta live, **sin desactivar** el endpoint actual `we_1Ud9JlG3M5SYIufudAwaiQKb`): crear un endpoint **nuevo** hacia `https://ilkrcakrduibgsfqfzti.supabase.co/functions/v1/stripe-giftcard-webhook`, eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`. Copiar el secreto de firma **nuevo** en Supabase → Edge Function Secrets → `STRIPE_WEBHOOK_SECRET`. Opcional: la misma clave restringida de solo lectura de Checkout Sessions (`STRIPE_SECRET_KEY`). La sede y `SUPABASE_*` ya las inyecta/tiene el proyecto. `ASISTONTO_NOTIFY_*` solo si se quiere el aviso inmediato (hoy la cola se consulta cada 5 min). | **Sí** (crear endpoint y guardar secretos; no se apaga el viejo) |
| 3 | Comprobar, sin crear un bono de prueba real si no lo autoriza: `POST` sin firma → 400; evento de prueba genérico de Stripe → 200 `ignored` (firma bien, no es gift card). Opcional, con su OK: reenviar un `checkout.session.completed` ya pagado (debe dar `duplicate` si ese pago ya tiene bono, o `created` si no). Asistonto sigue viendo la cola en la página de bonos, porque lee pottery-gym. | Comprobación; un bono real de prueba solo con **OK** explícito |
| 4 | Cuando el nuevo endpoint haya respondido bien a un pago real (o a un reenvío), **deshabilitar** (no borrar todavía) el endpoint antiguo en Stripe. Los reintentos de Stripe irán al nuevo. La página de bonos deja de recibir avisos; la cola y el PDF siguen sirviendo desde ahí. | **Sí** (apagar el viejo) |
| 5 | Observar unos días (pagos web → bono en pottery-gym, cola, sin duplicados). Luego, con OK: retirar el código del webhook en bono-gift-card, borrar el endpoint antiguo en Stripe y, cuando asistonto apunte a `stripe-giftcard-pending`, retirar `/api/gift-cards/pending`. El PDF bajo demanda se podrá portar en un paso posterior. | **Sí** (retirada) |

### Secretos a configurar (solo nombres; los valores no se pegan en el chat ni pasan por un agente)

En **Supabase** (Edge Function Secrets del proyecto `ilkrcakrduibgsfqfzti`), cuando toque el paso 2:

- `STRIPE_WEBHOOK_SECRET` — secreto de firma `whsec_...` del **nuevo** endpoint (obligatorio para salir del 503).
- `STRIPE_SECRET_KEY` — clave restringida, solo lectura de Checkout Sessions (recomendada).
- `STRIPE_GIFT_CARD_PAYMENT_LINKS` — opcional; si falta, se usan los 8 enlaces actuales.
- `ASISTONTO_NOTIFY_WEBHOOK_URL` y `ASISTONTO_NOTIFY_SECRET` — solo para el aviso inmediato (https + HMAC).
- Ya existentes y reutilizadas: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ASISTONTO_SEDE_ID` o `BONOS_API_SEDE_ID`, `ASISTONTO_KEY_SHA256` (cola pendiente).

En **Vercel** (bono-gift-card) no se cambia ninguna variable en esta preparación. El `STRIPE_WEBHOOK_SECRET` antiguo se deja hasta el paso 4–5.

Quién genera cada secreto lo pega directamente en el campo del panel, nunca en un chat.

## Riesgos

- Si se apagara el endpoint antiguo **antes** de comprobar el nuevo, un fallo de configuración podría dejar pagos sin bono (Stripe reintenta 3 días, pero no hay que llegar ahí). Por eso el corte es “convivir → comprobar → apagar”.
- Si no se aplicara el índice único de sesión, la convivencia seguiría protegida por el código determinista y el índice único de `code`. El índice de sesión es una red de seguridad extra (por si el algoritmo del código cambiara).
- El PDF aún no se genera en pottery-gym. Hasta el paso 5, asistonto obtiene el PDF como ahora. La lista pendiente nueva ya incluye el tipo, el importe, comprador y destinatario.
- El aviso inmediato a asistonto sigue siendo opcional y hoy no está activo; la consulta cada 5 minutos no se interrumpe.
- No se tocan Payment Links ni campañas. El filtro de gift card es el mismo: el resto de pagos de Stripe se ignoran.

## Pruebas

`node --test tests/stripe-giftcard-webhook.test.mjs`: firma, filtro, código determinista, tipo modelado/torno, alta, duplicado por sesión, ignorados, 422, aviso fallido sin deshacer el bono, cola y acuse.
