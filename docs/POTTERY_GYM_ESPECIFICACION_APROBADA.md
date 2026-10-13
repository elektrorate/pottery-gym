# POTTERY GYM · ESPECIFICACIÓN APROBADA

**Estado del documento:** Vivo / fuente oficial de decisiones aprobadas  
**Fecha de creación:** 13/10/2026  
**Repositorio:** `elektrorate/pottery-gym`

> Este documento recoge únicamente decisiones cerradas o aprobadas del proyecto Pottery Gym.  
> Las propuestas, ideas o variantes no aprobadas deben quedar fuera o marcadas expresamente como pendientes.  
> Si existe contradicción entre conversaciones previas y este documento, prevalece la decisión más reciente registrada aquí.

---

## 0. Principios generales aprobados

- Pottery Gym se construye como una **nueva aplicación desde cero**.
- El backend anterior sirve como **referencia técnica y fuente de aprendizajes**, pero no determina automáticamente los estados, tablas o flujos de la nueva app.
- Arquitectura objetivo:
  - React + TypeScript + Vite.
  - Supabase Auth.
  - PostgreSQL.
  - RLS desde el inicio.
  - RPC / Edge Functions para operaciones críticas.
  - TanStack Query por feature.
  - Vercel para frontend.
- Diseño **exclusivamente móvil** como criterio por defecto del proyecto. Pottery Gym se diseña pensando en móvil desde el inicio; no se diseñan ni documentan variantes desktop salvo decisión futura explícita.
- Multi-workshop real.
- UUID como identidad de entidades.
- No usar nombres como claves lógicas.
- Separar autenticación, identidad, membership y permisos.
- Separar estado operativo actual de histórico/auditoría.
- No depender de hidratación global completa del estado.
- No duplicar lógica entre Dashboard, Calendario, API o agentes.
- El servidor y RLS son la autoridad de acceso.
- El frontend nunca se considera capa de seguridad.

---

## Regla transversal de interfaz móvil

**APROBADO:** Pottery Gym se diseña únicamente para móvil en esta etapa.

- Pensar primero y únicamente en pantallas móviles.
- No diseñar layouts desktop.
- No documentar drawers, sidebars o variantes específicas de escritorio.
- Priorizar pantallas completas, listas verticales, navegación simple y acciones compactas.
- Cualquier adaptación futura a tablet o desktop requerirá una decisión explícita posterior.
- Esta regla aplica a todas las secciones funcionales y técnicas del proyecto.

---

# 1. Navegación principal del taller

## Estado: APROBADO

Orden oficial:

1. Resumen
2. Calendario
3. Alumnos
4. Profesores
5. Gift Card
6. Inventario
7. Gestión

### Gestión

- Actividad
- Equipo
- Configuración

### Lógica del menú

**Uso frecuente**
- Resumen
- Calendario
- Alumnos

**Operación del taller**
- Profesores
- Gift Card
- Inventario

**Administración**
- Gestión
  - Actividad
  - Equipo
  - Configuración

### Reglas

- Priorizar módulos de uso diario.
- Evitar menús duplicados.
- Gestión agrupa funciones administrativas.
- Diseño móvil como estándar del proyecto.
- **Piezas queda eliminado del proyecto.**

---

# 2. SuperAdmin

## Estado: APROBADO

### Funciones principales

- Crear taller.
- Editar datos básicos del taller.
- Asignar o transferir Owner.
- Reenviar o cancelar invitaciones.
- Ver miembros del taller y estado de acceso.
- Suspender o archivar talleres.
- Consultar estado técnico básico.
- Ver fecha de creación y última actividad.

### Regla central

**SuperAdmin administra la plataforma, no la operación diaria del taller.**

### SuperAdmin no hace

- No gestiona alumnos.
- No pasa asistencia.
- No gestiona clases operativas.
- No administra créditos cotidianos.
- No opera Gift Cards del día a día.
- No obtiene automáticamente permisos operativos dentro de un taller.

### Flujo de creación de taller

Formulario mínimo:

- Nombre del taller.
- Nombre del responsable.
- Email de acceso.
- Imagen o logotipo.

