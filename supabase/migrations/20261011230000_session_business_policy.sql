-- ISSUE8 rollout gate: only newly created sessions opt in. No historical rebilling.
begin;

alter table public.sessions add column attendance_policy_version smallint not null default 1
  constraint sessions_attendance_policy_version_check check (attendance_policy_version in (1, 2));
alter table public.sessions alter column attendance_policy_version set default 2;
alter table public.session_students
  add column cancelled_at timestamptz,
  add column cancellation_kind text,
  add column cancellation_reason text,
  add column cancelled_by uuid,
  add constraint session_cancellation_complete check (
    (cancelled_at is null and cancellation_kind is null and cancellation_reason is null and cancelled_by is null)
    or (cancelled_at is not null and isfinite(cancelled_at) and cancellation_kind is not null and cancellation_kind in ('timely', 'late')
      and cancellation_reason is not null and cancellation_reason ~ '[^[:space:]]'
      and length(cancellation_reason) <= 2000 and cancelled_by is not null));

alter table public.session_operation_receipts drop constraint session_operation_receipts_operation_check;
alter table public.session_operation_receipts add constraint session_operation_receipts_operation_check
  check (operation in ('attendance', 'reservation', 'approve_session_exception',
    'cancel_session_reservation', 'waive_session_penalty'));

create table public.session_business_exceptions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  student_id uuid not null,
  sede_id uuid not null,
  revision bigint not null,
  kind text not null check (kind in ('membership_override', 'no_credit')),
  period_id uuid,
  gift_card_id uuid references public.gift_cards(id) on delete restrict,
  funding_snapshot jsonb not null,
  reason text not null check (reason ~ '[^[:space:]]' and length(reason) <= 2000),
  approved_by uuid not null,
  approved_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, student_id) references public.session_students(session_id, student_id) on delete restrict,
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict,
  foreign key (student_id, period_id) references public.student_membership_periods(student_id, id) on delete restrict,
  check (period_id is null or gift_card_id is null),
  check (kind <> 'membership_override' or (period_id is not null and gift_card_id is null))
);
alter table public.session_students add column business_exception_id uuid
  references public.session_business_exceptions(id) on delete restrict;

create table public.session_business_penalties (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  student_id uuid not null,
  sede_id uuid not null,
  revision bigint not null,
  kind text not null check (kind in ('no_show', 'late_cancellation')),
  state text not null check (state in ('charged', 'pending')),
  reason text not null check (length(btrim(reason)) > 0),
  period_id uuid,
  gift_card_id uuid references public.gift_cards(id) on delete restrict,
  debit_id uuid unique references public.session_credit_movements(id) on delete restrict,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (session_id, student_id),
  foreign key (session_id, student_id) references public.session_students(session_id, student_id) on delete restrict,
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict,
  foreign key (student_id, period_id) references public.student_membership_periods(student_id, id) on delete restrict,
  check (period_id is null or gift_card_id is null),
  check ((state = 'charged') = (debit_id is not null))
);
create table public.session_business_waivers (
  penalty_id uuid primary key references public.session_business_penalties(id) on delete restrict,
  session_id uuid not null,
  student_id uuid not null,
  sede_id uuid not null,
  revision bigint not null,
  reason text not null check (reason ~ '[^[:space:]]' and length(reason) <= 2000),
  reversal_id uuid unique references public.session_credit_movements(id) on delete restrict,
  waived_by uuid not null,
  waived_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, student_id) references public.session_students(session_id, student_id) on delete restrict,
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict
);
create table public.session_business_billing (
  session_id uuid not null,
  student_id uuid not null,
  sede_id uuid not null,
  state text not null check (state in ('charged', 'no_charge', 'incident', 'waived')),
  kind text not null check (kind in ('attendance', 'no_show', 'late_cancellation', 'timely_cancellation', 'courtesy')),
  exception_id uuid references public.session_business_exceptions(id) on delete restrict,
  debit_id uuid unique references public.session_credit_movements(id) on delete restrict,
  penalty_id uuid unique references public.session_business_penalties(id) on delete restrict,
  finalized_revision bigint not null,
  primary key (session_id, student_id),
  foreign key (session_id, student_id) references public.session_students(session_id, student_id) on delete restrict,
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict,
  check ((state = 'charged') = (debit_id is not null)),
  check (state not in ('incident', 'waived') or penalty_id is not null)
);
create table public.session_business_events (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  student_id uuid,
  sede_id uuid not null,
  revision bigint not null,
  event text not null check (event in ('exception_approved', 'reservation_cancelled', 'billing_finalized',
    'attendance_corrected', 'penalty_waived')),
  details jsonb not null,
  actor_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict
);

-- Reads retain the shipped global super-admin scope; business writes require
-- an actual workshop employee. Integration identities never get either scope.
create function private.session_business_read_sede(p_sede_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.role() is not distinct from 'authenticated'
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('tallerista', 'staff', 'super_admin'))
    and not exists (select 1 from private.domain_read_principals where user_id = auth.uid() and kind = 'integration')
    and private.can_access_sede(p_sede_id);
