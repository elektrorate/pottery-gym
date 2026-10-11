# Auditoría de alumnos y preparación para agentes

**Conclusión:** primero hay que separar identidad, membresía, pago y archivo, y reparar las invariantes de bonos. Después corresponde un piloto API de solo lectura con datos mínimos. MCP es un adaptador opcional posterior, no una solución a los defectos del dominio.

- Fecha del informe: **2026-10-11**. Baseline: **`c90a502`**, rama `feat/agent-readiness`.
- Estado al emitirlo: **sin correcciones implementadas; producción intacta**.
- Alcance: revisión estática del repositorio y evidencia previa de catálogo; no se leyeron filas de negocio ni se ejecutaron operaciones de base de datos para este informe.
- Fuera de alcance: nuevo subsistema de facturación, fusión automática de duplicados históricos, despliegues y reparación automática del historial remoto.

## 1. Cómo interpretar la evidencia

| Etiqueta | Significado y límite |
|---|---|
| **CATÁLOGO PREVIO** | Observación de estructura desplegada aportada por la auditoría anterior; no es una consulta ejecutada por quien redacta este informe. |
| **ESTÁTICO** | Comportamiento o definición verificada en archivos de este baseline; no prueba por sí sola el contenido de producción. |
| **RECOMENDACIÓN** | Cambio propuesto o prueba pendiente, no comportamiento ya disponible. |

**CATÁLOGO PREVIO:** proyecto `ilkrcakrduibgsfqfzti`, CLI Supabase `2.111.0`. El historial local contiene `20261010180407` y el remoto `20261010180826`: no deben tratarse como una misma migración sin reconciliación explícita.
La columna `recipient_student_id` y el trigger de enlace existen en vivo, aunque su creación está en `legacy-migrations` del repositorio. La función de ciclo de vida coincide con el SQL fuente y la vista usa `security_invoker=true`.
También se observaron el índice único de canje, las funciones de reversión/consumo, permisos del ledger y el CHECK de vigencia descritos abajo. Esto confirma definiciones, **no cantidad de afectados ni incidentes reales**.

**ESTÁTICO:** las migraciones actuales alteran tablas preexistentes y no contienen el esquema base completo. No se ejecutó ni se acreditó un reset local o remoto exitoso.

## 2. Persistencia y derivación actuales

| Dimensión | Persistencia y consumidor actual |
|---|---|
| Identidad | `students.id`, `sede_id`, nombre y contactos; los bonos enlazan mediante `gift_cards.recipient_student_id`. |
| Categoría | `student_category`; la aplicación distingue `membresia` y `temporal`, mientras el trigger contempla también `grupo_temporal` y `grupal`. |
| Membresía | `membership_tier`, `membership_activated_at`, `expiry_date`, `bonos_asignados`, `classes_remaining` y renovación mensual. |
| Pago | `payment_status` explícito; `NULL` conserva desconocimiento legado. La derivación interpreta `status` legado `membresia`/`active` como pagado. |
| Archivo administrativo | `archived_at`, escrito al archivar manualmente; renovación y ciertas ediciones pueden vaciarlo. |
| Estado visible | Derivado en TypeScript y en SQL; no equivale simplemente al campo persistido `status`. |
| Bono y consumo | `gift_cards.status`, `sessions_used`, `consumed_at`; `gift_card_movements` registra canjes, reversiones y algunos actos manuales. |

Fuentes: [R1], [R2], [R3], [R4], [R6], [R9]. `shared.ts` traduce los campos entre SQL y el modelo de interfaz.

Orden actual de `getStudentLifecycle` y `student_lifecycle` [R1, R4]:
1. `archived_at` presente → `archived`.
2. Categoría `temporal` → `temporary`, sin evaluar vencimiento de membresía.
3. Desde seis días después del vencimiento → `archived`, **sin escribir `archived_at`**.
4. Días 1–5 posteriores al vencimiento → `pending`.
5. Sin fecha o sin pago considerado confirmado → `pending`; en otro caso → `active`.