Flujo:

```text
Crear workshop
→ status = setup
→ comprobar si email ya existe
→ crear o reutilizar identidad
→ crear invitación de Owner
→ enviar email
→ Owner acepta invitación
→ onboarding inicial
→ workshop active
```

### Relación

```text
PLATAFORMA
   ↓
SUPERADMIN
   ↓
WORKSHOPS
```

Cada workshop tiene su propia operación, miembros y datos.

---

# 3. Login y resolución de acceso

## Estado: APROBADO

### Acceso

- Email + contraseña.
- Google OAuth.
- Recuperar contraseña.

### Regla central

**Login autentica identidad; no concede por sí mismo acceso al taller.**

### Flujo

```text
Usuario inicia sesión
→ Supabase Auth valida identidad
→ cargar profile
→ resolver memberships activas
→ determinar activeWorkshop
→ cargar role + permissions
```

Si workshop está en `setup`:

```text
→ Onboarding
```

Si está activo:

```text
→ Dashboard
```

### Resolución de memberships

- 0 memberships → “No tienes acceso a ningún taller”.
- 1 membership → entrar automáticamente.
- Más de 1 → selector o último taller válido.

### Regla

`activeWorkshop` guardado localmente es una preferencia, no autorización.

### Capas

```text
AUTH USERS
→ PROFILES
→ WORKSHOP_MEMBERS
→ ROLE + PERMISSIONS
→ WORKSHOP
```

---

# 4. Onboarding

## Estado: APROBADO COMO DIRECCIÓN FUNCIONAL

### Entrada

```text
Owner acepta invitación
→ Login
→ resolver memberships
→ activeWorkshop
→ ¿workshop.status = setup?
   ├─ Sí → Onboarding
   └─ No → Dashboard
```

### Objetivo

Configurar solo lo mínimo para dejar el taller operativo.

### Flujo

1. Información del taller.
2. Configuración regional.
3. Tipos de actividad.
4. Equipo opcional.
5. Revisar y finalizar.
6. Workshop pasa de `setup` a `active`.
7. Dashboard.

### Paso 1 · Información

- Nombre.
- Logo.
- Teléfono.
- Email.

### Paso 2 · Región

- Dirección.
- Zona horaria.
- Idioma.
- Moneda.

La zona horaria afecta:
- Hoy.
- Calendario.
- Sesiones.
- Dashboard.
- Actividad.
- Fechas y horas.

### Paso 3 · Tipos de actividad

El taller selecciona sus actividades iniciales.

No configurar aquí:
- precios complejos,
- capacidades detalladas,
- reglas comerciales avanzadas.

### Paso 4 · Equipo

- Invitar colaborador.
- Nombre.
- Email.
- Rol.
- Omitir por ahora.

### No bloquear onboarding por

- Stripe.
- Gift Cards.
- Profesores.
- reglas avanzadas.
- configuraciones secundarias.

---

# 5. Dashboard / Resumen

## Estado: APROBADO

### Objetivo

Responder:

- ¿Qué ocurre hoy?
- ¿Qué requiere atención?
- ¿Cómo está el taller?
- ¿Qué ha ocurrido recientemente?

### Hoy

Mostrar sesiones del día con:

- Hora.
- Tipo de actividad.
- Profesor.
- Alumnos previstos.
- Ocupación.
- Estado.

Acción:

```text
Abrir sesión → Calendario
```

Dashboard no implementa una asistencia distinta.

### Requiere atención

- Alumnos que necesitan renovar.
- Sesiones con asistencia pendiente.
- Incidencias de saldo.
- Materiales de inventario con stock bajo o sin stock.

### Estado del taller

- Alumnos activos.
- Ocupación de hoy.
- Renovaciones pendientes.
- Indicadores operativos útiles.

Cada indicador debe abrir su contexto correspondiente.

### Actividad reciente

Mostrar solo últimos eventos relevantes.

El histórico completo vive en:

```text
Gestión → Actividad
```

### Regla

```text
RESUMEN
→ detecta
→ informa
→ redirige
→ módulo fuente
```