$$;
create function private.session_employee_sede(p_sede_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.session_business_read_sede(p_sede_id)
    and exists (select 1 from public.sedes t where t.id = p_sede_id and t.is_active is true
      and (t.owner_id = auth.uid() or exists (select 1 from public.sede_members m
        where m.sede_id = t.id and m.user_id = auth.uid() and m.role in ('tallerista', 'staff', 'super_admin'))));
$$;

-- Global administrators keep metadata/read scope, not ownership escalation.
create function private.guard_sede_financial_owner() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id
    and current_user <> pg_get_userbyid((select relowner from pg_class where oid = tg_relid)) then
    if current_user = 'authenticated' then
      if old.owner_id is not distinct from auth.uid() and private.session_employee_sede(old.id) then return new; end if;
    end if;
    raise exception 'Only the current workshop owner may transfer ownership' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_sede_financial_owner before update on public.sedes
  for each row execute function private.guard_sede_financial_owner();
-- USING still admits only the old owner/global admin; the trigger checks any
-- owner change against OLD, so a legitimate transfer can pass the new-row check.
alter policy sedes_update_owner_or_super_admin on public.sedes with check (true);

do $$
declare tab text;
begin
  foreach tab in array array['session_business_exceptions', 'session_business_penalties', 'session_business_waivers',
    'session_business_billing', 'session_business_events'] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', tab);
    execute format('grant select on public.%I to authenticated', tab);
    execute format('create policy business_employee_read on public.%I for select to authenticated using (private.session_business_read_sede(sede_id))', tab);
    if tab <> 'session_business_billing' then
      execute format('create trigger guard_business_history before insert or update or delete on public.%I for each row execute function private.guard_session_history()', tab);
    end if;
  end loop;
end $$;
revoke all on sequence public.session_business_events_id_seq from public, anon, authenticated, service_role;
create policy session_business_employee_read on public.sessions as restrictive for select to authenticated
  using (private.session_business_read_sede(sede_id));
create policy session_business_employee_read on public.session_students as restrictive for select to authenticated
  using (private.session_business_read_sede(sede_id));
create policy session_business_employee_read on public.session_operation_receipts as restrictive for select to authenticated
  using (private.session_business_read_sede(sede_id));
create policy session_business_employee_read on public.session_credit_movements as restrictive for select to authenticated
  using (private.session_business_read_sede(sede_id));

create function private.guard_session_business_projection() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user <> pg_get_userbyid((select relowner from pg_class where oid = tg_relid)) then
    raise exception 'Session business state is server-managed' using errcode = '42501';
  end if;
  if tg_table_name = 'sessions' then
    if new.attendance_policy_version is distinct from old.attendance_policy_version then
      raise exception 'Attendance policy version is immutable';
    end if;
    if old.attendance_policy_version = 2 and old.completed_at is not null and new.completed_at is null then
      raise exception 'Finalized policy2 sessions cannot reopen';
    end if;
  elsif tg_table_name = 'session_students' then
    if tg_op = 'DELETE' then
      if old.cancelled_at is not null or exists (select 1 from public.sessions
        where id = old.session_id and attendance_policy_version = 2) then
        raise exception 'Policy2 reservation history cannot be deleted';
      end if;
      return old;
    end if;
    if old.cancelled_at is not null then
      if new.cancelled_at is distinct from old.cancelled_at or new.cancellation_kind is distinct from old.cancellation_kind
        or new.cancellation_reason is distinct from old.cancellation_reason or new.cancelled_by is distinct from old.cancelled_by
        or new.gift_card_id is distinct from old.gift_card_id or new.membership_period_id is distinct from old.membership_period_id then
        raise exception 'Cancellation and its original funding are immutable';
      end if;
    end if;
    if exists (select 1 from public.sessions where id = old.session_id and attendance_policy_version = 2) then
      if new.id is distinct from old.id or new.session_id is distinct from old.session_id
        or new.student_id is distinct from old.student_id or new.sede_id is distinct from old.sede_id then
        raise exception 'Policy2 enrollment identity is immutable';
      end if;
      if exists (select 1 from public.sessions where id = old.session_id and completed_at is not null)
        and (new.gift_card_id is distinct from old.gift_card_id or new.membership_period_id is distinct from old.membership_period_id
          or new.business_exception_id is distinct from old.business_exception_id) then
        raise exception 'Finalized roster and original funding are locked';
      end if;
    end if;
  elsif tg_op = 'DELETE' then
    raise exception 'Session business state cannot be deleted';
  end if;
  return new;
end $$;
create trigger guard_business_session before update on public.sessions
  for each row execute function private.guard_session_business_projection();
create trigger guard_business_roster before update or delete on public.session_students
  for each row execute function private.guard_session_business_projection();
create trigger guard_business_billing before insert or update or delete on public.session_business_billing
  for each row execute function private.guard_session_business_projection();

-- Validate both wall-clock endpoints, including the repeated autumn hour.
create function private.session_madrid_instant(p_wall timestamptz) returns timestamptz
language plpgsql stable security invoker set search_path = '' as $$
declare wall timestamp := p_wall at time zone 'UTC'; instant timestamptz;
begin
  if p_wall is null or not isfinite(p_wall) then raise exception 'Finite Madrid wall-clock required'; end if;
  instant := wall at time zone 'Europe/Madrid';
  if instant at time zone 'Europe/Madrid' <> wall
    or (instant - interval '1 hour') at time zone 'Europe/Madrid' = wall
    or (instant + interval '1 hour') at time zone 'Europe/Madrid' = wall then
    raise exception 'Nonexistent or ambiguous Madrid wall-clock; explicit scheduling reconciliation required';
  end if;
  return instant;
end $$;

-- Read-only eligibility. Never reconcile a successor or infer an original balance.
create function private.session_business_funding(p_session_id uuid, p_student_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare s public.sessions; e public.session_students; st public.students;
  p public.student_membership_periods; g public.gift_cards; snapshot jsonb;
  usable boolean := false; overridable boolean := false; positive boolean := false; unattributed_balance boolean := false;
  reason text := 'No known valid credit'; session_date date; due_successor boolean := false;
begin
  select * into s from public.sessions where id = p_session_id;
  select * into e from public.session_students where session_id = s.id and student_id = p_student_id;
  select * into st from public.students where id = p_student_id;
  if e.id is null or e.sede_id is distinct from s.sede_id or st.sede_id is distinct from s.sede_id then
    raise exception 'Enrollment must belong to the session sede';
  end if;
  session_date := private.atomic_session_date(s.date, s.start_time, s.end_time);
  if e.gift_card_id is not null then
    if e.membership_period_id is not null then raise exception 'Ambiguous session funding'; end if;
    select * into g from public.gift_cards where id = e.gift_card_id;
    if g.sede_id is distinct from s.sede_id or g.recipient_student_id is distinct from st.id then
      raise exception 'Explicit gift card must belong to its roster student and session sede';
    end if;
    positive := coalesce(g.num_classes > g.sessions_used and g.sessions_used >= 0, false);
    usable := positive and g.payment_status = 'paid' and g.status in ('active', 'pending')
      and g.activated_at <= session_date and g.expiry_date >= greatest(session_date, private.membership_today())
      and s.class_type = case when g.type = 'torno' then 'torno' when g.type = 'modelado' then 'mesa' end
      and st.archived_at is null;
    snapshot := jsonb_build_object('gift_card_id', g.id, 'num_classes', g.num_classes, 'sessions_used', g.sessions_used,
      'payment_status', g.payment_status, 'status', g.status, 'activated_at', g.activated_at, 'expiry_date', g.expiry_date, 'type', g.type);
    reason := 'Explicit gift card has no valid available credit';
  else
    select * into p from public.student_membership_periods where id = e.membership_period_id
      and student_id = st.id and sede_id = s.sede_id;
    -- An unmanaged scalar balance is not zero credit or an attributable source.
    unattributed_balance := (p.id is null or coalesce(st.student_category, 'membresia') <> 'membresia')
      and st.classes_remaining is distinct from 0;
    due_successor := exists (select 1 from public.student_membership_periods
      where predecessor_id = st.current_membership_period_id and starts_on <= private.membership_today());
    positive := p.id is not null and p.id = st.current_membership_period_id
      and st.classes_remaining > 0 and st.classes_remaining <= p.allocated_classes;
    overridable := positive and coalesce(st.student_category, 'membresia') = 'membresia'
      and st.archived_at is null and p.starts_on is not null and p.ends_on is not null
      and p.starts_on <= least(session_date, private.membership_today());
    usable := overridable and p.payment_status = 'paid'
      and p.ends_on >= greatest(session_date, private.membership_today()) and not due_successor;
    snapshot := jsonb_build_object('period_id', e.membership_period_id, 'current_period_id', st.current_membership_period_id,
      'balance', st.classes_remaining, 'allocated_classes', p.allocated_classes, 'starts_on', p.starts_on,
      'ends_on', p.ends_on, 'payment_status', p.payment_status, 'due_successor', due_successor);
    reason := case when unattributed_balance then 'Unsupported temporal/manual funding: legacy balance requires attributable funding or reconciliation'
      when p.id is null then 'Original membership source is unknown'
      when p.id is distinct from st.current_membership_period_id then 'Original membership balance is no longer current'
      when due_successor then 'Queued successor is not an authorized funding source'
      when not positive then 'Original membership has no known positive balance'
      else 'Original membership is unpaid, expired, archived or does not cover the session' end;
  end if;
  snapshot := snapshot || jsonb_build_object('student_category', st.student_category, 'archived_at', st.archived_at,
    'session_date', s.date, 'start_time', s.start_time, 'end_time', s.end_time, 'class_type', s.class_type);
  -- A courtesy must not dodge available membership or an unselected valid gift.
  if exists (select 1 from public.student_membership_periods cp where cp.id = st.current_membership_period_id
    and cp.student_id = st.id and cp.sede_id = s.sede_id and st.classes_remaining > 0) then positive := true; end if;
  if exists (select 1 from public.gift_cards card where card.recipient_student_id = st.id and card.sede_id = s.sede_id
    and card.payment_status = 'paid' and card.status in ('active', 'pending') and card.num_classes > card.sessions_used
    and card.activated_at <= session_date and card.expiry_date >= greatest(session_date, private.membership_today())
    and s.class_type = case when card.type = 'torno' then 'torno' when card.type = 'modelado' then 'mesa' end) then positive := true; end if;
  return jsonb_build_object('usable', coalesce(usable, false), 'overridable', coalesce(overridable, false),
    'no_credit_allowed', not unattributed_balance and not coalesce(positive, false), 'period_id', e.membership_period_id,
    'gift_card_id', e.gift_card_id, 'snapshot', snapshot, 'reason', reason);
end $$;

-- PR1's adjustment helper reconciles periods. Policy2 deliberately does not.
create function private.session_business_adjust(p_student_id uuid, p_period_id uuid, p_delta integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare st public.students; allocation integer; adjustment_id uuid;
begin
  select * into st from public.students where id = p_student_id for update;
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

create view public.session_business_state with (security_invoker = true) as
select e.session_id, e.student_id, s.sede_id, s.attendance_policy_version as policy_version,
  case when e.cancelled_at is null then 'reserved' else 'cancelled' end as reservation_state,
  e.cancelled_at, e.cancellation_kind, x.id as exception_id, x.kind as exception_kind,
  x.period_id as exception_period_id, x.reason as exception_reason, x.approved_by,
  case when w.penalty_id is not null then 'waived'
    when b.state is not null then b.state
    when s.attendance_policy_version = 1 and exists (select 1 from public.session_credit_movements m
      where m.session_id = e.session_id and m.student_id = e.student_id and m.delta = -1
        and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id)) then 'charged'
    when s.attendance_policy_version = 1 and s.completed_at is not null then 'no_charge'
    else 'unfinalized' end as billing_state,
  coalesce(b.kind, case when s.attendance_policy_version = 1 and e.attendance = 'present' then 'attendance' end) as billing_kind,
  p.id as penalty_id, case when w.penalty_id is not null then 'waived' else p.state end as penalty_state,
  p.reason as penalty_reason,
  e.cancellation_reason, e.cancelled_by, x.gift_card_id as exception_gift_card_id, x.approved_at,
  b.debit_id as billing_debit_id, e.membership_period_id as funding_period_id, e.gift_card_id as funding_gift_card_id,
  w.reason as waiver_reason, w.waived_by, w.waived_at, b.finalized_revision
from public.session_students e join public.sessions s on s.id = e.session_id and s.sede_id = e.sede_id
left join public.session_business_exceptions x on x.id = e.business_exception_id
  and x.session_id = e.session_id and x.student_id = e.student_id and x.sede_id = s.sede_id
left join public.session_business_billing b on b.session_id = e.session_id and b.student_id = e.student_id and b.sede_id = s.sede_id
left join public.session_business_penalties p on p.session_id = e.session_id and p.student_id = e.student_id and p.sede_id = s.sede_id
left join public.session_business_waivers w on w.penalty_id = p.id and w.sede_id = s.sede_id
where private.session_business_read_sede(s.sede_id);
revoke all on public.session_business_state from public, anon, authenticated, service_role;
grant select on public.session_business_state to authenticated;

-- Replace capacity counting, not the persisted v1 roster semantics.
create or replace function public.validate_session_capacity_update() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.capacity < (select count(*) from public.session_students where session_id = new.id
    and (new.attendance_policy_version = 1 or cancelled_at is null)) then
    raise exception 'Session capacity exceeded' using errcode = '23514';
  end if;
  return new;
end $$;
create or replace function public.validate_session_student_capacity() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare s public.sessions; previous_id uuid;
begin
  select * into s from public.sessions where id = new.session_id;
  if s.attendance_policy_version = 2 and new.cancelled_at is not null then return new; end if;
  if tg_op = 'UPDATE' then previous_id := old.student_id; end if;
  if (select count(*) from public.session_students where session_id = s.id
    and student_id is distinct from previous_id and (s.attendance_policy_version = 1 or cancelled_at is null)) >= s.capacity then
    raise exception 'Session capacity exceeded' using errcode = '23514';
  end if;
  return new;
end $$;

alter function private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid) rename to save_session_attendance_v1;
alter function private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb) rename to save_session_reservation_v1;
revoke all on function private.save_session_attendance_v1(uuid,uuid,bigint,jsonb,boolean,uuid),
  private.save_session_reservation_v1(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb) from public, anon, authenticated, service_role;