TypeScript trata además una fecha inválida como pendiente. El calendario de ciclo de vida usa `Europe/Madrid`; otras operaciones combinan fechas locales y UTC. El saldo de clases no determina por sí solo el archivo.

## 3. Hallazgos: escenario, gravedad y corrección

**Alta** indica riesgo de identidad, autorización, saldo o estado comercial incorrecto. **Media** indica incoherencia operativa o bloqueo de contrato. Son prioridades propuestas, no mediciones de incidentes.

### H1 — Alta · Alta y renovación confirman pago implícitamente
**ESTÁTICO [R2, R3]:** el formulario nuevo y su reinicio parten de `paymentStatus: 'paid'`; `renewStudent` también asigna `paid` y borra el archivo.
**Escenario:** registrar o renovar a alguien que todavía no pagó lo muestra como pagado; renovar mezcla tres decisiones independientes.
**RECOMENDACIÓN:** alta pendiente por defecto; renovación modifica vigencia/plan sin confirmar cobro ni reactivar administrativamente. Confirmación de pago y reactivación deben ser actos explícitos.

### H2 — Alta · Vencimiento y archivo están confundidos
**ESTÁTICO + CATÁLOGO PREVIO [R1, R4]:** el día seis produce `archived` en el cálculo, aunque nadie archivó a la persona.
**Escenario:** una membresía vencida desaparece de activos como si hubiese una baja administrativa.
**RECOMENDACIÓN:** mantener días 1–5 como `pending`; día seis → `expired`. Reservar `archived` para `archived_at` y adaptar filtros, contadores y consumidores de ambos estados.

### H3 — Media · Reactivación temporal incompleta y fechas inestables
**ESTÁTICO [R2, R3]:** la edición solo desarchiva membresías pagadas con fecha vigente; renovación rechaza temporales. No hay acción explícita equivalente para reactivar un temporal conservando categoría.
**Escenario:** un temporal archivado no puede volver por el flujo anunciado; sumar un mes desde fin de enero con `setMonth` puede saltar a marzo.
**RECOMENDACIÓN:** reactivación manual independiente para cualquier categoría; aritmética de mes que limite al último día válido y calendario de taller consistente.

### H4 — Alta · El enlace de bonos puede duplicar una identidad existente
**ESTÁTICO + CATÁLOGO PREVIO [R5, R6, R7]:** el trigger descarta un destinatario explícito de membresía, busca solo categorías temporales y puede crear otro alumno. La resolución cliente no impone esa restricción.
**Escenario:** una persona con membresía recibe un bono y termina con una segunda identidad temporal; además hay vocabularios de categoría distintos entre capas.
**RECOMENDACIÓN:** aceptar el ID explícito existente de la misma sede sin restringir categoría; alinear vocabulario y no usar coincidencias ambiguas de nombre como prueba de identidad. No fusionar duplicados históricos automáticamente.

### H5 — Alta · Canje → reversión → canje no conserva el saldo
**ESTÁTICO + CATÁLOGO PREVIO [R8, R9, R10]:** el índice único mantiene el canje histórico; la reversión es otra fila. Un nuevo canje de la misma terna encuentra conflicto y no incrementa `sessions_used`; una reversión previa también bloquea nuevas reversiones.
**Escenario:** corregir y volver a validar una asistencia deja asistencia y consumo desalineados.
**RECOMENDACIÓN:** modelar el estado efectivo de cada consumo o ciclos de corrección identificables; garantizar atomicidad, idempotencia por operación y coherencia del saldo bajo concurrencia.

### H6 — Alta · La RPC no verifica que el alumno sea el destinatario
**ESTÁTICO + CATÁLOGO PREVIO [R9, R10]:** se comprueba sede y vínculo alumno/sesión, pero no igualdad con `card.recipient_student_id`.
**Escenario:** un alumno distinto de la misma sede puede consumir el bono ajeno mediante la RPC.
**RECOMENDACIÓN:** exigir destinatario, sesión y sede coherentes en canje y reversión; resolver destinatario nulo antes del consumo, sin aceptar asignación implícita arbitraria.

