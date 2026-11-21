-- Aprobar excepción (kind membership_override, the option that still discounts a class)
-- failed for a Bonos de clases student whose payment is pending:
--   new row for relation "session_business_exceptions"
--   violates check constraint "session_business_exceptions_check1"
--
-- That unnamed table check, created second in 20261011230000_session_business_policy.sql,
-- is:
--   check (kind <> 'membership_override' or (period_id is not null and gift_card_id is null))
-- It is the right rule for a membership: the discount must name the period and must not
-- also name a gift card.
--
-- The RPC is what is wrong for a class pack. approve_session_exception inserts
-- session_students.membership_period_id. A bono enrollment has no period. Scalar funding
-- (20261120140000) still marks a positive unpaid pack overridable, so the action accepts
-- membership_override and then the insert hits the check. No row is written, so attendance
-- cannot be finalized with a discount.
--
-- This does not change balances, periods, attendance, or prices. It only lets the same
-- discounting kind be stored when every funding source is null (the class pack). A gift
-- card is still rejected. Finalizing still calls session_business_adjust, which already
-- debits classes_remaining for temporal / grupal / grupo_temporal when the period is null.
--
-- The view change stops a new class pack (bonos_asignados covering classes_remaining)
-- from being offered as "clases anteriores por registrar". An unassigned positive balance
-- stays reconcilable.

begin;

do $$
declare
  old_name text;
begin
  for old_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.session_business_exceptions'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%membership_override%'
      and pg_get_constraintdef(con.oid) ilike '%period_id is not null%'
  loop
    execute format('alter table public.session_business_exceptions drop constraint %I', old_name);
  end loop;
end $$;

alter table public.session_business_exceptions
  drop constraint if exists session_business_exceptions_override_source;

alter table public.session_business_exceptions
  add constraint session_business_exceptions_override_source
  check (
    kind <> 'membership_override'
    or (gift_card_id is null and manual_credit_id is null)
  );

create or replace view public.student_credit_profile with (security_invoker = true) as
select st.id as student_id, st.sede_id, st.classes_remaining as legacy_observed_balance,
  to_jsonb(st) as legacy_raw_state,
  coalesce((select jsonb_agg(to_jsonb(c) order by c.approved_at, c.entitlement_id)
    from public.manual_credit_entitlements_with_balance c where c.student_id = st.id and c.sede_id = st.sede_id), '[]'::jsonb) as manual_credits,
  coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at, p.penalty_id)
    from public.session_pending_penalties p where p.student_id = st.id and p.sede_id = st.sede_id), '[]'::jsonb) as penalty_incidents,
  private.session_employee_sede(st.sede_id)
    and exists (select 1 from public.sedes t where t.id = st.sede_id and t.owner_id = auth.uid()) as can_approve_manual_credit,
  private.session_employee_sede(st.sede_id)
    and exists (select 1 from public.sedes t where t.id = st.sede_id and t.owner_id = auth.uid())
    and st.classes_remaining is not null and st.classes_remaining > 0
    and coalesce(st.student_category, 'membresia') <> 'membresia' and st.current_membership_period_id is null
    and not exists (select 1 from public.student_membership_periods p where p.student_id = st.id)
    and not private.manual_legacy_gift_ambiguous(st.id)
    and not exists (select 1 from public.student_manual_credit_entitlements c
      where c.student_id = st.id and c.mode = 'reconcile_legacy')
    and (
      st.bonos_asignados is null
      or st.bonos_asignados <= 0
      or st.classes_remaining > st.bonos_asignados
    ) as can_reconcile_legacy
from public.students st where private.session_business_read_sede(st.sede_id);

commit;
