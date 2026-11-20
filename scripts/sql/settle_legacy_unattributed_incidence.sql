-- =============================================================================
-- ONE-OFF: regularizar UNA incidencia legacy «Sin derecho original atribuible»
-- (motivo «Unsupported temporal/manual funding: …») creada antes de fix26
-- (migración 20261120140000_scalar_pack_funding) para un alumno de bono
-- temporal / grupal / grupo temporal. NO ES UNA MIGRACIÓN.
-- No ejecutar contra producción (ilkrcakrduibgsfqfzti) sin OK humano explícito,
-- copia de seguridad previa y dry-run revisado.
--
-- Resultado: descuenta 1 clase del saldo escalar del alumno (mismo camino que
-- save_session_attendance post-fix26: session_business_adjust_scalar(-1) +
-- movimiento 'scalar_balance'), deja la incidencia y su facturación en
-- «charged» con la nota «Regularización falta previa a fix26» y registra un
-- evento penalty_settled auditable (con el motivo original).
--
-- Por qué no usa settle_student_penalty / student_penalty_settlements:
--   la RPC y la tabla exigen exactamente una fuente (periodo, bono o crédito
--   manual) y este caso no tiene ninguna. Por eso se deja la incidencia como
--   las que fix26 crea ya cobradas (state='charged' + debit_id). La tabla
--   session_business_penalties es append-only (trigger guard_business_history):
--   el script desactiva ese trigger SOLO durante el UPDATE de esta fila, dentro
--   de la misma transacción, y lo vuelve a activar antes de terminar (si algo
--   falla, el ROLLBACK lo deja como estaba).
--
-- Seguridad / idempotencia:
--   * Exige incidence_id Y student_id (doble identificación).
--   * Rechaza: incidencia no pending, ya con débito/liquidación/exención, con
--     fuente atribuible, motivo no legacy, alumno de membresía, sesión no
--     finalizada policy v2, débito previo no revertido, saldo < 1.
--   * Una segunda ejecución falla (ya no está pending) → nunca doble débito.
--   * DRY-RUN por defecto: ejecuta todo dentro de un subbloque y lo revierte
--     (también la desactivación del trigger); devuelve el resumen simulado.
--
-- Uso (psql):
--   psql "$DB_URL" -v ON_ERROR_STOP=1 \
--     -v incidence_id=<uuid session_business_penalties.id> \
--     -v student_id=<uuid students.id> \
--     [-v dry_run=0] \
--     -f scripts/sql/settle_legacy_unattributed_incidence.sql
--
-- Sin psql (p. ej. editor SQL): ejecutar el bloque entre los marcadores
-- CORE-BEGIN / CORE-END dentro de BEGIN … COMMIT, precedido de
--   select set_config('rio.settle_incidence_id','<uuid>',true),
--          set_config('rio.settle_student_id','<uuid>',true),
--          set_config('rio.settle_dry_run','1',true);   -- '0' para aplicar
-- =============================================================================

\set ON_ERROR_STOP on

\if :{?incidence_id}
\else
\echo 'ERROR: pasa -v incidence_id=<uuid> de la incidencia a regularizar'
\quit 1
\endif

\if :{?student_id}
\else
\echo 'ERROR: pasa -v student_id=<uuid> del alumno de la incidencia'
\quit 1
\endif

\if :{?dry_run}
\else
\set dry_run 1
\endif

\echo '=== settle_legacy_unattributed_incidence ==='
\echo 'incidence_id =' :incidence_id
\echo 'student_id   =' :student_id
\echo 'dry_run      =' :dry_run

BEGIN;

-- psql no interpola variables dentro de bloques $…$: se pasan por GUC local.
SELECT set_config('rio.settle_incidence_id', :'incidence_id', true),
       set_config('rio.settle_student_id', :'student_id', true),
       set_config('rio.settle_dry_run', :'dry_run', true);

-- CORE-BEGIN
DO $settle$
DECLARE
  v_penalty_id uuid := nullif(btrim(current_setting('rio.settle_incidence_id', true)), '')::uuid;
  v_student_id uuid := nullif(btrim(current_setting('rio.settle_student_id', true)), '')::uuid;
  v_dry boolean := coalesce(nullif(btrim(current_setting('rio.settle_dry_run', true)), ''), '1') <> '0';
  v_note constant text := 'Regularización falta previa a fix26';
  pen public.session_business_penalties%ROWTYPE;
  s public.sessions%ROWTYPE;
  e public.session_students%ROWTYPE;
  st public.students%ROWTYPE;
  b public.session_business_billing%ROWTYPE;
  v_debit uuid;
  v_before integer;
  v_after integer;
  v_rows integer;
  v_rev bigint;
  v_summary jsonb;
