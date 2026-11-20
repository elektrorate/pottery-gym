-- Attributable scalar funding for temporal / grupal / grupo_temporal students.
-- Backwards-compatible: membership, gift-card and manual-credit paths unchanged.
-- Idempotent: safe to re-run (create or replace / drop-if-exists patterns).

-- 1) Allow ledger rows funded by the student scalar pack balance.
alter table public.session_credit_movements
  drop constraint if exists session_credit_movements_disposition_check;
alter table public.session_credit_movements
  add constraint session_credit_movements_disposition_check
  check (disposition in (
    'current_period', 'original_period_credit', 'gift_card', 'manual_credit', 'scalar_balance'
  ));

alter table public.session_credit_movements
  drop constraint if exists session_credit_source_exclusive;
alter table public.session_credit_movements
  add constraint session_credit_source_exclusive
  check (
    (disposition = 'scalar_balance' and num_nonnulls(period_id, gift_card_id, manual_credit_id) = 0)
    or (disposition <> 'scalar_balance' and num_nonnulls(period_id, gift_card_id, manual_credit_id) = 1)
  );

-- Rewrite accidental current_period inserts that have no source IDs (scalar pack debits).
create or replace function private.normalize_scalar_credit_disposition()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.period_id is null and new.gift_card_id is null and new.manual_credit_id is null
     and new.disposition is distinct from 'scalar_balance' then
    new.disposition := 'scalar_balance';
  end if;
  return new;
end $$;

drop trigger if exists normalize_scalar_credit_disposition on public.session_credit_movements;
create trigger normalize_scalar_credit_disposition
  before insert or update on public.session_credit_movements
  for each row execute function private.normalize_scalar_credit_disposition();

