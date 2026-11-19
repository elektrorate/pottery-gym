# API de asistonto (lectura y escritura con aprobación)

Estado: **borrador, no desplegado**. No hay migración aplicada en `ilkrcakrduibgsfqfzti`, ni funciones
desplegadas, ni secretos configurados. Nada de esto se publica sin el OK literal de Erick en el chat de RIO.

## Piezas

| Pieza | Archivo |
| --- | --- |
| Migración (tablas privadas, RPC, ajuste de actor de integración) | `supabase/migrations/20261118210000_asistonto_api.sql` |
| Núcleo compartido (auth por huella, límites, mapeo de errores) | `supabase/functions/_shared/asistonto-api.ts` |
| Edge Function de lectura (solo GET) | `supabase/functions/asistonto-read/index.ts` |
| Edge Function de escritura (solo POST) | `supabase/functions/asistonto-write/index.ts` |
| `verify_jwt = false` (la auth es la huella de la clave) | `supabase/config.toml` |
| Pruebas SQL + HTTP (BD desechable, semilla sintética) | `supabase/tests/run-asistonto-api.mjs`, `supabase/tests/asistonto_api.fixture.psql` |
| Pruebas unitarias del handler | `tests/asistonto-api.test.mjs` |

## Autenticación

- Cabecera `Authorization: Bearer <clave>` o `x-api-key: <clave>` (32–256 caracteres).
- La función calcula SHA-256 de la clave y la compara (tiempo constante) con:
  - `ASISTONTO_KEY_SHA256`: huella(s) de asistonto (lista separada por comas). Es la misma huella que ya
    figura en bono-gift-card (`api/_lib/botKeyHashes.ts`, id `asistonto`), así que no hace falta clave nueva.
  - `RIO_APPROVER_KEY_SHA256`: huella de la clave que RIO genera para sí mismo.
- Una clave que coincida con ambas listas se rechaza. Sin clave válida: **401**.
- `service_role` nunca sale de Supabase: la función solo llama a `public.asistonto_read` y
  `public.asistonto_write`, ejecutables únicamente por `service_role` (ni `anon` ni `authenticated`).
- Sin cabeceras CORS (API servidor a servidor) y `Cache-Control: no-store`.

## Lecturas — `GET /functions/v1/asistonto-read?op=…`

Todas filtran por la sede configurada (`ASISTONTO_SEDE_ID`, o `BONOS_API_SEDE_ID` si no existe).
Parámetros no listados: **400**. Ningún campo de contacto, notas, comprador, metadatos, precio ni fecha de nacimiento.

| op | Parámetros | Devuelve |
| --- | --- | --- |
| `bonos` | `code`, `status`, `limit` (1–100, por defecto 50) | id, code, recipient, recipientStudentId, numClasses, sessionsUsed, sessionsRemaining, type, status, paymentStatus, validityMonths, activatedAt, expiryDate, deliveryFormat, createdAt. Sin `status` se excluyen los cancelados. `code` inexistente: 404 |
| `calendario` | `from` (obligatorio), `to` (máx. 31 días) | por sesión: id, date/start/end (hora de Madrid), classType, audience, workshopName, capacity, reserved, available, teacher (nombre), completed, blocks (activityType, capacity, reserved). Sin nombres de alumnos |
| `clases` | — | activityTypes, weeklySchedule, exceptions (próximos 90 días), capacityDefaults |
| `alumnos` | `q` (3–80 caracteres) | hasta 20: id, name, category, status, archived, membershipTier, paymentStatus, classesRemaining |
| `alumno` | `id` | lo anterior + upcomingSessions (10) + bonos activos/pendientes (code, status, sessionsRemaining, expiryDate) |
| `bono_pdf` | `code` (obligatorio) | `ok`, `code`, `fileName`, `pdfBase64` (PDF oficial de dos páginas, mismas fuentes y diseño que bono-gift-card). 400 sin código, 404 si no existe en la sede. No devuelve metadatos ni contactos, solo el PDF |

## Escrituras — `POST /functions/v1/asistonto-write`

Desactivadas salvo `ASISTONTO_WRITES_ENABLED=true` (si no: **403** sin tocar la BD). Cuerpo JSON ≤ 8 KB.

1. `{"op":"draft","kind":…,"payload":{…}}` — solo asistonto. Valida sin escribir datos de negocio,
   guarda el borrador (caduca a las 24 h) y devuelve `draftId` y un `summary` legible. **201**.
2. RIO muestra el `summary` a Erick en el chat de RIO. Con su OK literal:
   `{"op":"approve","draftId":…,"approvalRef":"<id del mensaje de Erick>"}` — solo RIO.
3. `{"op":"commit","draftId":…}` — asistonto o RIO. Exige borrador aprobado y no caducado
   (si no: 403 / 410). Se ejecuta una sola vez; repetirlo devuelve el mismo resultado con `replayed: true`.