### H7 — Alta · Consumo manual y ledger divergen
**ESTÁTICO + CATÁLOGO PREVIO [R9, R10]:** ambos consumos manuales marcan `consumed` sin completar `sessions_used`; el interno no escribe movimiento y el externo sí escribe `manual`.
**Escenario:** un bono consumido conserva saldo aparente positivo; la historia difiere según el canal utilizado.
**RECOMENDACIÓN:** una transición transaccional común que alinee saldo, estado, fecha y movimiento; no fabricar un delta positivo si no queda saldo.

### H8 — Alta · El ledger permite DML directo autenticado
**ESTÁTICO + CATÁLOGO PREVIO [R8]:** `authenticated` dispone de INSERT/UPDATE/DELETE con RLS de acceso a sede, no de invariantes de consumo.
**Escenario:** un usuario autorizado en la sede modifica movimientos sin la actualización transaccional del bono.
**RECOMENDACIÓN:** canalizar escrituras por operaciones controladas y revisar grants/policies; probar también los intentos directos, no solo la interfaz.

### H9 — Media · Vigencia aceptada por API incompatible con SQL
**ESTÁTICO + CATÁLOGO PREVIO [R8, R12]:** el CHECK admite `3, 6, 8`; la API acepta enteros `1..24`.
**Escenario:** una solicitud validada por el endpoint falla al persistir.
**RECOMENDACIÓN:** alinear validación con el catálogo permitido; ampliar valores exigiría una decisión de producto y migración, no un cambio silencioso.

### H10 — Alta · API demasiado amplia para credenciales de agentes
**ESTÁTICO [R10, R11, R12, R13]:** hay claves separadas de lectura/escritura, una sede fijada por servidor y backend `service_role`; cada clave representa una identidad compartida. Las respuestas incluyen contactos, dedicatoria, notas internas y metadata.
**Escenario:** compartir la clave con un agente habilita más exposición de la necesaria; una repetición de `create` puede generar otro bono. `external_reference` tiene índice no único, no contrato explícito de idempotencia.
**RECOMENDACIÓN:** piloto de lectura con campos permitidos mínimos, atribución de credencial, revocación y límites; ningún secreto administrativo en el agente. Antes de futuras escrituras, exigir aprobación humana e idempotencia verificable.

## 4. Reglas de producto aprobadas

- Alta de membresía **pendiente de pago** por defecto; no inventar pagos del legado.
- Renovar y confirmar pago son operaciones distintas; renovar no desarchiva implícitamente.
- Vencimiento distinto de archivo: gracia de cinco días pendiente y `expired` desde el sexto.
- Una identidad por persona para membresía y bonos; categoría no obliga a crear otra persona.
- Archivo/reactivación explícitos, también para temporales, sin cambiarles categoría.
- No agregar facturación nueva ni fusionar duplicados históricos en esta secuencia.

## 5. Arquitectura API primero; MCP opcional

**RECOMENDACIÓN:** interfaz o agente → API de dominio acotada → operación autorizada → persistencia. MCP, si luego se aprueba, adapta esos contratos; no añade SQL libre, acceso genérico a tablas ni una vía alternativa de escritura.
El piloto debe ser solo lectura, con sede resuelta en servidor y proyección explícita de campos. No reutilizar sin reducción `publicGiftCard`: lectura no significa ausencia de datos sensibles. Excluir contactos, notas, dedicatorias y metadata salvo necesidad autorizada.
Credenciales permanecen del lado servidor; diferenciar cliente/operador, permitir revocación y registrar operación, alcance y resultado sin copiar datos personales a logs. `service_role` evita RLS: los filtros y la autorización del backend son obligatorios, no opcionales.

## 6. Secuencia acotada y requisitos de salida