-- 2) Scalar pack adjust: decrement/increment students.classes_remaining without a membership period.
create or replace function private.session_business_adjust_scalar(
  p_student_id uuid, p_delta integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare st public.students;
begin
  select * into st from public.students where id = p_student_id for update;
  if st.id is null
     or coalesce(st.student_category, 'membresia') not in ('temporal', 'grupal', 'grupo_temporal')
     or st.classes_remaining is null
     or p_delta not in (-1, 1)
     or st.classes_remaining + p_delta < 0
     or (st.bonos_asignados is not null and st.classes_remaining + p_delta > st.bonos_asignados) then
    raise exception 'Original scalar pack balance requires reconciliation';
  end if;
  update public.students
    set classes_remaining = classes_remaining + p_delta
  where id = st.id;
  return null;
end $$;

revoke all on function private.session_business_adjust_scalar(uuid, integer)
  from public, anon, authenticated, service_role;

-- Extend period adjust: null period + pack category uses scalar balance.
create or replace function private.session_business_adjust(
  p_student_id uuid, p_period_id uuid, p_delta integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare st public.students; allocation integer; adjustment_id uuid;
begin
  select * into st from public.students where id = p_student_id for update;
  if p_period_id is null
     and coalesce(st.student_category, 'membresia') in ('temporal', 'grupal', 'grupo_temporal') then
    return private.session_business_adjust_scalar(p_student_id, p_delta);
  end if;
  select allocated_classes into allocation from public.student_membership_periods
    where id = p_period_id and student_id = st.id and sede_id = st.sede_id;
  if st.current_membership_period_id is distinct from p_period_id or st.classes_remaining is null
    or allocation is null or p_delta not in (-1, 1) or st.classes_remaining + p_delta not between 0 and allocation then
    raise exception 'Original current membership balance requires reconciliation';
  end if;
  update public.students set classes_remaining = classes_remaining + p_delta where id = st.id;
  insert into public.student_membership_class_adjustments(student_id, sede_id, period_id, request_key,
    expected_balance, delta, resulting_balance, adjusted_by)
    values (st.id, st.sede_id, p_period_id, gen_random_uuid(), st.classes_remaining, p_delta,
      st.classes_remaining + p_delta, auth.uid()) returning id into adjustment_id;
  return adjustment_id;
end $$;

-- 3) Wrap funding: attribute positive scalar pack balances for temporal/grupal/grupo_temporal.
do $$
begin
  if to_regprocedure('private.session_business_funding_before_scalar_pack(uuid,uuid)') is null then
    alter function private.session_business_funding(uuid, uuid)
      rename to session_business_funding_before_scalar_pack;
  end if;
end $$;

create or replace function private.session_business_funding(
  p_session_id uuid, p_student_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  s public.sessions; e public.session_students; st public.students;
  funding jsonb; session_date date; expiry_day date;
  positive boolean; usable boolean; overridable boolean;
begin
  funding := private.session_business_funding_before_scalar_pack(p_session_id, p_student_id);
  select * into s from public.sessions where id = p_session_id;
  select * into e from public.session_students where session_id = s.id and student_id = p_student_id;
  select * into st from public.students where id = p_student_id;
  if e.id is null or st.id is null then return funding; end if;
  -- Explicit gift / period / manual sources keep the previous contract.
  if e.gift_card_id is not null or e.membership_period_id is not null or e.manual_credit_id is not null then
    return funding;
  end if;
  if coalesce(st.student_category, 'membresia') not in ('temporal', 'grupal', 'grupo_temporal') then
    return funding;
  end if;
  -- Unknown scalar observation stays unattributed (null balance).
  if st.classes_remaining is null then return funding; end if;

  session_date := private.atomic_session_date(s.date, s.start_time, s.end_time);
  expiry_day := case
    when st.expiry_date is null then null
    else (timezone('Europe/Madrid', st.expiry_date))::date
  end;
  positive := st.classes_remaining > 0;
  overridable := positive and st.archived_at is null
    and (expiry_day is null or expiry_day >= least(session_date, private.membership_today()));
  usable := overridable and st.payment_status = 'paid'
    and (expiry_day is null or expiry_day >= greatest(session_date, private.membership_today()));

  funding := jsonb_build_object(
    'usable', coalesce(usable, false),
    'overridable', coalesce(overridable, false),
    'no_credit_allowed', not positive,
    'period_id', null,
    'gift_card_id', null,
    'manual_credit_id', null,
    'snapshot', jsonb_build_object(
      'funding_kind', 'scalar_pack',
      'balance', st.classes_remaining,
      'bonos_asignados', st.bonos_asignados,
      'payment_status', st.payment_status,
      'expiry_date', expiry_day,
      'student_category', st.student_category,
      'archived_at', st.archived_at,
      'session_date', s.date,
      'start_time', s.start_time,
      'end_time', s.end_time,
      'class_type', s.class_type
    ),
    'reason', case
      when not positive then 'Original scalar pack has no known positive balance'
      when st.archived_at is not null then 'Original scalar pack student is archived'
      when expiry_day is not null and expiry_day < greatest(session_date, private.membership_today())
        then 'Original scalar pack is expired for the session'
      when st.payment_status is distinct from 'paid'
        then 'Original scalar pack payment is unpaid or unknown'
      else 'Original scalar pack is not usable'
    end
  );

  -- A courtesy must not dodge another attributable gift or manual credit still available.
  if exists (
    select 1 from public.gift_cards card
    where card.recipient_student_id = st.id and card.sede_id = s.sede_id
      and card.payment_status = 'paid' and card.status in ('active', 'pending')
      and card.num_classes > card.sessions_used
      and card.activated_at <= session_date
      and card.expiry_date >= greatest(session_date, private.membership_today())
      and s.class_type = case when card.type = 'torno' then 'torno' when card.type = 'modelado' then 'mesa' end
  ) or exists (
    select 1 from public.manual_credit_entitlements_with_balance mc
    where mc.student_id = st.id and mc.sede_id = s.sede_id and mc.remaining_classes > 0
      and mc.activity = s.class_type
      and mc.starts_on <= least(session_date, private.membership_today())
      and mc.ends_on >= greatest(session_date, private.membership_today())
  ) then
    funding := jsonb_set(funding, '{no_credit_allowed}', 'false');
  end if;

  return funding;
end $$;

revoke all on function private.session_business_funding(uuid, uuid),
  private.session_business_funding_before_scalar_pack(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.session_business_funding(uuid, uuid) to authenticated;

-- Keep reservation is_temporary flag consistent for pack categories (idempotent replace of insert helper is not needed;
-- reservation already works; funding/attendance are the operational blockers).