### Fuente de datos

Resumen consume datos; no es fuente de verdad.

---

# 6. Alumnos

## Estado: PARCIALMENTE APROBADO / EN DEFINICIÓN

### Decisiones ya aprobadas

- UUID como identidad.
- No usar nombres como clave.
- Separar identidad, relación comercial, saldo y asistencia.
- Las renovaciones deben ser explícitas y trazables.
- No hard-delete rutinario.
- El saldo debe poder explicarse mediante movimientos.
- Historial del alumno es contextual.
- Actividad del taller es global.
- Una operación real no se duplica para aparecer en ambos lugares.

### Creación de alumno

**APROBADO:** crear un alumno y crear su perfil inicial es una única operación.

No existirán dos pasos separados de:

```text
Crear alumno
→ guardar alumno vacío
→ completar después categoría / actividad / perfil
```

El flujo será:

```text
ALUMNOS
→ + NUEVO ALUMNO
→ completar datos personales + perfil inicial del taller
→ Guardar
→ PERFIL DEL ALUMNO
```

En el alta se definen, dentro de la misma pantalla, tanto los datos básicos de la persona como su relación inicial con el taller, incluyendo la categoría y/o actividad o modalidad que corresponda.

Después de guardarlo, el Administrador puede abrir el perfil y editar posteriormente los datos permitidos.

Regla:

```text
CREAR ALUMNO = CREAR SU PERFIL INICIAL
EDITAR PERFIL = MODIFICARLO POSTERIORMENTE
```

No se crea un registro de alumno vacío que obligue a un segundo proceso para completar su pertenencia al taller.

La definición exacta de qué campos son obligatorios u opcionales se cerrará dentro de la revisión final de Alumnos.


### Alta de alumno · Membresía

Para un alumno de tipo **Membresía**, el alta incluye:

```text
MEMBRESÍA

Actividad *
[ seleccionar actividad ]

Tipo de bono *
[ Plata / Oro / Platinum ]

Fecha de inicio *
[ dd/mm/aaaa ]

Fecha de vencimiento
[ último día del mes ]

Estado
[ calculado automáticamente ]
```

Reglas:

- No se introducen manualmente “bonos / sesiones iniciales”.
- El usuario selecciona el **tipo de bono de membresía**: Plata, Oro o Platinum.
- La cantidad de sesiones/créditos asociada se obtiene del bono seleccionado.
- La fecha de vencimiento se calcula por defecto como el **último día del mes** correspondiente.
- El estado no se selecciona manualmente durante el alta.
- Con sesiones/bonos disponibles → **Activo**.
- Al agotarse → **Inactivo** automáticamente.
- **Archivado** sigue siendo exclusivamente manual.

### Tipo de alumno y actividad

## Estado de este subpunto: APROBADO

**APROBADO:** existen tres tipos de alumno independientes entre sí:

```text
ALUMNO
├── Membresía
├── Temporal
└── Gift Card
```

No se mezclan entre sí.

Un alumno de **Gift Card** no es un alumno Temporal ni un alumno de Membresía.  
Un alumno de **Membresía** no utiliza Gift Card como parte de su membresía.  
Un alumno **Temporal** tampoco se define mediante Gift Card.

### Separación de conceptos

```text
TIPO DE ALUMNO
→ Membresía / Temporal / Gift Card

ACTIVIDAD
→ Torno / Modelado / otra actividad configurada por el taller

PLAN O BONO
→ depende del tipo de alumno

ESTADO
→ depende de las reglas de cada tipo
```

### Alumno de Membresía

Tiene tres estados:

- **Activo** → tiene sesiones/bonos disponibles.
- **Inactivo** → se queda sin sesiones/bonos disponibles. Este cambio es automático.
- **Archivado** → solo se aplica manualmente por el Administrador/Owner.

```text
MEMBRESÍA
bonos > 0 → Activo
bonos = 0 → Inactivo automático
Archivado → solo manual
```

Quedarse sin sesiones no archiva al alumno.

### Alumno Temporal

Solo tiene dos estados:

- **Activo** → tiene sesiones/bonos disponibles.
- **Archivado** → ya no tiene sesiones/bonos disponibles.

No existe estado **Inactivo** para alumnos temporales.

```text
TEMPORAL
bonos > 0 → Activo
bonos = 0 → Archivado automático
```

### Alumno Gift Card

Es un tipo de alumno independiente.

- **Activo** → su Gift Card tiene sesiones disponibles.
- **Archivado** → ha consumido todas las sesiones de su Gift Card.

No existe estado **Inactivo** para alumnos Gift Card.

```text
GIFT CARD
sesiones > 0 → Activo
sesiones = 0 → Gift Card agotada + alumno archivado
```

La Gift Card no se mezcla con Membresía ni Temporal.

### Historial contextual del alumno

Incluye:

- Renovaciones.
- Asistencias.
- Consumos de créditos.
- Correcciones.
- Ajustes manuales.
- Gift Cards.
- Archivado / reactivación.
- Incidencias relevantes.

### Gestión → Actividad

Responde:

**¿Qué ha ocurrido recientemente en el taller?**

Incluye eventos de:
- Alumnos.
- Sesiones.
- Gift Cards.
- Equipo.
- Inventario.
- Otros eventos relevantes.

### Regla de trazabilidad

```text
FUENTE DE VERDAD
→ EVENTO
→ activity_log
→ Historial contextual / Actividad global
```

`activity_log` no es fuente de verdad.

---

# 7. Calendario / Sesiones

## Estado: APROBADO

### Regla central

```text
CALENDARIO = vista temporal
SESSION = entidad operativa
```

### Vistas

- Día.
- Semana.
- Mes.

En móvil, Día es vista prioritaria.

### Session

Campos conceptuales:

- id
- workshop_id
- date
- start_time
- end_time
- type
- teacher_id
- teacher_substitute_id
- status
- capacity
- title
- notes
- completed_at
- completed_by_user_id

### Estados

- scheduled
- in_progress
- completed
- cancelled

### Detalle de sesión

- Fecha.
- Hora.
- Tipo.
- Profesor.
- Sustituto.
- Capacidad.
- Estado.
- Notas.
- Alumnos asignados.
- Asistencia.

### Session students

- student_id
- booking_status
- attendance_status
- credit_consumed
- balance_movement_id
- added_at

### Añadir alumno

Validar:
- workshop.
- estado del alumno.
- servicio compatible.
- crédito disponible.
- conflicto horario.
- capacidad.

### Capacidad

```text
plazas disponibles
=
capacity
-
alumnos booked
```

No hardcodear capacidad.

### Profesor y sustituto

- `teacher_id` = profesor planificado.
- `teacher_substitute_id` = sustituto real.

No sobrescribir profesor original.

### Cancelación

Cancelar no significa borrar.

### Recurrencias

Al editar:

- Solo esta sesión.
- Esta y siguientes.

### Asistencia

Vive en:

```text
session_students.attendance_status
```

No duplicarla en otros módulos.

### Consultas

Cargar sesiones por rango de fechas.

No cargar historial completo innecesariamente.

### Diseño móvil

- Día prioritario.
- Semana simplificada.
- Detalle de sesión a pantalla completa.
- No diseñar variante desktop en esta fase.

---

# 8. Asistencia + Consumo + Saldo

## Estado: DIRECCIÓN APROBADA; DEBE ADAPTARSE A LA IMPLEMENTACIÓN NUEVA

### Principio

```text
ASISTENCIA ≠ CONSUMO
```

La asistencia describe lo ocurrido.

El movimiento de saldo describe la consecuencia comercial.

### Estados de asistencia

- pending
- present
- absent

### Reglas

- Present debe reflejar la realidad.
- Absent no debe falsearse para evitar incidencias.
- Los movimientos deben ser trazables.
- Las correcciones generan movimientos compensatorios.
- No borrar movimientos anteriores.
- Una operación no puede descontar dos veces.
- Idempotencia obligatoria.
- Dashboard y Calendario deben usar el mismo motor.

### Arquitectura aprobada para operaciones críticas

