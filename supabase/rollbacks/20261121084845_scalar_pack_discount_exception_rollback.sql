-- This rollback fails if membership_override rows with period_id NULL exist; those must be handled first.
-- Rollback for 20261121084845_scalar_pack_discount_exception.sql
-- Restores the membership-override check that requires a period, and the previous
-- credit-profile flag. Does not rewrite student, session, or exception rows.
-- After this rollback, approving a discounting exception for a class pack fails again
-- with session_business_exceptions_check1 (or the restored check of the same definition).

begin;

alter table public.session_business_exceptions
  drop constraint if exists session_business_exceptions_override_source;

alter table public.session_business_exceptions
  drop constraint if exists session_business_exceptions_check1;

alter table public.session_business_exceptions
  add constraint session_business_exceptions_check1
  check (kind <> 'membership_override' or (period_id is not null and gift_card_id is null));

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
      where c.student_id = st.id and c.mode = 'reconcile_legacy') as can_reconcile_legacy
from public.students st where private.session_business_read_sede(st.sede_id);

commit;
