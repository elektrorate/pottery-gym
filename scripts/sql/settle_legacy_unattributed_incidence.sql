-- =============================================================================
-- ONE-OFF: regularizar incidencia legacy «Sin derecho original atribuible»
-- (Unsupported temporal/manual funding …) con el path scalar_pack de PR #26.
--
-- NO ES UNA MIGRACIÓN. No ejecutar contra producción (ilkrcakrduibgsfqfzti)
-- sin revisión humana explícita y backup. Preferir staging / réplica.
--
-- Uso (psql):
--   # Dry-run (por defecto): plan + verification + ROLLBACK
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 \
--     -v incidence_id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' \
--     -f scripts/sql/settle_legacy_unattributed_incidence.sql
--
--   # Aplicar:
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 \
--     -v incidence_id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' \
--     -v dry_run=0 \
--     -f scripts/sql/settle_legacy_unattributed_incidence.sql
--
-- Variables:
--   incidence_id  (obligatoria) UUID de public.session_business_penalties.id
--   dry_run       (opcional) 1 = solo plan + rollback (default); 0 = commit
-- =============================================================================

\set ON_ERROR_STOP on

\if :{?incidence_id}
\else
\echo 'ERROR: pasa -v incidence_id=<uuid> de la incidencia a regularizar'
\quit 1
\endif

\if :{?dry_run}
\else
\set dry_run 1
\endif

\echo '=== settle_legacy_unattributed_incidence ==='
\echo 'incidence_id =' :incidence_id
\echo 'dry_run      =' :dry_run

BEGIN;

DO $settle$
DECLARE
  v_penalty_id uuid := :'incidence_id'::uuid;
  v_dry boolean := (NULLIF(btrim(:'dry_run'::text), '') IS DISTINCT FROM '0');
  pen public.session_business_penalties%ROWTYPE;
  s public.sessions%ROWTYPE;
  e public.session_students%ROWTYPE;
  st public.students%ROWTYPE;
  b public.session_business_billing%ROWTYPE;
  existing_debit public.session_credit_movements%ROWTYPE;
  debit_id uuid;
  balance_before integer;
  balance_after integer;
  note text := 'Regularización falta previa a fix26';
  legacy_reason_ok boolean;
  actor uuid;
