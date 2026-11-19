# Retirada de bono-gift-card: todo en pottery-gym

Estado: **preparación, PR en borrador**. No hay merge, ni despliegue, ni migraciones nuevas, ni cambios en Stripe, ni secretos, ni bonos reales. El PDF de muestra «PRUEBA RIO – no usar» se genera solo en local.

## Resumen para Erick (4–6 líneas)

Hoy la página de bonos (bono-gift-card) aún pinta el PDF y atiende a asistonto; pottery-gym ya guarda los bonos y recibe los pagos de Stripe. Este trabajo deja en pottery-gym el mismo PDF oficial (mismas fuentes, colores, dos páginas y el texto «1 clase») y las mismas funciones que usa asistonto, para no depender de aquella página. Cuando usted dé el OK, se publican los cambios, se apunta asistonto a pottery-gym, se comprueba con una compra o una prueba «PRUEBA RIO – no usar» (y se cancela) y, solo después, se apaga el webhook antiguo de Stripe y se retira o redirige bono-gift-card a /giftcards. Hasta ese OK no se toca el endpoint antiguo ni la web de bonos en producción.

## Auditoría de dependencias

### Lo que bono-gift-card usa de pottery-gym (ya ocurre hoy)

| Uso | Destino en pottery-gym |
| --- | --- |
| Alta/edición de bonos del diseñador y de la API del bot | Edge Function `bonos-write` (`action=create\|update\|cancel\|consume`) y RPC `external_create_gift_card_with_temporal_student` |
| Cola de pagos Stripe (lectura) | Tabla `public.gift_cards` (el pending de Vercel ya lee pottery-gym) |
| Sync del tipo modelado/torno | `bonos-write` (`type`) |

### Lo que pottery-gym (o asistonto a través de ella) aún usa de bono-gift-card

| Uso | En bono-gift-card hoy | En este PR (pottery-gym) |
| --- | --- | --- |
| PDF oficial (API / WhatsApp) | `lib/giftCardPdf.ts` + fuentes, `POST /api/gift-cards` y `GET /api/gift-cards/pending?code=` (`pdfBase64`) | Misma lib y assets en `supabase/functions/_shared/gift-card-pdf/`. UI `/giftcards` y diseñador; `GET stripe-giftcard-pending?code=`; `GET asistonto-read?op=bono_pdf&code=`; `pdfBase64` al hacer commit de W1 |
| Cola Stripe GET/POST `/api/gift-cards/pending` | Vercel, clave de bot (huella asistonto) | Ya existe `stripe-giftcard-pending`. Este PR rellena `pdfBase64` |
| Alta conversacional `POST /api/gift-cards` | Crea, devuelve PDF, `designerUrl` de bono-gift-card | **No es un alta libre.** El camino previsto es `asistonto-write` **W1** `bono.create` (borrador → OK de Erick → commit), que ya existe. El commit pasa a incluir `pdfBase64`. No se ha añadido un POST equivalente sin aprobación |
| Consulta `GET /api/gift-cards?code=` | Ficha + `pdfUrl` temporal (Storage de bono-gift-card) | `GET asistonto-read?op=bonos&code=` (ficha, sin contactos ni precio) y `op=bono_pdf&code=` para el PDF. No se porta el `pdfUrl` firmado de 24 h: asistonto debe usar `pdfBase64` |
| Webhook Stripe | `POST /api/stripe-webhook` (endpoint `we_1Ud9JlG3M5SYIufudAwaiQKb`) | Ya está `stripe-giftcard-webhook`. Este PR **no** desactiva el endpoint antiguo |
| UI pública del diseñador | `https://bono-gift-card.vercel.app` | Ya está en pottery-gym: `/giftcards` (iframe del diseñador en `/bonos-designer.html`), portado en el PR #12. El PDF de descarga pasa a ser el vectorial oficial, no una captura ni el A5 simplificado del formulario |

### Código de pottery-gym que citaba bono-gift-card

No había llamadas HTTP a `bono-gift-card.vercel.app` en la UI ni variables de entorno que apuntaran allí. Las menciones eran comentarios, notas de alumnos temporales, tests y el plan del webhook (PDF aún en Vercel). Este PR sustituye ese plan y deja el PDF en pottery-gym. No se ha cambiado el texto histórico de las notas de alumnos ya guardadas.

## Elección de diseño del PDF

**Un solo generador: la lib vectorial de bono-gift-card (pdf-lib + fuentes embebidas Montserrat y Cormorant Garamond + logo), portada tal cual.** Se ejecuta:

- en el navegador, para descargar desde el diseñador y desde el formulario de `/giftcards`;
- en las Edge Functions (Deno), para asistonto (`pdfBase64`).