-- Keep the v1 reservation/receipt contract, except that a v2 cancellation no
-- longer conflicts with an active booking, whichever policy creates that booking.
create or replace function private.save_session_reservation_v1(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint, p_sede_id uuid,
  p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare s public.sessions; proposed public.sessions; prior public.session_operation_receipts;
  intent jsonb; result jsonb; roster uuid[]; existed boolean; has_history boolean;
begin
  if auth.uid() is null or not private.can_access_sede(p_sede_id)
    or not exists (select 1 from public.sedes where id = p_sede_id and is_active is true) then
    raise exception 'Session not accessible' using errcode = '42501';
  end if;
  if p_session_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision < 0
    or p_student_ids is null or array_position(p_student_ids, null) is not null
    or p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
    or p_gift_card_ids is null or jsonb_typeof(p_gift_card_ids) <> 'object' then
    raise exception 'Explicit session, request key, revision, metadata and ID roster required';
  end if;
  if (p_metadata - array['date', 'start_time', 'end_time', 'class_type', 'capacity', 'teacher_id',
    'workshop_name', 'private_reason', 'session_audience']) <> '{}'::jsonb then
    raise exception 'Unsupported reservation metadata; attendance uses its own RPC';
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into roster from unnest(p_student_ids) id;
  if cardinality(roster) <> (select count(distinct id) from unnest(roster) id) then raise exception 'Duplicate roster student IDs'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c where c.key <> c.key::uuid::text) then
    raise exception 'Gift card map keys must be canonical lowercase hyphenated UUIDs';
  end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c where c.key::uuid <> all(roster) or c.value is null) then
    raise exception 'Gift card links must identify roster students';
  end if;
  intent := jsonb_build_object('expected_revision', p_expected_revision, 'metadata', p_metadata,
    'student_ids', to_jsonb(roster), 'gift_card_ids', p_gift_card_ids, 'sede_id', p_sede_id);
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into s from public.sessions where id = p_session_id for update;
  existed := found;
  if existed then
    s := private.lock_atomic_session(p_session_id);
    if s.sede_id <> p_sede_id then raise exception 'Session not accessible' using errcode = '42501'; end if;
    select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
    if found then
      if prior.operation <> 'reservation' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
      return prior.result || jsonb_build_object('replayed', true);
    end if;
    if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  elsif p_expected_revision <> 0 then raise exception 'Stale session revision' using errcode = '40001';
  end if;
  proposed := jsonb_populate_record(null::public.sessions, coalesce(to_jsonb(s), '{}'::jsonb) || p_metadata);
  proposed.capacity := coalesce(proposed.capacity, 8);
  proposed.session_audience := coalesce(proposed.session_audience, 'membresia');
  perform private.atomic_session_date(proposed.date, proposed.start_time, proposed.end_time);
  if proposed.class_type is null or proposed.class_type not in ('mesa', 'torno', 'coworking', 'workshop', 'privada', 'feriado')
    or proposed.capacity not between 1 and 100 then raise exception 'Valid session interval, date, class type and capacity required'; end if;
  if cardinality(roster) > proposed.capacity then raise exception 'Session capacity exceeded'; end if;
  if proposed.class_type = 'feriado' and cardinality(roster) > 0 then raise exception 'Holiday sessions cannot have a roster'; end if;
  if proposed.teacher_id is not null and not exists (select 1 from public.teachers
    where id = proposed.teacher_id and sede_id = p_sede_id) then raise exception 'Teacher must belong to the session sede'; end if;
  perform 1 from public.gift_cards where id in (
    select value::uuid from jsonb_each_text(p_gift_card_ids)
    union select gift_card_id from public.session_students where session_id = p_session_id
  ) order by id for update;
  perform 1 from public.students where id in (select unnest(roster) union select student_id from public.session_students where session_id = p_session_id)
    order by id for update;
  if (select count(*) from public.students where id = any(roster) and sede_id = p_sede_id) <> cardinality(roster) then
    raise exception 'Roster students must belong to the session sede';
  end if;
  if exists (select 1 from public.session_students e left join public.students st on st.id = e.student_id
    where e.session_id = p_session_id and (e.sede_id is distinct from p_sede_id or st.sede_id is distinct from p_sede_id)) then
    raise exception 'Legacy cross-sede roster requires reconciliation';
  end if;
  if exists (select 1 from public.session_students e join public.sessions other on other.id = e.session_id
    where e.student_id = any(roster) and other.id <> p_session_id and e.cancelled_at is null
      and other.start_time < proposed.end_time and other.end_time > proposed.start_time) then
    raise exception 'Student already reserved in an overlapping session';
  end if;
  has_history := existed and (s.completed_at is not null
    or exists (select 1 from public.session_operation_receipts where session_id = s.id and operation = 'attendance')
    or exists (select 1 from public.session_credit_movements where session_id = s.id)
    or exists (select 1 from public.gift_card_movements where session_id = s.id)
    or exists (select 1 from public.session_students where session_id = s.id and attendance = 'present'));
  if has_history and (proposed.date is distinct from s.date or proposed.start_time is distinct from s.start_time
    or proposed.end_time is distinct from s.end_time or proposed.class_type is distinct from s.class_type
    or roster is distinct from (select coalesce(array_agg(student_id order by student_id), '{}'::uuid[]) from public.session_students where session_id = s.id)
    or exists (select 1 from public.session_students where session_id = s.id
      and gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid)) then
    raise exception 'Session history locks roster, interval and original funding; correct attendance instead';
  end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c left join public.gift_cards g on g.id = c.value::uuid
    where g.id is null or g.sede_id is distinct from p_sede_id or g.recipient_student_id is distinct from c.key::uuid) then
    raise exception 'Explicit gift card must belong to its roster student and session sede';
  end if;
  if existed then
    if not has_history then
      delete from public.session_students where session_id = s.id and student_id <> all(roster);
    end if;
    update public.sessions set date = proposed.date, start_time = proposed.start_time, end_time = proposed.end_time,
      class_type = proposed.class_type, capacity = proposed.capacity, teacher_id = proposed.teacher_id,
      workshop_name = proposed.workshop_name, private_reason = proposed.private_reason,
      session_audience = proposed.session_audience, revision = revision + 1 where id = s.id returning * into s;
  else
    insert into public.sessions(id, sede_id, date, start_time, end_time, class_type, capacity, teacher_id,
      workshop_name, private_reason, session_audience, revision)
      values (p_session_id, p_sede_id, proposed.date, proposed.start_time, proposed.end_time, proposed.class_type,
        proposed.capacity, proposed.teacher_id, proposed.workshop_name, proposed.private_reason, proposed.session_audience, 1)
      returning * into s;
  end if;
  update public.session_students set gift_card_id = (p_gift_card_ids->>student_id::text)::uuid
    where session_id = s.id and student_id = any(roster);
  insert into public.session_students(session_id, student_id, student_name, sede_id, attendance, gift_card_id, is_temporary, temp_group_name)
    select s.id, st.id, upper(trim(concat_ws(' ', st.name, st.surname))), s.sede_id, 'pending',
      (p_gift_card_ids->>st.id::text)::uuid, st.student_category = 'temporal',
      case when st.student_category = 'temporal' then st.group_name else null end
    from public.students st where st.id = any(roster)
      and not exists (select 1 from public.session_students e where e.session_id = s.id and e.student_id = st.id);
  result := jsonb_build_object('session_id', s.id, 'request_key', p_request_key, 'revision', s.revision,
    'session', to_jsonb(s), 'student_ids', to_jsonb(roster), 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'reservation', intent, result, auth.uid());
  return result;