BEGIN
  SELECT * INTO pen FROM public.session_business_penalties WHERE id = v_penalty_id;
  IF pen.id IS NULL THEN
    RAISE EXCEPTION 'Incidencia % no encontrada', v_penalty_id;
  END IF;

  -- Lock order mirrors settle_student_penalty: session first, then student/roster.
  SELECT * INTO s FROM public.sessions WHERE id = pen.session_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Sesión % no encontrada para la incidencia', pen.session_id;
  END IF;

  SELECT * INTO st FROM public.students WHERE id = pen.student_id FOR UPDATE;
  SELECT * INTO e FROM public.session_students
    WHERE session_id = s.id AND student_id = pen.student_id FOR UPDATE;
  SELECT * INTO b FROM public.session_business_billing
    WHERE session_id = s.id AND student_id = pen.student_id;

  IF e.id IS NULL OR st.id IS NULL THEN
    RAISE EXCEPTION 'Alumno/roster no encontrados para la incidencia';
  END IF;

  actor := pen.created_by;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'La incidencia no tiene created_by auditable';
  END IF;

  legacy_reason_ok :=
    pen.reason LIKE 'Unsupported temporal/manual funding:%'
    OR pen.reason ILIKE '%legacy balance requires attributable%'
    OR pen.reason ILIKE '%Sin derecho original atribuible%';

  IF pen.state IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'La incidencia no está pending (estado=%)', pen.state;
  END IF;
  IF pen.debit_id IS NOT NULL THEN
    RAISE EXCEPTION 'La incidencia ya tiene debit_id=%', pen.debit_id;
  END IF;
  IF num_nonnulls(pen.period_id, pen.gift_card_id, pen.manual_credit_id) <> 0 THEN
    RAISE EXCEPTION 'La incidencia ya tiene fuente atribuible; no es el caso legacy';
  END IF;
  IF NOT legacy_reason_ok THEN
    RAISE EXCEPTION 'Motivo no es el legacy unattributed (reason=%)', pen.reason;
  END IF;
  IF coalesce(st.student_category, 'membresia') NOT IN ('temporal', 'grupal', 'grupo_temporal') THEN
    RAISE EXCEPTION 'El alumno no es temporal/grupal/grupo_temporal (category=%)', st.student_category;
  END IF;
  IF st.sede_id IS DISTINCT FROM s.sede_id OR pen.sede_id IS DISTINCT FROM s.sede_id THEN
    RAISE EXCEPTION 'Inconsistencia de sede entre incidencia/sesión/alumno';
  END IF;
  IF b.session_id IS NULL OR b.state IS DISTINCT FROM 'incident'
     OR b.penalty_id IS DISTINCT FROM pen.id OR b.debit_id IS NOT NULL THEN
    RAISE EXCEPTION 'Billing no está en incident pendiente para esta incidencia';
  END IF;
  IF s.completed_at IS NULL OR coalesce(s.attendance_policy_version, 0) <> 2 THEN
    RAISE EXCEPTION 'La sesión debe estar finalizada con policy v2';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_penalty_settlements WHERE penalty_id = pen.id) THEN
    RAISE EXCEPTION 'La incidencia ya tiene liquidación registrada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.session_business_waivers WHERE penalty_id = pen.id) THEN
    RAISE EXCEPTION 'La incidencia ya está eximida';
  END IF;

  -- Idempotencia: reutilizar un débito existente no revertido de esta sesión/alumno.
  SELECT m.* INTO existing_debit
  FROM public.session_credit_movements m
  WHERE m.session_id = s.id AND m.student_id = st.id AND m.delta = -1
    AND NOT EXISTS (
      SELECT 1 FROM public.session_credit_movements r WHERE r.reverses_id = m.id
    )
  ORDER BY m.created_at ASC
  LIMIT 1;

  balance_before := st.classes_remaining;

  RAISE NOTICE 'PLAN incidence=% session=% student=% category=% kind=%',
    pen.id, s.id, st.id, st.student_category, pen.kind;
  RAISE NOTICE 'PLAN reason=%', left(pen.reason, 160);
  RAISE NOTICE 'PLAN balance_before=% existing_debit=% dry_run=%',
    balance_before, existing_debit.id, v_dry;

  IF existing_debit.id IS NOT NULL THEN
    debit_id := existing_debit.id;
    RAISE NOTICE 'PLAN: reutilizar débito existente % (sin nuevo descuento de saldo)', debit_id;
  ELSE
    IF st.classes_remaining IS NULL OR st.classes_remaining < 1 THEN
      RAISE EXCEPTION 'Saldo escalar insuficiente para descontar (classes_remaining=%)', st.classes_remaining;
    END IF;
    RAISE NOTICE 'PLAN: descontar 1 clase vía private.session_business_adjust_scalar + ledger scalar_balance';
  END IF;

  IF v_dry THEN
    RAISE NOTICE 'DRY-RUN: sin escrituras. Verification verá el estado actual; luego ROLLBACK.';
    RAISE NOTICE 'DRY-RUN would set penalty.state=charged, billing.state=charged, reason=%', note;
    RETURN;
  END IF;

  IF existing_debit.id IS NULL THEN
    -- Mismo path que save_session_attendance post-PR#26 para packs escalares:
    -- adjust_scalar(-1) y movimiento con disposition current_period (trigger → scalar_balance).
    PERFORM private.session_business_adjust_scalar(st.id, -1);
    INSERT INTO public.session_credit_movements(
      session_id, student_id, sede_id, revision,
      period_id, gift_card_id, manual_credit_id,
      delta, adjustment_id, disposition, created_by
    ) VALUES (
      s.id, st.id, s.sede_id, s.revision + 1,
      NULL, NULL, NULL,
      -1, NULL, 'current_period', actor
    ) RETURNING id INTO debit_id;
  END IF;

  UPDATE public.session_business_penalties
  SET state = 'charged',
      debit_id = debit_id,
      reason = note
  WHERE id = pen.id;

  UPDATE public.session_business_billing
  SET state = 'charged',
      debit_id = debit_id
  WHERE session_id = s.id AND student_id = st.id;

  INSERT INTO public.session_business_events(
    session_id, student_id, sede_id, revision, event, details, actor_id
  ) VALUES (
    s.id, st.id, s.sede_id, s.revision + 1, 'penalty_settled',
    jsonb_build_object(
      'penalty_id', pen.id,
      'debit_id', debit_id,
      'reason', note,
      'legacy_regularization', true,
      'script', 'settle_legacy_unattributed_incidence.sql'
    ),
    actor
  );

  UPDATE public.sessions SET revision = revision + 1 WHERE id = s.id;

  SELECT classes_remaining INTO balance_after FROM public.students WHERE id = st.id;
  RAISE NOTICE 'APPLIED debit=% balance % -> % reason=%', debit_id, balance_before, balance_after, note;
END;
$settle$;

\echo '=== verification (misma transacción; dry-run aún no ha hecho commit) ==='
SELECT
  p.id AS penalty_id,
  p.state AS penalty_state,
  p.reason AS penalty_reason,
  p.debit_id,
  p.kind,
  st.student_category,
  st.classes_remaining,
  b.state AS billing_state,
  b.debit_id AS billing_debit_id,
  m.id AS movement_id,
  m.disposition,
  m.delta,
  EXISTS (
    SELECT 1 FROM public.session_credit_movements r WHERE r.reverses_id = m.id
  ) AS movement_reversed,
  (SELECT count(*) FROM public.session_business_events ev
     WHERE ev.session_id = p.session_id AND ev.student_id = p.student_id
       AND ev.event = 'penalty_settled'
       AND ev.details->>'legacy_regularization' = 'true') AS legacy_settle_events
FROM public.session_business_penalties p
JOIN public.students st ON st.id = p.student_id
LEFT JOIN public.session_business_billing b
  ON b.session_id = p.session_id AND b.student_id = p.student_id
LEFT JOIN public.session_credit_movements m ON m.id = p.debit_id
WHERE p.id = :'incidence_id'::uuid;

-- dry_run=1 (default) → ROLLBACK; dry_run=0 → COMMIT
\if :dry_run
ROLLBACK;
\echo 'DRY-RUN complete: ROLLBACK (no changes persisted)'
\else
COMMIT;
\echo 'APPLIED: COMMIT'
\endif