BEGIN
  IF v_penalty_id IS NULL OR v_student_id IS NULL THEN
    RAISE EXCEPTION 'incidence_id y student_id son obligatorios';
  END IF;

  SELECT * INTO pen FROM public.session_business_penalties WHERE id = v_penalty_id;
  IF pen.id IS NULL THEN
    RAISE EXCEPTION 'Incidencia % no encontrada', v_penalty_id;
  END IF;
  IF pen.student_id IS DISTINCT FROM v_student_id THEN
    RAISE EXCEPTION 'La incidencia % no pertenece al alumno %', v_penalty_id, v_student_id;
  END IF;

  -- Mismo orden de bloqueo que settle_student_penalty: sesión, alumno, reserva.
  SELECT * INTO s FROM public.sessions WHERE id = pen.session_id FOR UPDATE;
  SELECT * INTO st FROM public.students WHERE id = pen.student_id FOR UPDATE;
  SELECT * INTO e FROM public.session_students
    WHERE session_id = pen.session_id AND student_id = pen.student_id FOR UPDATE;
  SELECT * INTO b FROM public.session_business_billing
    WHERE session_id = pen.session_id AND student_id = pen.student_id FOR UPDATE;

  IF s.id IS NULL OR st.id IS NULL OR e.id IS NULL OR b.session_id IS NULL THEN
    RAISE EXCEPTION 'Sesión, alumno, reserva o facturación no encontrados para la incidencia';
  END IF;
  IF pen.sede_id IS DISTINCT FROM s.sede_id OR st.sede_id IS DISTINCT FROM s.sede_id
     OR e.sede_id IS DISTINCT FROM s.sede_id OR b.sede_id IS DISTINCT FROM s.sede_id THEN
    RAISE EXCEPTION 'Inconsistencia de sede entre incidencia/sesión/alumno/reserva/facturación';
  END IF;
  IF pen.state IS DISTINCT FROM 'pending' OR pen.debit_id IS NOT NULL THEN
    RAISE EXCEPTION 'La incidencia no está pendiente (estado=%, débito=%)', pen.state, pen.debit_id;
  END IF;
  IF num_nonnulls(pen.period_id, pen.gift_card_id, pen.manual_credit_id) <> 0
     OR num_nonnulls(e.membership_period_id, e.gift_card_id, e.manual_credit_id) <> 0 THEN
    RAISE EXCEPTION 'La incidencia o la reserva tienen fuente atribuible; usar settle_student_penalty';
  END IF;
  IF NOT (pen.reason LIKE 'Unsupported temporal/manual funding:%'
          OR pen.reason ILIKE '%legacy balance requires attributable%'
          OR pen.reason ILIKE '%Sin derecho original atribuible%') THEN
    RAISE EXCEPTION 'Motivo no es el legacy sin derecho atribuible (reason=%)', pen.reason;
  END IF;
  IF coalesce(st.student_category, 'membresia') NOT IN ('temporal', 'grupal', 'grupo_temporal')
     OR st.current_membership_period_id IS NOT NULL THEN
    RAISE EXCEPTION 'El alumno no es de bono temporal/grupal/grupo temporal (category=%)', st.student_category;
  END IF;
  IF s.completed_at IS NULL OR coalesce(s.attendance_policy_version, 0) <> 2 OR pen.revision > s.revision THEN
    RAISE EXCEPTION 'La sesión debe estar finalizada con policy v2';
  END IF;
  IF b.state IS DISTINCT FROM 'incident' OR b.penalty_id IS DISTINCT FROM pen.id OR b.debit_id IS NOT NULL
     OR b.kind IS DISTINCT FROM pen.kind OR b.finalized_revision > pen.revision THEN
    RAISE EXCEPTION 'La facturación no está en incidencia pendiente para esta incidencia';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_penalty_settlements WHERE penalty_id = pen.id) THEN
    RAISE EXCEPTION 'La incidencia ya tiene liquidación registrada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.session_business_waivers WHERE penalty_id = pen.id) THEN
    RAISE EXCEPTION 'La incidencia ya está eximida';
  END IF;
  IF EXISTS (SELECT 1 FROM public.session_credit_movements m
             WHERE m.session_id = s.id AND m.student_id = st.id AND m.delta = -1
               AND NOT EXISTS (SELECT 1 FROM public.session_credit_movements r WHERE r.reverses_id = m.id)) THEN
    RAISE EXCEPTION 'Ya existe un débito no revertido para esta sesión/alumno; no se descuenta dos veces';
  END IF;
  IF st.classes_remaining IS NULL OR st.classes_remaining < 1 THEN
    RAISE EXCEPTION 'Saldo insuficiente para descontar (classes_remaining=%)', st.classes_remaining;
  END IF;

  v_before := st.classes_remaining;

  BEGIN
    -- 1) Débito escalar: mismo camino que save_session_attendance post-fix26.
    PERFORM private.session_business_adjust_scalar(st.id, -1);
    INSERT INTO public.session_credit_movements(
      session_id, student_id, sede_id, revision, period_id, gift_card_id, manual_credit_id,
      delta, reverses_id, adjustment_id, disposition, created_by
    ) VALUES (
      s.id, st.id, s.sede_id, s.revision + 1, NULL, NULL, NULL,
      -1, NULL, NULL, 'scalar_balance', pen.created_by
    ) RETURNING id INTO v_debit;

    -- 2) Incidencia → charged (igual que las que fix26 crea ya cobradas).
    ALTER TABLE public.session_business_penalties DISABLE TRIGGER guard_business_history;
    UPDATE public.session_business_penalties
       SET state = 'charged', debit_id = v_debit, reason = v_note
     WHERE id = pen.id AND state = 'pending' AND debit_id IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    ALTER TABLE public.session_business_penalties ENABLE TRIGGER guard_business_history;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'Se esperaba actualizar 1 incidencia y se actualizaron %', v_rows; END IF;

    -- 3) Facturación → charged.
    UPDATE public.session_business_billing
       SET state = 'charged', debit_id = v_debit
     WHERE session_id = s.id AND student_id = st.id AND state = 'incident' AND penalty_id = pen.id AND debit_id IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'Se esperaba actualizar 1 facturación y se actualizaron %', v_rows; END IF;

    -- 4) Auditoría (append-only) y revisión de la sesión.
    INSERT INTO public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
    VALUES (s.id, st.id, s.sede_id, s.revision + 1, 'penalty_settled',
      jsonb_build_object('penalty_id', pen.id, 'debit_id', v_debit, 'reason', v_note,
        'original_reason', pen.reason, 'legacy_regularization', true,
        'balance_before', v_before, 'script', 'settle_legacy_unattributed_incidence.sql'),
      pen.created_by);
    UPDATE public.sessions SET revision = revision + 1 WHERE id = s.id RETURNING revision INTO v_rev;

    SELECT classes_remaining INTO v_after FROM public.students WHERE id = st.id;
    IF v_after IS DISTINCT FROM v_before - 1 THEN
      RAISE EXCEPTION 'Saldo inesperado tras el débito: % -> %', v_before, v_after;
    END IF;
    IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.session_business_penalties'::regclass
          AND tgname = 'guard_business_history') <> 'O' THEN
      RAISE EXCEPTION 'El trigger guard_business_history no quedó activo';
    END IF;

    v_summary := jsonb_build_object('penalty_id', pen.id, 'student_id', st.id, 'session_id', s.id,
      'debit_id', v_debit, 'balance_before', v_before, 'balance_after', v_after,
      'session_revision', v_rev, 'note', v_note, 'dry_run', v_dry);

    IF v_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'RDRY1', MESSAGE = 'dry-run rollback';
    END IF;
  EXCEPTION WHEN SQLSTATE 'RDRY1' THEN
    v_summary := v_summary || jsonb_build_object('rolled_back', true);
  END;

  PERFORM set_config('rio.settle_result', v_summary::text, true);
  RAISE NOTICE 'RESULT %', v_summary;