Mantener:
- RPC atómicas.
- request_key.
- revision.
- receipts persistentes.
- movimientos históricos.
- correcciones inversas.
- control de concurrencia.

### Reglas comerciales ya aprobadas

- El consumo ocurre **al finalizar la sesión**, no al reservar.
- El plazo de cancelación **es configurable por cada taller**; no existe un valor fijo global para Pottery Gym.
- Una cancelación realizada dentro del plazo configurado por el taller → no consume.
- Una cancelación realizada fuera del plazo configurado → consume una clase.
- Falta/no-show sin cancelación a tiempo → consume una clase.
- Sin crédito válido → incidencia pendiente; no saldo negativo automático.
- Pago pendiente/desconocido → asistencia solo con aprobación explícita.
- Membresía vencida → asistencia solo con aprobación explícita.
- Excepción de asistencia se vincula a alumno + sesión + actor + motivo.
- Solo Owner puede eximir/revertir penalizaciones.
- Solo Owner puede aprobar créditos manuales.
- Solo Owner puede liquidar incidencias pendientes.
- La liquidación debe usar el periodo o bono original relacionado.
- No cargar automáticamente otro derecho posterior.

---

# 9. Profesores

## Estado: APROBADO

### Regla principal

```text
PROFESOR ≠ STAFF
```

Un profesor imparte clases.

Un miembro del equipo accede al CRM.

Una persona puede ser ambas cosas.

### Profesor puede existir sin usuario del CRM

El vínculo con usuario es opcional.

### Lista

Buscar por:
- nombre,
- apellido,
- especialidad.

Filtros:
- activos,
- inactivos,
- especialidad.

### Ficha

- Resumen.
- Agenda.
- Historial.
- Datos.

### Especialidades

Vinculadas a tipos de actividad del taller.

No como texto libre si existe catálogo de actividades.

### Disponibilidad

Disponibilidad no crea sesiones.

### Agenda

Es una vista de Sessions.

No un calendario paralelo.

### Asignación

Validar:
- activo.
- actividad compatible.
- disponibilidad.
- conflicto horario.

### Sustituciones

Conservar titular y sustituto por separado.

### Actividad contabilizada

Solo sesiones:

```text
status = completed
```

Mostrar:
- cantidad de clases terminadas.
- horas impartidas.

Si hubo sustituto:
- las horas cuentan para quien realmente impartió la sesión.
- el profesor titular sigue conservado como planificación histórica.

### No incluir en V1

- Tarifas.
- Coste por hora.
- Nóminas.
- Liquidaciones.

---

# 10. Gift Card

## Estado: APROBADO

### Definición

Gift Card = bono que permite utilizar una cantidad determinada de sesiones.

### Estados únicos

```text
GIFT CARD
├── Activas
├── Agotadas
└── Caducadas
```

No heredar estados del backend anterior.

### Creación

```text
Crear Gift Card
→ generar UUID interno
→ generar código visible único automáticamente
→ estado = Activa
```

El usuario no escribe manualmente el código.

### Código

- UUID = identidad interna.
- code = código visible.

### Flujo

```text
ACTIVA
├── se consumen todas las sesiones → AGOTADA
└── supera fecha de caducidad → CADUCADA
```

---

# 11. Gestión → Equipo

## Estado: APROBADO

### Roles V1

- Administrador / Owner.
- Colaborador.

No se necesita un constructor complejo de roles en V1.

### Creación de colaborador

```text
Administrador
→ Gestión → Equipo
→ Nuevo colaborador
→ Nombre + Email
→ Crear usuario / invitación
→ colaborador configura acceso
```

El administrador no gestiona la contraseña del colaborador.

### Colaborador puede

- Entrar a la plataforma.
- Ver Agenda / Resumen operativo.
- Ver Calendario.
- Ver Inventario.
- Ver Gift Cards.
- Abrir sesiones.
- Ver alumnos asignados.
- Pasar asistencia.
- Registrar incidencias / notas operativas sobre alumnos.

### Colaborador no puede