4. Otros: `{"op":"discard","draftId":…}`, `{"op":"list","status":"pending|approved|committed|discarded"}`.

| kind | payload | Ejecución en commit |
| --- | --- | --- |
| `bono.create` (W1) | recipient*, numClasses* (1–20), type (modelado/torno), validityMonths (3/6/8/12, def. 12), paymentStatus (pending/paid), deliveryFormat, price, code, buyer, buyerEmail, buyerPhone, recipientEmail, recipientPhone, dedication, activatedAt | `external_create_gift_card_with_temporal_student` (misma ruta que bonos-write; `buyerPhone` va a `gift_cards.buyer_phone` y `recipientPhone` al teléfono del alumno temporal, igual que en bonos-write), `external_reference = asistonto:<draftId>`, `approval_ref` en metadatos. Tras el commit, la Edge Function añade `fileName` y `pdfBase64` (mismo PDF oficial) en la raíz de la respuesta (junto a `data` y `replayed`) y también dentro de `data`. El código se lee de `data.result.bono.code` (forma real del RPC); un `commit` repetido (`replayed: true`) vuelve a adjuntar el PDF sin crear otro bono |
| `student.create` (W2) | name*, surname, email, phone | alumno **temporal** en la sede (las membresías se siguen dando de alta en la app) |
| `session.book` (W3) | sessionId*, studentId*, giftCardCode | `private.save_session_reservation` existente (aforo, financiación y reglas de negocio sin duplicar). Sesiones `mixto`: 409, se editan en la app |
| `session.cancel` (W3) | sessionId*, studentId*, reason | `private.session_business_action('cancel_session_reservation')` existente; el motivo incluye el `approvalRef` |

Errores: 400 validación, 403 permiso/actor, 404 no existe (o es de otra sede), 409 conflicto
(aforo, código repetido, revisión obsoleta), 410 borrador caducado, 500 sin detalles internos.

## Actor de integración (solo para W3)

Las RPC de sesiones exigen un `auth.uid()` atribuible. El commit de W3 usa un usuario de Auth dedicado
(«Asistonto (integración)») que **no** es propietario ni miembro de ninguna sede ni super_admin; si lo fuera,
el commit se rechaza (403). Fuera de una transacción de commit ese usuario no tiene ningún acceso.
`private.session_employee_sede` y `private.lock_atomic_session` aceptan además una marca
`private.asistonto_actor_context` (pid + transacción) que solo escribe el commit y borra al terminar.
`private.can_access_sede` y el RLS de la app **no** cambian.

Aprovisionamiento (lo hace el titular de la BD desde el panel de Supabase, tras el OK de Erick):
1. Crear el usuario de Auth sin contraseña utilizable (p. ej. `asistonto-actor@…`, invitación sin aceptar).
2. `insert into private.asistonto_integration_actor (sede_id, user_id, enabled) values ('<sede>', '<uid>', true);`
Sin este paso, W3 responde 409 y W1/W2 siguen funcionando.

## Secretos y configuración (quién y cómo)

| Variable | Dónde | Quién | Notas |
| --- | --- | --- | --- |
| `ASISTONTO_KEY_SHA256` | Supabase → Edge Functions → Secrets | RIO, pegándola en el navegador | huella ya publicada en bono-gift-card; no es secreta |
| `RIO_APPROVER_KEY_SHA256` | igual | RIO | RIO genera su clave y solo pega la huella |
| `ASISTONTO_WRITES_ENABLED` | igual | RIO con OK de Erick | `false` hasta terminar las pruebas de lectura |
| `ASISTONTO_SEDE_ID` (opcional) | igual | RIO | si falta se usa `BONOS_API_SEDE_ID` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | inyectadas por Supabase | — | nunca salen de Supabase |

Ninguna clave en claro pasa por chats ni agentes. Configuración incompleta: 503 con el nombre de la variable.

## Auditoría

`private.asistonto_audit` es de solo inserción (triggers bloquean UPDATE/DELETE/TRUNCATE) y guarda actor,
operación, draftId, kind, approvalRef y solo identificadores (ids, códigos), nunca nombres ni contactos.
Los logs de las funciones solo registran `{fn, actor, op, status}`.

## Pruebas

```bash
npm run test:unit            # incluye tests/asistonto-api.test.mjs
npm run test:sql:asistonto   # BD desechable postgres:17 sin red + migraciones + semilla sintética local-staging
```

## Despliegue (solo con el OK literal de Erick, en este orden)

1. Merge del PR → aplicar la migración en `ilkrcakrduibgsfqfzti` (con copia de seguridad previa).
2. Desplegar `asistonto-read` y `asistonto-write` con `verify_jwt = false`.
3. Secretos: huellas + `ASISTONTO_WRITES_ENABLED=false`. Probar solo lecturas.
4. Con nuevo OK: `ASISTONTO_WRITES_ENABLED=true`; una única prueba W1 con «PRUEBA RIO – no usar» y cancelarla después.
   W2 y W3 se prueban solo en staging local.