END
$settle$;

SELECT current_setting('rio.settle_result', true) AS result,
  p.state AS penalty_state, p.reason AS penalty_reason, p.debit_id,
  st.classes_remaining, st.bonos_asignados,
  b.state AS billing_state, b.debit_id AS billing_debit_id,
  m.disposition, m.delta,
  (SELECT count(*) FROM public.session_credit_movements x
     WHERE x.session_id = p.session_id AND x.student_id = p.student_id) AS movements_for_session,
  (SELECT count(*) FROM public.session_business_events ev
     WHERE ev.session_id = p.session_id AND ev.student_id = p.student_id AND ev.event = 'penalty_settled'
       AND ev.details->>'legacy_regularization' = 'true') AS legacy_settle_events,
  (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.session_business_penalties'::regclass
     AND tgname = 'guard_business_history') AS guard_enabled
FROM public.session_business_penalties p
JOIN public.students st ON st.id = p.student_id
LEFT JOIN public.session_business_billing b ON b.session_id = p.session_id AND b.student_id = p.student_id
LEFT JOIN public.session_credit_movements m ON m.id = p.debit_id
WHERE p.id = nullif(current_setting('rio.settle_incidence_id', true), '')::uuid;
-- CORE-END

\if :dry_run
ROLLBACK;
\echo 'DRY-RUN: ROLLBACK (sin cambios)'
\else
COMMIT;
\echo 'APLICADO: COMMIT'
\endif