- Gestionar calendario estructural.
- Gestionar alumnos.
- Renovar membresías.
- Modificar créditos.
- Confirmar pagos.
- Crear o modificar Gift Cards.
- Gestionar Inventario.
- Gestionar Equipo.
- Entrar en Configuración.
- Transferir propiedad del taller.

### Incidencias de alumnos

Una incidencia:
- pertenece a un alumno.
- puede vincularse opcionalmente a una sesión.
- tiene nota.
- actor.
- fecha.

Una incidencia no modifica por sí sola:
- saldo,
- pagos,
- membresías,
- asistencia.

### Desactivar colaborador

- Pierde acceso.
- No se borra su historial.
- Sus acciones anteriores siguen atribuibles.

---

# 12. Inventario

## Estado: APROBADO

### Alcance

Inventario forma parte de Pottery Gym V1.

### Categorías

Las categorías **no están fijadas por el sistema**.

Cada taller puede:
- crear categorías,
- editar categorías,
- ordenar categorías,
- desactivar categorías.

Ejemplos posibles, no obligatorios:
- Arcillas.
- Materias primas.
- Pigmentos.
- Consumibles.
- Embalaje.
- Limpieza.

### Estructura conceptual

```text
inventory_categories
├── id
├── workshop_id
├── name
├── active
└── sort_order
```

```text
inventory_items
├── id
├── workshop_id
├── category_id
├── name
├── unit
├── stock
└── minimum_stock
```

### Regla central

```text
INVENTARIO
=
estado actual
+
movimientos
```

### Movimientos

- Entrada.
- Salida.
- Ajuste.

No sobrescribir stock sin trazabilidad.

### Stock

```text
Entradas
+ ajustes positivos
- salidas
- ajustes negativos
=
stock actual
```

### Stock mínimo

Configurable por item.

Estados derivados:
- Disponible.
- Stock bajo.
- Sin stock.

### Nuevo material

- Nombre.
- Categoría.
- Unidad.
- Stock inicial.
- Stock mínimo.
- Notas opcionales.

El stock inicial debe generar un movimiento.

### Permisos

Administrador:
- ver,
- crear,
- editar,
- registrar entrada,
- registrar salida,
- ajustar,
- definir stock mínimo,
- desactivar.

Colaborador:
- solo lectura.

### Historial

Por item:
- fecha,
- tipo,
- cantidad,
- usuario,
- motivo.

### No borrar

Si una categoría o item tiene historial:
- desactivar,
- no hard-delete.

### Dashboard

Solo alertas útiles:
- stock bajo,
- sin stock.

### Fuera de alcance de Inventario V1

No tratar como inventario consumible:
- hornos,
- tornos,
- laminadoras,
- maquinaria,
- mobiliario,
- herramientas reutilizables.

---

# 13. Gestión → Actividad / Trazabilidad

## Estado: APROBADO

### Distinción

```text
ALUMNO → HISTORIAL
=
¿Qué ha ocurrido con este alumno?
```

```text
GESTIÓN → ACTIVIDAD
=
¿Qué ha ocurrido recientemente en el taller?
```

### No crear dos historiales

```text
OPERACIÓN REAL
→ TABLA DE DOMINIO
→ activity_log
→ vista contextual / vista global
```

### activity_log

Debe explicar:
- qué ocurrió,
- quién lo hizo,
- cuándo,
- entidad,
- contexto resumido.

No es fuente de verdad.

### No registrar ruido

No registrar:
- abrir alumno,
- cambiar pestaña,
- buscar,
- abrir calendario,
- ver Gift Card,
- ver inventario.

---

# 14. Gestión → Configuración

## Estado: APROBADO

### Regla principal

```text
CONFIGURACIÓN
=
datos y reglas generales del taller
```

No se utiliza para gestionar la operación diaria.

### Acceso

Solo el **Administrador / Owner** puede entrar y modificar Configuración.

El Colaborador no tiene acceso.

### Datos del taller

- Nombre.
- Logo.
- Teléfono.
- Email.
- Dirección.

El onboarding configura estos datos inicialmente y Configuración permite editarlos después.

### Región