end $$;
-- A standalone balance credit has no session, reason or penalty authority.
-- V1 still uses the unchanged private adjustment inside its definer boundary.
revoke all on function public.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer),
  private.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer) from public, anon, authenticated, service_role;

create function private.save_session_attendance(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_attendance jsonb, p_finalize boolean, p_teacher_substitute_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.sessions; e public.session_students; prior public.session_operation_receipts;
  b public.session_business_billing; penalty public.session_business_penalties; x public.session_business_exceptions;
  attendance jsonb; intent jsonb; result jsonb; item record; funding jsonb;
  billing_kind text; billing_state text; debit_id uuid; adjustment_id uuid; exception_id uuid;
  active_debits integer; gift_net bigint;
begin
  s := private.lock_atomic_session(p_session_id);
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if s.attendance_policy_version = 1 then
    return private.save_session_attendance_v1(p_session_id, p_request_key, p_expected_revision, p_attendance, p_finalize, p_teacher_substitute_id);
  end if;
  if p_request_key is null or p_expected_revision is null or p_expected_revision < 0 or p_finalize is null
    or p_attendance is null or jsonb_typeof(p_attendance) <> 'array' then raise exception 'Request key, revision, attendance array and finalize flag required'; end if;
  if exists (select 1 from jsonb_array_elements(p_attendance) a where jsonb_typeof(a) <> 'object'
    or not (a ? 'student_id' and a ? 'status') or a->>'student_id' is null
    or coalesce(a->>'status', '') not in ('present', 'absent', 'pending') or (a - 'student_id' - 'status') <> '{}') then
    raise exception 'Attendance requires exact student_id/status objects';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('student_id', student_id, 'status', status) order by student_id), '[]')
    into attendance from jsonb_to_recordset(p_attendance) as a(student_id uuid, status text);
  if (select count(*) <> count(distinct student_id) from jsonb_to_recordset(attendance) as a(student_id uuid, status text)) then raise exception 'Duplicate attendance student IDs'; end if;
  intent := jsonb_build_object('expected_revision', p_expected_revision, 'attendance', attendance,
    'finalize', p_finalize, 'teacher_substitute_id', p_teacher_substitute_id);
  select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
  if found then
    if prior.operation <> 'attendance' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
    return prior.result || jsonb_build_object('replayed', true);
  end if;
  if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  perform private.atomic_session_date(s.date, s.start_time, s.end_time);
  perform private.session_madrid_instant(s.start_time); perform private.session_madrid_instant(s.end_time);
  if s.completed_at is not null and not p_finalize then raise exception 'Finalized policy2 sessions cannot reopen'; end if;
  if exists ((select student_id from public.session_students where session_id = s.id
    except select student_id from jsonb_to_recordset(attendance) as a(student_id uuid, status text)) union all
    (select student_id from jsonb_to_recordset(attendance) as a(student_id uuid, status text)
    except select student_id from public.session_students where session_id = s.id)) then
    raise exception 'Attendance must match the exact persisted ID roster including cancellations';
  end if;
  if p_finalize and exists (select 1 from jsonb_to_recordset(attendance) as a(student_id uuid, status text)
    join public.session_students enrolled on enrolled.session_id = s.id and enrolled.student_id = a.student_id
    where a.status = 'pending' and enrolled.cancelled_at is null) then raise exception 'Finalized active attendance cannot contain pending students'; end if;
  if s.class_type = 'feriado' and jsonb_array_length(attendance) > 0 then raise exception 'Holiday sessions cannot have attendance'; end if;
  if p_teacher_substitute_id is not null and not exists (select 1 from public.teachers where id = p_teacher_substitute_id and sede_id = s.sede_id) then raise exception 'Substitute must belong to the session sede'; end if;
  perform 1 from public.gift_cards where id in (select gift_card_id from public.session_students where session_id = s.id)
    or recipient_student_id in (select student_id from public.session_students where session_id = s.id) order by id for update;
  perform 1 from public.students where id in (select student_id from public.session_students where session_id = s.id) order by id for update;
  perform 1 from public.session_students where session_id = s.id order by student_id for update;
  for item in select * from jsonb_to_recordset(attendance) as a(student_id uuid, status text) order by student_id loop
    select * into e from public.session_students where session_id = s.id and student_id = item.student_id;
    funding := private.session_business_funding(s.id, e.student_id);
    select * into b from public.session_business_billing where session_id = s.id and student_id = e.student_id;
    select * into penalty from public.session_business_penalties where session_id = s.id and student_id = e.student_id;
    if (b.session_id is null) <> (s.completed_at is null) then raise exception 'Policy2 billing/completion requires reconciliation'; end if;
    select count(*) into active_debits from public.session_credit_movements m where m.session_id = s.id and m.student_id = e.student_id
      and m.delta = -1 and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id);
    if active_debits <> (case when b.debit_id is null then 0 else 1 end) or (b.debit_id is not null and not exists (
      select 1 from public.session_credit_movements m where m.id = b.debit_id and m.session_id = s.id and m.student_id = e.student_id
        and m.period_id is not distinct from e.membership_period_id and m.gift_card_id is not distinct from e.gift_card_id
        and m.delta = -1 and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id))) then
      raise exception 'Policy2 billing and original debit require reconciliation';
    end if;
    select coalesce(sum(sessions_delta), 0) into gift_net from public.gift_card_movements
      where session_id = s.id and student_id = e.student_id and movement_type in ('redeem', 'reverse');
    if gift_net <> (case when b.debit_id is not null and e.gift_card_id is not null then 1 else 0 end)
      or exists (select 1 from public.gift_card_movements where session_id = s.id and student_id = e.student_id
        and movement_type in ('redeem', 'reverse') and gift_card_id is distinct from e.gift_card_id
        group by gift_card_id having sum(sessions_delta) <> 0) then
      raise exception 'Policy2 gift ledger and original debit require reconciliation';
    end if;
    billing_kind := case when e.cancellation_kind = 'timely' then 'timely_cancellation'
      when e.cancellation_kind = 'late' then 'late_cancellation' when item.status = 'absent' then 'no_show' else 'attendance' end;
    if p_finalize and penalty.id is null and (b.session_id is null or (billing_kind = 'no_show' and b.kind in ('attendance', 'courtesy'))) then
      debit_id := b.debit_id; exception_id := b.exception_id; adjustment_id := null;
      if billing_kind = 'timely_cancellation' then billing_state := 'no_charge';
      elsif debit_id is not null then billing_state := 'charged';
      else
        -- Ordinary usable funding needs no exception; keep old approvals as history.
        select * into x from public.session_business_exceptions where id = e.business_exception_id
          and session_id = s.id and student_id = e.student_id and sede_id = s.sede_id
          and not (funding->>'usable')::boolean;
        if billing_kind = 'attendance' and x.id is not null then
          if x.funding_snapshot is distinct from funding->'snapshot' then raise exception 'Session exception is stale; explicit reapproval required'; end if;
          exception_id := x.id;
        end if;
        if billing_kind = 'attendance' and x.kind = 'no_credit' then
          if not (funding->>'no_credit_allowed')::boolean then raise exception 'No-credit exception cannot bypass available credit: %', funding->>'reason'; end if;
          billing_kind := 'courtesy'; billing_state := 'no_charge';
        elsif (funding->>'usable')::boolean or (billing_kind = 'attendance' and x.kind = 'membership_override' and (funding->>'overridable')::boolean) then
          if (funding->>'usable')::boolean then exception_id := null; end if;
          if e.gift_card_id is not null then
            perform private.apply_gift_card_session(e.gift_card_id, s.id, e.student_id, false, gen_random_uuid());
          else
            adjustment_id := private.session_business_adjust(e.student_id, e.membership_period_id, -1);
          end if;
          insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, gift_card_id,
            delta, adjustment_id, disposition, created_by)
            values (s.id, e.student_id, s.sede_id, s.revision + 1, e.membership_period_id, e.gift_card_id, -1, adjustment_id,
              case when e.gift_card_id is not null then 'gift_card' else 'current_period' end, auth.uid()) returning id into debit_id;
          billing_state := 'charged';
        elsif billing_kind in ('no_show', 'late_cancellation') then billing_state := 'incident';
        else raise exception 'Presence requires valid original credit or an explicit current session exception: %', funding->>'reason';
        end if;
      end if;
      if billing_kind in ('no_show', 'late_cancellation') then
        insert into public.session_business_penalties(session_id, student_id, sede_id, revision, kind, state, reason,
          period_id, gift_card_id, debit_id, created_by)
          values (s.id, e.student_id, s.sede_id, s.revision + 1, billing_kind,
            case when debit_id is null then 'pending' else 'charged' end,
            case when debit_id is null then funding->>'reason' else 'One class: ' || billing_kind end,
            e.membership_period_id, e.gift_card_id, debit_id, auth.uid()) returning * into penalty;
      end if;
      insert into public.session_business_billing(session_id, student_id, sede_id, state, kind, exception_id, debit_id, penalty_id, finalized_revision)
        values (s.id, e.student_id, s.sede_id, billing_state, billing_kind, exception_id, debit_id, penalty.id, s.revision + 1)
        on conflict (session_id, student_id) do update set state = excluded.state, kind = excluded.kind,
          exception_id = excluded.exception_id, debit_id = excluded.debit_id, penalty_id = excluded.penalty_id;
      insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
        values (s.id, e.student_id, s.sede_id, s.revision + 1, 'billing_finalized',
          jsonb_build_object('state', billing_state, 'kind', billing_kind, 'debit_id', debit_id, 'penalty_id', penalty.id, 'exception_id', exception_id), auth.uid());
    end if;
    if s.completed_at is not null and e.attendance is distinct from item.status then
      insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
        values (s.id, e.student_id, s.sede_id, s.revision + 1, 'attendance_corrected',
          jsonb_build_object('from', e.attendance, 'to', item.status, 'penalty_retained', penalty.id), auth.uid());
    end if;
    update public.session_students set attendance = item.status where id = e.id;
  end loop;
  update public.sessions set revision = revision + 1, completed_at = case when p_finalize then coalesce(completed_at, clock_timestamp()) else null end,
    teacher_substitute_id = p_teacher_substitute_id where id = s.id returning * into s;
  result := jsonb_build_object('session_id', s.id, 'request_key', p_request_key, 'revision', s.revision,
    'attendance', attendance, 'completed_at', s.completed_at, 'teacher_substitute_id', s.teacher_substitute_id,
    'credit_movements', coalesce((select jsonb_agg(to_jsonb(m) order by student_id) from public.session_credit_movements m
      where session_id = s.id and revision = s.revision), '[]'), 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'attendance', intent, result, auth.uid());
  return result;