| Unidad | Resultado requerido antes de avanzar |
|---|---|
| T1 · Informe | Evidencia separada por origen; ninguna corrección o ejecución remota atribuida al informe. |
| T2 · Ciclo de vida | Alta pendiente, renovación sin cobro/archivo implícito, `expired`, reactivación temporal, fechas limitadas e identidad compatible. |
| T3 · Bonos | Ciclos de corrección repetibles; destinatario/sede verificados; consumo manual y ledger consistentes; validación API alineada. |
| T4 · Piloto | Contrato API mínimo de lectura, claves acotadas y pruebas de que no admite escritura ni fuga de campos. Sin servidor MCP ni despliegue. |
| T5 · Verificación | Pruebas locales y build observados; comprobaciones SQL/integración no ejecutadas claramente pendientes. |

**RECOMENDACIÓN — antes de cualquier aplicación de SQL o despliegue:**
- Reconciliar el historial local/remoto mediante inspección autorizada; no renombrar ni reparar versiones automáticamente.
- Obtener un esquema base reproducible y entorno aislado sin datos personales; preservar migraciones históricas y agregar seguimientos no destructivos.
- Probar matriz de ciclo de vida: pago pendiente/pagado/legado, días 0/1/5/6, archivo manual, temporal y reactivación; fin de mes, año bisiesto y zona horaria.
- Probar bonos: canje/reversión/canje/reversión, repetición y concurrencia, agotamiento, consumo manual, destinatario erróneo, otra sede y DML directo prohibido.
- Probar API: clave incorrecta, separación lectura/escritura, sede no elegible por cliente, campos omitidos, límites y valores de vigencia.
- Runner local acordado: `npm run test:e2e -- tests/e2e/student-lifecycle.spec.ts`; build: `npm run build`. No se ejecutaron para este informe documental.
- Solicitar autorización explícita para migraciones y despliegue; preparar respaldo/recuperación y reversión revisados, sin borrados ni reset como supuesto remedio.

**Salida actual:** solo documentación. No hubo tests funcionales, reset, migración, despliegue ni lectura de filas; la revisión de rutas fuente no sustituye pruebas de integración SQL o navegador.

## 7. Referencias verificadas en el baseline

Todas las rutas son relativas a la raíz de `pottery-gym`; los identificadores anteriores permiten revisar cada hallazgo sin reconstruir toda la aplicación.

| ID | Archivo y punto de entrada |
|---|---|
| R1 | `utils/studentLifecycle.ts` — `getStudentLifecycle`, `getStudentPaymentStatus`, `getWorkshopDate`. |
| R2 | `components/StudentList.tsx` — defaults, reinicio del formulario, `shouldUnarchive` y archivo manual. |
| R3 | `context/data/studentOps.ts` — `addStudent`, `updateStudent`, `renewStudent`. |
| R4 | `supabase/migrations/20261010180407_student_payment_lifecycle.sql` — función y vista de ciclo de vida. |
| R5 | `context/data/giftCardOps.ts` — `resolveRecipientStudentId`, `ensureRecipientStudentId`, creación temporal. |
| R6 | `context/data/shared.ts` — `buildStudentPayload`, `mapStudentRowToModel`. |
| R7 | `supabase/migrations/20260303_fix_gift_card_trigger_no_recreate_on_student_delete.sql` — función de enlace; creación del trigger en `supabase/legacy-migrations/20260302_enforce_gift_cards_temp_student_link_via_trigger.sql`. |
| R8 | `supabase/migrations/20261008170000_expand_temporary_gift_cards.sql` — CHECK, índice de canje, grants y RLS de movimientos. |
| R9 | `supabase/migrations/20261009120000_add_gift_card_consumed_state.sql` — RPC internas de canje, reversión y consumo. |
| R10 | `supabase/migrations/20261010100000_add_external_gift_card_api.sql` — RPC externas e índice de referencia. |
| R11 | `supabase/functions/_shared/gift-card-api.ts` — `authenticate`, `giftCardSelect`, `publicGiftCard`. |
| R12 | `supabase/functions/bonos-write/index.ts` — creación, actualización y despacho de RPC. |
| R13 | `supabase/functions/bonos-read/index.ts` — filtros de sede, límite y movimientos opcionales. |