- Zona horaria.
- Idioma.
- Moneda.

La zona horaria del workshop afecta:
- Calendario.
- Sesiones.
- “Hoy”.
- Dashboard.
- Actividad.
- Gift Cards.
- caducidades.
- fechas y horas.

### Actividades

Cada taller crea sus propios tipos de actividad.

Puede:
- crear,
- editar,
- ordenar,
- desactivar.

No existen categorías de actividad obligatorias fijadas por Pottery Gym.

Las actividades utilizadas históricamente se desactivan; no se eliminan físicamente.

### Clases y sesiones

Configuración define valores predeterminados por actividad, por ejemplo:

- duración predeterminada,
- capacidad predeterminada.

Estos valores son defaults.

La sesión concreta conserva el valor operativo definitivo y puede diferir del predeterminado.

### Horario general del taller

Por cada día de la semana:

- abierto / cerrado,
- hora de inicio,
- hora de fin.

El horario general no crea sesiones.

### Excepciones de horario

Permitir:
- festivos,
- cierres especiales,
- horarios especiales.

### Gift Card

Configuración contiene reglas generales de Gift Card, por ejemplo:

- caducidad predeterminada.

Las Gift Cards concretas se gestionan desde su propio módulo.

### Plazo de cancelación

**Cada taller configura su propio plazo de cancelación en horas.**

No existe un valor fijo global de 8 horas.

La lógica de cancelación y penalización debe consultar el valor configurado en el workshop.

Ejemplos posibles:

- 8 h,
- 12 h,
- 24 h,
- 48 h.

### No duplicar configuración

Inventario se configura dentro de Inventario.

Equipo se gestiona desde Gestión → Equipo.

Profesores se gestionan desde Profesores.

### Trazabilidad

Registrar cambios relevantes como:

- activity_created,
- activity_deactivated,
- workshop_timezone_changed,
- workshop_hours_changed,
- gift_card_expiration_changed,
- cancellation_window_changed.

No registrar aperturas de pantalla ni navegación.

### Mobile First

En móvil, Configuración se presenta como secciones independientes:

- Datos del taller.
- Región.
- Actividades.
- Clases y sesiones.
- Gift Card.

No usar un formulario único gigantesco.

---

# 15. Arquitectura de lectura / rendimiento

## Estado: APROBADO COMO DIRECCIÓN TÉCNICA

### Principio

No rehacer la robustez de escrituras críticas.

Cambiar principalmente arquitectura de lectura.

### Objetivo

Antes:

```text
HISTORIAL
→ reconstruir todo
→ DataContext
→ UI
```

Objetivo:

```text
HISTORIAL = auditoría / fuente de verdad
READ MODEL = estado actual
TANSTACK QUERY = caché UI
```

### Contextos globales

Mantener solo lo realmente global:
- AuthContext.
- WorkshopContext / activeWorkshop.
- permissions.

No crear un Context por cada módulo.

### Queries por feature

- dashboardQueries
- calendarQueries
- studentQueries
- teacherQueries
- giftCardQueries
- inventoryQueries
- activityQueries

### Read models

Adoptar CQRS ligero.

Las tablas de dominio y movimientos siguen siendo fuente de verdad.

Read models sirven para UI rápida.

### Ejemplo prioritario

`student_operational_state`

Puede resumir:
- estado.
- categoría.
- servicio.
- créditos.
- membership.
- vencimiento.
- pago.
- última asistencia.
- próxima sesión.
- incidencias.

Nunca es fuente de verdad definitiva.

### Mutaciones

Después de una mutación:
- actualizar / invalidar solo queries afectadas.
- no recargar todo el sistema.

### Lecturas

PostgREST para lecturas simples.

RPC / Views para:
- agregaciones,
- joins complejos,
- dashboard,
- detalle complejo,
- estados resumidos.

### RLS

```text
FILTRO = rendimiento
RLS = seguridad
```

Filtrar explícitamente por `workshop_id`.

### Paginación

Keyset/cursor pagination.

No cargar todo y hacer slice en cliente.

### Conteos

Reducir COUNT exactos constantes.

