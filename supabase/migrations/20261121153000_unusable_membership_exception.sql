-- Owner exception for a membership that is pending, expired, or does not cover the session.
-- Does not rewrite balances, periods, or attendance. Function replace only.
--
-- Deadlock this removes (past session, current Gold period starts after that date,
-- payment pending, classes_remaining still positive — the same column the credit
-- profile shows as the legacy observed balance):
--   * finalize stays blocked because the period is not usable (no silent deduction);
--   * membership_override was rejected because overridable required the period to
--     have already started by the session date;
--   * no_credit was rejected because any positive classes_remaining counted as
--     available credit, even when that credit was unpaid or did not cover the date.
--
-- Widened approvals are owner-only, require a non-blank reason (enforced by the
-- existing action), and never mark the membership usable. A paid membership that
-- covers the session still finalizes normally and still rejects both exceptions.
-- Archived students and unattributed scalar balances stay fail-closed.

begin;

do $$
begin
  if to_regprocedure('private.session_business_funding_before_unusable_exception(uuid,uuid)') is null then
    alter function private.session_business_funding(uuid, uuid)
      rename to session_business_funding_before_unusable_exception;
  end if;
end $$;

create or replace function private.session_business_funding(
  p_session_id uuid, p_student_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  s public.sessions;
  e public.session_students;
  st public.students;
  p public.student_membership_periods;
  funding jsonb;
  session_date date;
  session_activity text;
  covers boolean;
  paid boolean;
  due_successor boolean;
  positive boolean;
  ordinarily_usable boolean;
  other_credit boolean;
  widened_override boolean := false;
  widened_courtesy boolean := false;
begin
  funding := private.session_business_funding_before_unusable_exception(p_session_id, p_student_id);
  select * into s from public.sessions where id = p_session_id;
  select * into e from public.session_students where session_id = s.id and student_id = p_student_id;
  select * into st from public.students where id = p_student_id;
  if s.id is null or e.id is null or st.id is null then return funding; end if;
  -- Gift and manual enrollments keep their own contracts. Scalar packs too.
  if e.gift_card_id is not null or e.manual_credit_id is not null then return funding; end if;
  if coalesce(st.student_category, 'membresia') <> 'membresia' or st.archived_at is not null then return funding; end if;
  -- A paid membership that covers the session is ordinary funding, not an exception.
  if coalesce((funding->>'usable')::boolean, false) then return funding; end if;

  select * into p from public.student_membership_periods
    where id = e.membership_period_id and student_id = st.id and sede_id = s.sede_id;
  positive := p.id is not null
    and p.id = st.current_membership_period_id
    and st.classes_remaining is not null
    and st.classes_remaining > 0
    and p.allocated_classes is not null
    and st.classes_remaining <= p.allocated_classes
    and p.starts_on is not null
    and p.ends_on is not null;
  if not positive then return funding; end if;

  session_date := private.atomic_session_date(s.date, s.start_time, s.end_time);
  if s.class_type = 'mixto' then
    session_activity := private.mixed_activity(p_session_id, p_student_id)->>'activity_type';
  else
    session_activity := s.class_type;
  end if;
  covers := p.starts_on <= least(session_date, private.membership_today())
    and p.ends_on >= greatest(session_date, private.membership_today());
  paid := p.payment_status = 'paid';
  due_successor := exists (
    select 1 from public.student_membership_periods successor
    where successor.predecessor_id = st.current_membership_period_id
      and successor.starts_on <= private.membership_today());
  ordinarily_usable := paid and covers and not due_successor;

  -- Known positive current-period credit can be consumed by an explicit override
  -- even when the period starts after this session (it does not cover the date).
  -- Pending and expired periods that already started stay overridable from the
  -- inner function and do not become owner-gated by this wrapper.
  if not coalesce((funding->>'overridable')::boolean, false) then
    funding := jsonb_set(funding, '{overridable}', to_jsonb(true));
    widened_override := true;
  end if;

  -- Courtesy must still not dodge a gift, a manual credit, or a paid covering
  -- period (including one blocked only by a queued successor). It may bypass a
  -- membership whose only balance is unpaid, expired, or outside the session date.
  other_credit := exists (
    select 1 from public.manual_credit_entitlements_with_balance mc
    where mc.student_id = st.id and mc.sede_id = s.sede_id and mc.remaining_classes > 0
      and mc.activity = session_activity
      and mc.starts_on <= least(session_date, private.membership_today())
      and mc.ends_on >= greatest(session_date, private.membership_today())
  ) or exists (
    select 1 from public.gift_cards card
    where card.recipient_student_id = st.id and card.sede_id = s.sede_id
      and card.payment_status = 'paid' and card.status in ('active', 'pending')
      and card.num_classes > card.sessions_used
      and card.expiry_date >= greatest(session_date, private.membership_today())
      and session_activity = case when card.type = 'torno' then 'torno' when card.type = 'modelado' then 'mesa' end
  );
  if not ordinarily_usable and not due_successor and not other_credit
     and not coalesce((funding->>'no_credit_allowed')::boolean, false) then
    funding := jsonb_set(funding, '{no_credit_allowed}', to_jsonb(true));
    widened_courtesy := true;
  end if;

  funding := jsonb_set(funding, '{override_requires_owner}', to_jsonb(widened_override));
  funding := jsonb_set(funding, '{courtesy_requires_owner}', to_jsonb(widened_courtesy));
  return funding;
end $$;

do $$
begin
  if to_regprocedure('private.session_business_action_before_unusable_exception(uuid,uuid,uuid,bigint,text,text,text)') is null then
    alter function private.session_business_action(uuid, uuid, uuid, bigint, text, text, text)
      rename to session_business_action_before_unusable_exception;
  end if;
end $$;

create or replace function private.session_business_action(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_operation text, p_kind text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions;
  funding jsonb;
begin
  if p_operation = 'approve_session_exception' and p_kind in ('membership_override', 'no_credit') then
    s := private.lock_atomic_session(p_session_id);
    if not private.session_employee_sede(s.sede_id) then
      raise exception 'Session not accessible' using errcode = '42501';
    end if;
    funding := private.session_business_funding(p_session_id, p_student_id);
    if ((p_kind = 'membership_override' and coalesce((funding->>'override_requires_owner')::boolean, false))
        or (p_kind = 'no_credit' and coalesce((funding->>'courtesy_requires_owner')::boolean, false)))
       and not private.manual_credit_owner(s.sede_id) then
      raise exception 'Only this workshop owner may approve an exception when the original membership is unpaid, expired or does not cover the session'
        using errcode = '42501';
    end if;
  end if;
  return private.session_business_action_before_unusable_exception(
    p_session_id, p_student_id, p_request_key, p_expected_revision, p_operation, p_kind, p_reason);
end $$;

-- SQL wrappers bind the function OID at create time. Rebind them to this action.
create or replace function public.approve_session_exception(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint, p_kind text, p_reason text
) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'approve_session_exception', p_kind, p_reason);
$$;
create or replace function public.cancel_session_reservation(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint, p_reason text
) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'cancel_session_reservation', null, p_reason);
$$;
create or replace function public.waive_session_penalty(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint, p_reason text
) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'waive_session_penalty', null, p_reason);
$$;

revoke all on function private.session_business_funding(uuid, uuid),
  private.session_business_funding_before_unusable_exception(uuid, uuid),
  private.session_business_action(uuid, uuid, uuid, bigint, text, text, text),
  private.session_business_action_before_unusable_exception(uuid, uuid, uuid, bigint, text, text, text)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