end $$;

create function private.save_session_reservation(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint, p_sede_id uuid,
  p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare s public.sessions; proposed public.sessions; prior public.session_operation_receipts;
  intent jsonb; result jsonb; roster uuid[]; active_roster uuid[]; existed boolean; locked_history boolean;
begin
  if not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if p_session_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision < 0
    or p_student_ids is null or array_position(p_student_ids, null) is not null or p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
    or p_gift_card_ids is null or jsonb_typeof(p_gift_card_ids) <> 'object' then raise exception 'Explicit session, request key, revision, metadata and ID roster required'; end if;
  if (p_metadata - array['date', 'start_time', 'end_time', 'class_type', 'capacity', 'teacher_id', 'workshop_name', 'private_reason', 'session_audience']) <> '{}' then
    raise exception 'Unsupported reservation metadata; attendance uses its own RPC';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into s from public.sessions where id = p_session_id for update;
  existed := found;
  if existed and s.sede_id <> p_sede_id then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if existed and s.attendance_policy_version = 1 then
    return private.save_session_reservation_v1(p_session_id, p_request_key, p_expected_revision, p_sede_id, p_metadata, p_student_ids, p_gift_card_ids);
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into roster from unnest(p_student_ids) id;
  if cardinality(roster) <> (select count(distinct id) from unnest(roster) id) then raise exception 'Duplicate roster student IDs'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c where c.key <> c.key::uuid::text) then raise exception 'Gift card map keys must be canonical lowercase hyphenated UUIDs'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c where c.key::uuid <> all(roster) or c.value is null) then raise exception 'Gift card links must identify roster students'; end if;
  intent := jsonb_build_object('expected_revision', p_expected_revision, 'metadata', p_metadata,
    'student_ids', to_jsonb(roster), 'gift_card_ids', p_gift_card_ids, 'sede_id', p_sede_id);
  if existed then
    select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
    if found then
      if prior.operation <> 'reservation' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
      return prior.result || jsonb_build_object('replayed', true);
    end if;
    if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  elsif p_expected_revision <> 0 then raise exception 'Stale session revision' using errcode = '40001'; end if;
  proposed := jsonb_populate_record(null::public.sessions, coalesce(to_jsonb(s), '{}') || p_metadata);
  proposed.capacity := coalesce(proposed.capacity, 8); proposed.session_audience := coalesce(proposed.session_audience, 'membresia');
  perform private.atomic_session_date(proposed.date, proposed.start_time, proposed.end_time);
  perform private.session_madrid_instant(proposed.start_time); perform private.session_madrid_instant(proposed.end_time);
  if proposed.class_type is null or proposed.class_type not in ('mesa', 'torno', 'coworking', 'workshop', 'privada', 'feriado')
    or proposed.capacity not between 1 and 100 then raise exception 'Valid session interval, date, class type and capacity required'; end if;
  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into active_roster from unnest(roster) r(id)
    where not exists (select 1 from public.session_students e where e.session_id = p_session_id and e.student_id = r.id and e.cancelled_at is not null);
  if cardinality(active_roster) > proposed.capacity then raise exception 'Session capacity exceeded'; end if;
  if proposed.class_type = 'feriado' and cardinality(roster) > 0 then raise exception 'Holiday sessions cannot have a roster'; end if;
  if proposed.teacher_id is not null and not exists (select 1 from public.teachers where id = proposed.teacher_id and sede_id = p_sede_id) then raise exception 'Teacher must belong to the session sede'; end if;
  perform 1 from public.gift_cards where id in (select value::uuid from jsonb_each_text(p_gift_card_ids)
    union select gift_card_id from public.session_students where session_id = p_session_id) order by id for update;
  perform 1 from public.students where id in (select unnest(roster) union select student_id from public.session_students where session_id = p_session_id) order by id for update;
  perform 1 from public.session_students where session_id = p_session_id order by student_id for update;
  if (select count(*) from public.students where id = any(roster) and sede_id = p_sede_id) <> cardinality(roster) then raise exception 'Roster students must belong to the session sede'; end if;
  if exists (select 1 from public.session_students where session_id = p_session_id and cancelled_at is null and student_id <> all(roster)) then
    raise exception 'Use cancel_session_reservation to remove an active reservation';
  end if;
  if exists (select 1 from public.session_students e join public.sessions other on other.id = e.session_id
    where e.student_id = any(active_roster) and other.id <> p_session_id and e.cancelled_at is null
      and other.start_time < proposed.end_time and other.end_time > proposed.start_time) then raise exception 'Student already reserved in an overlapping session'; end if;
  locked_history := existed and (s.completed_at is not null or exists (select 1 from public.session_students where session_id = s.id and cancelled_at is not null));
  if locked_history and (proposed.date is distinct from s.date or proposed.start_time is distinct from s.start_time
    or proposed.end_time is distinct from s.end_time or proposed.class_type is distinct from s.class_type) then raise exception 'Session history locks interval and original funding'; end if;
  if existed and s.completed_at is not null and (active_roster is distinct from (select coalesce(array_agg(student_id order by student_id), '{}'::uuid[])
    from public.session_students where session_id = s.id and cancelled_at is null)
    or exists (select 1 from public.session_students where session_id = s.id and cancelled_at is null
      and gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid)) then raise exception 'Finalized roster and original funding are locked'; end if;
  if exists (select 1 from public.session_students where session_id = p_session_id and cancelled_at is not null and student_id = any(roster)
    and p_gift_card_ids ? student_id::text and gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid) then raise exception 'Cancellation and its original funding are immutable'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c left join public.gift_cards g on g.id = c.value::uuid
    where g.id is null or g.sede_id is distinct from p_sede_id or g.recipient_student_id is distinct from c.key::uuid) then raise exception 'Explicit gift card must belong to its roster student and session sede'; end if;
  if existed then
    update public.sessions set date = proposed.date, start_time = proposed.start_time, end_time = proposed.end_time,
      class_type = proposed.class_type, capacity = proposed.capacity, teacher_id = proposed.teacher_id,
      workshop_name = proposed.workshop_name, private_reason = proposed.private_reason, session_audience = proposed.session_audience,
      revision = revision + 1 where id = s.id returning * into s;
  else
    insert into public.sessions(id, sede_id, date, start_time, end_time, class_type, capacity, teacher_id,
      workshop_name, private_reason, session_audience, revision)
      values (p_session_id, p_sede_id, proposed.date, proposed.start_time, proposed.end_time, proposed.class_type,
        proposed.capacity, proposed.teacher_id, proposed.workshop_name, proposed.private_reason, proposed.session_audience, 1) returning * into s;
  end if;
  update public.session_students set gift_card_id = (p_gift_card_ids->>student_id::text)::uuid,
    membership_period_id = case when p_gift_card_ids ? student_id::text then null
      when gift_card_id is not null then (select current_membership_period_id from public.students where id = student_id)
      else membership_period_id end
    where session_id = s.id and student_id = any(active_roster) and s.completed_at is null;
  insert into public.session_students(session_id, student_id, student_name, sede_id, attendance, gift_card_id, membership_period_id, is_temporary, temp_group_name)
    select s.id, st.id, upper(trim(concat_ws(' ', st.name, st.surname))), s.sede_id, 'pending', (p_gift_card_ids->>st.id::text)::uuid,
      case when p_gift_card_ids ? st.id::text then null else st.current_membership_period_id end,
      st.student_category = 'temporal', case when st.student_category = 'temporal' then st.group_name end
    from public.students st where st.id = any(active_roster)
      and not exists (select 1 from public.session_students e where e.session_id = s.id and e.student_id = st.id);
  result := jsonb_build_object('session_id', s.id, 'request_key', p_request_key, 'revision', s.revision,
    'session', to_jsonb(s), 'student_ids', (select coalesce(jsonb_agg(student_id order by student_id), '[]') from public.session_students where session_id = s.id),
    'active_student_ids', to_jsonb(active_roster), 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'reservation', intent, result, auth.uid());
  return result;