No se usa html2canvas ni el PDF A5 simplificado del formulario: no coincidían con el PDF de la API (PR #7/#8). Un único código evita que la UI y WhatsApp diverjan.

Las Edge Functions son el sitio correcto para asistonto (no hay navegador). La UI importa el mismo módulo y los mismos ficheros de fuentes y logo, de modo que el binario pintado es el mismo. Se comparó un bono de muestra «PRUEBA RIO – no usar» (1 clase, no guardado en producción) generado con la lib original y con la de pottery-gym: las dos páginas, a 150 ppp, son **idénticas al píxel** (0 píxeles distintos). Imágenes en `/workspace/bono-pdf-compare/`.

## Nota de migración para asistonto

Base nueva: `https://ilkrcakrduibgsfqfzti.supabase.co/functions/v1`  
La antigua `https://bono-gift-card.vercel.app/api/...` se retira solo cuando asistonto ya esté apuntando aquí y se haya verificado.

Autenticación (igual que ahora, sin clave nueva):

- Cabecera `x-api-key: <clave>` o `Authorization: Bearer <clave>`.
- pottery-gym compara el SHA-256 con el secreto `ASISTONTO_KEY_SHA256` (la misma huella que ya está en `bono-gift-card/api/_lib/botKeyHashes.ts`, id `asistonto`).
- RIO aprueba W1 con `RIO_APPROVER_KEY_SHA256`.
- Las escrituras siguen apagadas hasta `ASISTONTO_WRITES_ENABLED=true`.
- Las claves en claro **no pasan por el chat**. Solo se pegan huellas SHA-256 en el panel de secretos de Supabase (o un script que las lea del almacén y las suba sin imprimirlas). La clave de asistonto que ya usa es la misma; no hace falta emitir otra.

| Antes (bono-gift-card) | Ahora (pottery-gym) | Cuerpo / campos |
| --- | --- | --- |
| `GET /api/gift-cards/pending` | `GET /stripe-giftcard-pending` | `{ ok, count, giftCards: [{ voucherCode, buyerName, recipientName, numberOfClasses, type, amount, giftFormat, ... }] }` — la lista no lleva PDF |
| `GET /api/gift-cards/pending?code=CR-…` | `GET /stripe-giftcard-pending?code=CR-…` | `{ ok, giftCard, fileName, pdfBase64 }` (solo bonos `source=stripe-webhook`) |
| `POST /api/gift-cards/pending` `{"voucherCodes":["CR-…"]}` | `POST /stripe-giftcard-pending` mismo cuerpo | `{ ok, acknowledged, notFound }` |
| `GET /api/gift-cards?code=CR-…` | `GET /asistonto-read?op=bonos&code=CR-…` para la ficha; `GET /asistonto-read?op=bono_pdf&code=CR-…` para el PDF | Ficha: id, code, recipient, numClasses, type, status, paymentStatus, expiryDate, … (sin comprador, contactos, precio ni metadatos). PDF: `{ ok, code, fileName, pdfBase64 }`. No hay `pdfUrl` |
| `POST /api/gift-cards` (alta inmediata + PDF) | `POST /asistonto-write` con el flujo W1, no un POST libre | 1) `{"op":"draft","kind":"bono.create","payload":{ recipient, numClasses, type?, validityMonths?, paymentStatus?, deliveryFormat?, price?, code?, buyer?, buyerEmail?, recipientEmail?, dedication?, activatedAt? }}`. 2) RIO: `{"op":"approve","draftId","approvalRef"}`. 3) `{"op":"commit","draftId"}` → `result.bono` + `fileName` + `pdfBase64` |

Mapeo breve de campos del alta: `recipientName` → `recipient`; `buyerName`/`donorName` → `buyer`; `numberOfClasses` → `numClasses`; `classType` → `type` (`modelado`\|`torno`); `sessionDuration` no es un campo de W1 (queda en el texto por defecto del PDF, 2,5 h, salvo que más adelante se guarde en metadatos); la dedicatoria del formulario se usa como `dedication` y, si no hay `cardData` de diseñador, el PDF la pone en la cita.

## Plan de retirada (un OK de Erick en cada paso)

1. **Publicar este PR en pottery-gym** (merge + desplegar `stripe-giftcard-pending`, `asistonto-read` y `asistonto-write`, sin tocar secretos salvo que falte alguna huella ya prevista). Verificar: PDF de descarga en `/giftcards`, `pending` sin clave → 401, `bono_pdf` sin clave → 401, unsigned webhook → 400. **OK.**
2. **Cambiar asistonto** a las URLs nuevas (tabla de arriba). La página de bonos y el endpoint antiguo de Stripe siguen activos como red de seguridad. **OK.**
3. **Comprobar** con una compra real de gift card o, si lo autoriza, un bono «PRUEBA RIO – no usar» (W1 o compra) y cancelarlo después. Verificar bono en pottery-gym, cola, PDF idéntico, sin duplicados. **OK.**
4. **Desactivar** en Stripe el endpoint antiguo `we_1Ud9JlG3M5SYIufudAwaiQKb` (no borrarlo al momento). Dejar activo el nuevo hacia `stripe-giftcard-webhook`. No tocar Payment Links ni precios. **OK.**
5. **Retirar bono-gift-card**: en Vercel, el proyecto `bono-gift-card` (y su dominio `bono-gift-card.vercel.app`): redirigir a la app pottery-gym `/giftcards`, o archivar el proyecto. Quitar el código del webhook y de `/api/gift-cards` cuando ya nadie lo llame. Variables de Vercel (`STRIPE_WEBHOOK_SECRET`, `GIFT_CARD_BOT_API_KEY`, `SUPABASE_*` de ese proyecto) se pueden borrar al archivar. **OK.**

Ítems de Vercel/Stripe implicados: proyecto Vercel `bono-gift-card`; app `pottery-gym-app` (auto-deploy desde `main`); secretos de Edge Functions en el proyecto Supabase `ilkrcakrduibgsfqfzti`; Stripe live `acct_1OlRUVG3M5SYIufu`, endpoint antiguo `we_1Ud9JlG3M5SYIufudAwaiQKb` y el endpoint nuevo hacia pottery-gym (sin tocarlo en esta preparación).