### Dashboard

Lectura especializada tipo:

`get_dashboard_snapshot(workshop_id, date)`

### Calendario

`get_calendar_sessions(workshop_id, start_date, end_date)`

Cargar detalle solo al abrir sesión.

### Operaciones administrativas

DB + Auth + Storage no se consideran una transacción ACID única.

Usar saga/orquestación para procesos administrativos complejos.

### Cache

Stale-while-revalidate mediante TanStack Query.

Cache = UX.

Nunca autorización.

---

# 16. Arquitectura preparada para agentes / MCP

## Estado: APROBADO COMO DIRECCIÓN

### Objetivo

El CRM debe poder conectarse en el futuro a un agente sin duplicar reglas de negocio.

### Capas

```text
CORE CRM
↓
DOMAIN / API LAYER
↓
AGENT / MCP LAYER
```

### Principio

La misma operación debe ser reutilizada por:
- Web App.
- API.
- Integraciones.
- MCP.

Ejemplo:

```text
WEB APP
→ completeSession()
```

```text
AGENTE
→ MCP/API
→ completeSession()
```

### MCP

MCP es adaptador.

No es el cerebro del sistema.

Nunca:
- SQL libre.
- acceso directo a tablas.
- service_role en el LLM.
- bypass de autorización.

### Capabilities

La arquitectura debe poder evolucionar a capacidades como:

- students.read
- students.create
- students.update
- sessions.read
- sessions.book_student
- attendance.write
- attendance.correct
- balances.read
- balances.adjust
- giftcards.read
- giftcards.create
- inventory.read
- team.manage
- settings.manage

### Scope

Autorización debe poder responder:

```text
¿Quién?
→ ¿Qué operación?
→ ¿Qué workshop?
→ ¿Sobre qué entidad?
→ ¿Está permitido?
```

### Principal

La auditoría debe poder evolucionar para distinguir:
- user,
- integration,
- system.

### Idempotencia transversal

Operaciones críticas deberían usar patrón:
- request_key,
- validación,
- ejecución,
- receipt,
- recuperación.

### Agente V1 futuro

Enfoque recomendado:
- lectura primero.
- escrituras no financieras después.
- operaciones sensibles con aprobación humana.

---

# 17. Reglas de despliegue y producción

## Estado: APROBADO COMO DIRECCIÓN

### Entornos

```text
LOCAL
→ STAGING
→ PRODUCTION
```

### Antes de producción

- staging aislado.
- migraciones reproducibles.
- datos sintéticos.
- pruebas de navegador.
- pruebas RLS.
- pruebas multi-workshop.
- pruebas de concurrencia.
- backup.
- restauración ensayada.
- rollback documentado.
- despliegue backend/frontend coordinado.

### Rollout

1. CRM nuevo con usuarios internos.
2. Agente solo lectura.
3. Escrituras no financieras.
4. Operaciones sensibles cuando estén verificadas.

---

# 18. Decisiones descartadas / eliminadas

## Piezas

**ELIMINADO DEL PROYECTO.**

Eliminar cualquier referencia funcional a:
- módulo Piezas.
- piezas dentro de alumno.
- piezas en Dashboard.
- pieces / piece_photos.
- eventos de actividad de piezas.
- API / MCP de piezas.

### Regla

No reintroducir Piezas salvo nueva decisión explícita.

---

# 19. Secciones pendientes de cerrar

- Revisión final de Alumnos.
- Modelo de datos V1 completo.
- Matriz final de permisos / capabilities.
- Sesiones mixtas: decisión explícita de producto.
- Reglas de negocio pendientes de issue #8.
- Especificación final del agente / transporte MCP.
- Plan maestro de implementación.
- Checklist de producción.

---

# 20. Método de trabajo

Para cada nueva sección:

1. Diseñar.
2. Revisar.
3. Ajustar.
4. Cerrar explícitamente.
5. Actualizar este documento.
6. Proponer el siguiente punto.

Una sección cerrada no se modifica silenciosamente.  
Cualquier cambio posterior debe registrarse como una nueva decisión.