end $$;

-- Rebind the invoker wrappers explicitly after renaming the v1 implementations.
create or replace function public.save_session_attendance(p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_attendance jsonb, p_finalize boolean, p_teacher_substitute_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.save_session_attendance(p_session_id, p_request_key, p_expected_revision, p_attendance, p_finalize, p_teacher_substitute_id);
$$;
create or replace function public.save_session_reservation(p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_sede_id uuid, p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}') returns jsonb
language sql security invoker set search_path = '' as $$
  select private.save_session_reservation(p_session_id, p_request_key, p_expected_revision, p_sede_id, p_metadata, p_student_ids, p_gift_card_ids);
$$;

create function private.session_business_action(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_operation text, p_kind text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sessions; e public.session_students; prior public.session_operation_receipts;
  penalty public.session_business_penalties; debit public.session_credit_movements; st public.students;
  intent jsonb; result jsonb; funding jsonb; exception_id uuid; cancelled timestamptz;
  cancel_kind text; adjustment_id uuid; reversal_id uuid; disposition text;
begin
  s := private.lock_atomic_session(p_session_id);
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if p_operation = 'waive_session_penalty' and not exists (select 1 from public.sedes where id = s.sede_id and owner_id = auth.uid()) then
    raise exception 'Only this workshop owner may waive penalties' using errcode = '42501';
  end if;
  if p_student_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision < 0
    or p_reason is null or p_reason !~ '[^[:space:]]' or length(p_reason) > 2000 then raise exception 'Student, request key, revision and auditable reason required'; end if;
  intent := jsonb_build_object('student_id', p_student_id, 'expected_revision', p_expected_revision, 'kind', p_kind, 'reason', p_reason);
  select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
  if found then
    if prior.operation <> p_operation or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
    return prior.result || jsonb_build_object('replayed', true);
  end if;
  if s.attendance_policy_version <> 2 then raise exception 'Business actions require a policy2 session'; end if;
  if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  select * into e from public.session_students where session_id = s.id and student_id = p_student_id;
  if e.id is null or e.sede_id is distinct from s.sede_id then raise exception 'Enrollment must belong to the session sede'; end if;
  perform 1 from public.gift_cards where id = e.gift_card_id or recipient_student_id = e.student_id order by id for update;
  select * into st from public.students where id = e.student_id for update;
  select * into e from public.session_students where id = e.id for update;
  if st.sede_id is distinct from s.sede_id then raise exception 'Enrollment must belong to the session sede'; end if;
  select * into penalty from public.session_business_penalties where session_id = s.id and student_id = e.student_id;
  if p_operation = 'approve_session_exception' then
    if s.completed_at is not null or e.cancelled_at is not null or penalty.id is not null then raise exception 'Exceptions cannot change finalized billing or penalties'; end if;
    if p_kind is null or p_kind not in ('membership_override', 'no_credit') then raise exception 'Unknown session exception kind'; end if;
    funding := private.session_business_funding(s.id, e.student_id);
    if p_kind = 'membership_override' and (not (funding->>'overridable')::boolean or (funding->>'usable')::boolean) then raise exception 'Membership override requires known original positive credit needing an exception'; end if;
    if p_kind = 'no_credit' and not (funding->>'no_credit_allowed')::boolean then raise exception 'No-credit exception cannot bypass available credit: %', funding->>'reason'; end if;
    insert into public.session_business_exceptions(session_id, student_id, sede_id, revision, kind, period_id, gift_card_id,
      funding_snapshot, reason, approved_by) values (s.id, e.student_id, s.sede_id, s.revision + 1, p_kind,
        e.membership_period_id, e.gift_card_id, funding->'snapshot', p_reason, auth.uid()) returning id into exception_id;
    update public.session_students set business_exception_id = exception_id where id = e.id;
    insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
      values (s.id, e.student_id, s.sede_id, s.revision + 1, 'exception_approved', jsonb_build_object('exception_id', exception_id, 'kind', p_kind, 'reason', p_reason), auth.uid());
  elsif p_operation = 'cancel_session_reservation' then
    if s.completed_at is not null then raise exception 'Finalized reservations cannot be cancelled'; end if;
    if e.cancelled_at is not null then raise exception 'Reservation is already cancelled'; end if;
    perform private.atomic_session_date(s.date, s.start_time, s.end_time);
    perform private.session_madrid_instant(s.end_time);
    cancelled := clock_timestamp();
    cancel_kind := case when cancelled <= private.session_madrid_instant(s.start_time) - interval '8 hours' then 'timely' else 'late' end;
    update public.session_students set cancelled_at = cancelled, cancellation_kind = cancel_kind,
      cancellation_reason = p_reason, cancelled_by = auth.uid() where id = e.id;
    insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
      values (s.id, e.student_id, s.sede_id, s.revision + 1, 'reservation_cancelled',
        jsonb_build_object('cancelled_at', cancelled, 'kind', cancel_kind, 'reason', p_reason), auth.uid());
  elsif p_operation = 'waive_session_penalty' then
    if penalty.id is null then raise exception 'No recorded penalty to waive'; end if;
    if exists (select 1 from public.session_business_waivers where penalty_id = penalty.id) then raise exception 'Penalty is already waived'; end if;
    if penalty.debit_id is not null then
      select * into debit from public.session_credit_movements where id = penalty.debit_id;
      if debit.session_id <> s.id or debit.student_id <> e.student_id or debit.delta <> -1
        or exists (select 1 from public.session_credit_movements where reverses_id = debit.id) then raise exception 'Original penalty debit requires reconciliation'; end if;
      if debit.gift_card_id is not null then
        if e.gift_card_id is distinct from debit.gift_card_id then raise exception 'Original gift card link requires reconciliation'; end if;
        perform private.apply_gift_card_session(debit.gift_card_id, s.id, e.student_id, true, gen_random_uuid());
        disposition := 'gift_card';
      else
        if e.membership_period_id is distinct from debit.period_id then raise exception 'Original membership link requires reconciliation'; end if;
        disposition := 'original_period_credit';
        if st.current_membership_period_id = debit.period_id then
          adjustment_id := private.session_business_adjust(st.id, debit.period_id, 1);
          disposition := 'current_period';
        end if;
      end if;
      insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, gift_card_id,
        delta, reverses_id, adjustment_id, disposition, created_by)
        values (s.id, e.student_id, s.sede_id, s.revision + 1, debit.period_id, debit.gift_card_id, 1, debit.id, adjustment_id, disposition, auth.uid()) returning id into reversal_id;
    end if;
    insert into public.session_business_waivers(penalty_id, session_id, student_id, sede_id, revision, reason, reversal_id, waived_by)
      values (penalty.id, s.id, e.student_id, s.sede_id, s.revision + 1, p_reason, reversal_id, auth.uid());
    update public.session_business_billing set state = 'waived', debit_id = null where session_id = s.id and student_id = e.student_id;
    insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
      values (s.id, e.student_id, s.sede_id, s.revision + 1, 'penalty_waived',
        jsonb_build_object('penalty_id', penalty.id, 'reversal_id', reversal_id, 'reason', p_reason), auth.uid());
  else raise exception 'Unknown business operation'; end if;
  update public.sessions set revision = revision + 1 where id = s.id returning * into s;
  result := jsonb_build_object('session_id', s.id, 'student_id', e.student_id, 'request_key', p_request_key, 'revision', s.revision,
    'exception_id', exception_id, 'penalty_id', penalty.id, 'cancelled_at', cancelled, 'cancellation_kind', cancel_kind, 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, p_operation, intent, result, auth.uid());
  return result;
end $$;

create function public.approve_session_exception(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_kind text, p_reason text) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'approve_session_exception', p_kind, p_reason);
$$;
create function public.cancel_session_reservation(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_reason text) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'cancel_session_reservation', null, p_reason);
$$;
create function public.waive_session_penalty(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_reason text) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'waive_session_penalty', null, p_reason);
$$;

revoke all on function private.session_business_read_sede(uuid), private.session_employee_sede(uuid), private.guard_sede_financial_owner(), private.guard_session_business_projection(),
  private.session_madrid_instant(timestamptz), private.session_business_funding(uuid,uuid), private.session_business_adjust(uuid,uuid,integer),
  private.session_business_action(uuid,uuid,uuid,bigint,text,text,text),
  private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid), private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb),
  public.approve_session_exception(uuid,uuid,uuid,bigint,text,text), public.cancel_session_reservation(uuid,uuid,uuid,bigint,text),
  public.waive_session_penalty(uuid,uuid,uuid,bigint,text) from public, anon, authenticated, service_role;
grant execute on function private.session_business_read_sede(uuid), private.session_employee_sede(uuid), private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb), public.approve_session_exception(uuid,uuid,uuid,bigint,text,text),
  public.cancel_session_reservation(uuid,uuid,uuid,bigint,text), public.waive_session_penalty(uuid,uuid,uuid,bigint,text) to authenticated;
notify pgrst, 'reload schema';
commit;
