-- ROLLOUT GATE: explicit ID-based manual selection; no automatic scalar conversion.
-- Unknown legacy is not reconcilable. Evidence-backed new_manual is independent.
begin;
-- Keep the rollout observations and observer installation atomic with source DML.
lock table public.gift_cards, public.students in share row exclusive mode;

create table public.student_manual_credit_entitlements (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null,
  sede_id uuid not null,
  request_key uuid not null,
  mode text not null check (mode in ('reconcile_legacy', 'new_manual')),
  quantity integer not null check (quantity > 0),
  expected_legacy_balance integer,
  activity text not null check (activity in ('mesa', 'torno', 'coworking', 'workshop', 'privada')),
  starts_on date not null check (isfinite(starts_on)),
  ends_on date not null check (isfinite(ends_on)),
  reason text not null check (reason ~ '[^[:space:]]' and length(reason) <= 2000),
  evidence text not null check (evidence ~ '[^[:space:]]' and length(evidence) <= 10000),
  approved_by uuid not null references auth.users(id) on delete restrict,
  approved_at timestamptz not null default clock_timestamp(),
  legacy_snapshot jsonb not null check (jsonb_typeof(legacy_snapshot) = 'object'),
  intent jsonb not null,
  result jsonb not null,
  unique (student_id, request_key),
  unique (student_id, sede_id, id),
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict,
  check (ends_on >= starts_on),
  check (mode <> 'reconcile_legacy' or (expected_legacy_balance is not null
    and expected_legacy_balance > 0 and quantity = expected_legacy_balance))
);
create unique index student_manual_one_legacy_reconciliation
  on public.student_manual_credit_entitlements(student_id) where mode = 'reconcile_legacy';

alter table public.session_students add column manual_credit_id uuid,
  add constraint session_manual_owner_fk foreign key (student_id, sede_id, manual_credit_id)
    references public.student_manual_credit_entitlements(student_id, sede_id, id) on delete restrict,
  add constraint session_funding_exclusive check (num_nonnulls(membership_period_id, gift_card_id, manual_credit_id) <= 1) not valid;
alter table public.session_credit_movements add column manual_credit_id uuid,
  add constraint session_credit_manual_owner_fk foreign key (student_id, sede_id, manual_credit_id)
    references public.student_manual_credit_entitlements(student_id, sede_id, id) on delete restrict;
-- Locate the shipped unnamed two-source check without relying on generated names.
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.session_credit_movements'::regclass
    and contype = 'c' and pg_get_constraintdef(oid) like '%(period_id IS NULL)%'
    and pg_get_constraintdef(oid) like '%(gift_card_id IS NULL)%' loop
    execute format('alter table public.session_credit_movements drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.session_credit_movements drop constraint session_credit_movements_disposition_check,
  add constraint session_credit_movements_disposition_check
    check (disposition in ('current_period', 'original_period_credit', 'gift_card', 'manual_credit')),
  add constraint session_credit_source_exclusive check (num_nonnulls(period_id, gift_card_id, manual_credit_id) = 1),
  add constraint session_credit_manual_terms check ((disposition = 'manual_credit') = (manual_credit_id is not null)
    and (manual_credit_id is null or adjustment_id is null));
create index session_credit_manual_idx on public.session_credit_movements(manual_credit_id) where manual_credit_id is not null;
-- Historical v1 can have several consume/reverse cycles; only manual debits are single-use.
create unique index session_credit_manual_consumption_once on public.session_credit_movements(session_id, student_id)
  where manual_credit_id is not null and delta = -1;

alter table public.session_business_penalties add column manual_credit_id uuid,
  add constraint penalty_manual_owner_fk foreign key (student_id, sede_id, manual_credit_id)
    references public.student_manual_credit_entitlements(student_id, sede_id, id) on delete restrict,
  add constraint penalty_source_exclusive check (num_nonnulls(period_id, gift_card_id, manual_credit_id) <= 1);
alter table public.session_business_exceptions add column manual_credit_id uuid,
  add constraint exception_manual_owner_fk foreign key (student_id, sede_id, manual_credit_id)
    references public.student_manual_credit_entitlements(student_id, sede_id, id) on delete restrict,
  add constraint exception_source_exclusive check (num_nonnulls(period_id, gift_card_id, manual_credit_id) <= 1);

create table public.student_penalty_settlements (
  id uuid primary key default gen_random_uuid(),
  penalty_id uuid not null unique references public.session_business_penalties(id) on delete restrict,
  student_id uuid not null,
  session_id uuid not null,
  sede_id uuid not null,
  request_key uuid not null,
  revision bigint not null,
  period_id uuid,
  gift_card_id uuid references public.gift_cards(id) on delete restrict,
  manual_credit_id uuid,
  debit_id uuid not null unique references public.session_credit_movements(id) on delete restrict,
  reason text not null check (reason ~ '[^[:space:]]' and length(reason) <= 2000),
  settled_by uuid not null references auth.users(id) on delete restrict,
  settled_at timestamptz not null default clock_timestamp(),
  funding_snapshot jsonb not null,
  unique (session_id, request_key),
  foreign key (session_id, student_id) references public.session_students(session_id, student_id) on delete restrict,
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict,
  foreign key (student_id, period_id) references public.student_membership_periods(student_id, id) on delete restrict,
  foreign key (gift_card_id, sede_id) references public.gift_cards(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id, manual_credit_id)
    references public.student_manual_credit_entitlements(student_id, sede_id, id) on delete restrict,
  check (num_nonnulls(period_id, gift_card_id, manual_credit_id) = 1)
);
alter table public.session_operation_receipts drop constraint session_operation_receipts_operation_check,
  add constraint session_operation_receipts_operation_check check (operation in ('attendance', 'reservation',
    'approve_session_exception', 'cancel_session_reservation', 'waive_session_penalty', 'settle_student_penalty'));
alter table public.session_business_events drop constraint session_business_events_event_check,
  add constraint session_business_events_event_check check (event in ('exception_approved', 'reservation_cancelled',
    'billing_finalized', 'attendance_corrected', 'penalty_waived', 'penalty_settled'));

do $$
declare tab text;
begin
  foreach tab in array array['student_manual_credit_entitlements', 'student_penalty_settlements'] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', tab);
    execute format('grant select on public.%I to authenticated', tab);
    execute format('create policy business_employee_read on public.%I for select to authenticated using (private.session_business_read_sede(sede_id))', tab);
    execute format('create trigger guard_manual_history before insert or update or delete on public.%I for each row execute function private.guard_session_history()', tab);
  end loop;
end $$;

create function private.manual_credit_owner(p_sede_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.session_employee_sede(p_sede_id)
    and exists (select 1 from public.sedes where id = p_sede_id and owner_id = auth.uid());
$$;

-- These are denial observations, NOT gift ownership or a financial allocation.
-- No FKs: retain snapshots after deletion and never acquire a gift lock from a student observer.
create table private.manual_legacy_gift_vetoes (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null,
  student_sede_id uuid,
  gift_card_id uuid not null,
  gift_sede_id uuid,
  observed_balance integer not null check (observed_balance > 0),
  match_basis text not null check (match_basis in ('recipient_id', 'normalized_label_or_email')),
  observation text not null check (observation in ('rollout', 'gift_write', 'student_write')),
  student_snapshot jsonb not null check (jsonb_typeof(student_snapshot) = 'object'),
  gift_snapshot jsonb not null check (jsonb_typeof(gift_snapshot) = 'object'),
  recorded_by uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (student_id, gift_card_id)
);
alter table private.manual_legacy_gift_vetoes enable row level security;
revoke all on private.manual_legacy_gift_vetoes from public, anon, authenticated, service_role;
create trigger guard_manual_gift_veto_history before insert or update or delete on private.manual_legacy_gift_vetoes
  for each row execute function private.guard_session_history();

-- Assigned gifts can also have a label left behind by a pre-rollout reassignment.
create function private.manual_gift_veto_match(p_gift public.gift_cards, p_student public.students) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select coalesce((p_gift).recipient_student_id = (p_student).id or ((p_gift).sede_id = (p_student).sede_id and (
    nullif(lower(btrim(regexp_replace((p_gift).recipient, '[[:space:]]+', ' ', 'g'))), '') in (
      select nullif(lower(btrim(regexp_replace(identity, '[[:space:]]+', ' ', 'g'))), '')
      from unnest(array[(p_student).full_name, (p_student).name, (p_student).email]) identity)
    or nullif(lower(btrim(regexp_replace((p_gift).recipient_email, '[[:space:]]+', ' ', 'g'))), '')
      = nullif(lower(btrim(regexp_replace((p_student).email, '[[:space:]]+', ' ', 'g'))), ''))), false);
$$;
create function private.record_manual_gift_veto(p_gift public.gift_cards, p_student public.students, p_observation text)
returns void language sql security invoker set search_path = '' as $$
  insert into private.manual_legacy_gift_vetoes(student_id, student_sede_id, gift_card_id, gift_sede_id,
    observed_balance, match_basis, observation, student_snapshot, gift_snapshot, recorded_by)
    select (p_student).id, (p_student).sede_id, (p_gift).id, (p_gift).sede_id, (p_student).classes_remaining,
      case when (p_gift).recipient_student_id = (p_student).id then 'recipient_id' else 'normalized_label_or_email' end,
      p_observation, to_jsonb(p_student), to_jsonb(p_gift), case when p_observation <> 'rollout' then auth.uid() end
    where (p_student).classes_remaining > 0 and private.manual_gift_veto_match(p_gift, p_student)
    on conflict (student_id, gift_card_id) do nothing;
$$;
create function private.observe_manual_gift_vetoes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare g public.gift_cards; before_g public.gift_cards; after_g public.gift_cards;
  st public.students; before_st public.students; after_st public.students;
begin
  if tg_table_name = 'gift_cards' then
    after_g := new;
    if tg_op = 'UPDATE' then before_g := old; end if;
    -- NO KEY UPDATE serializes approvals but remains compatible with recipient FK key-share locks.
    for st in select s.* from public.students s where s.classes_remaining > 0
      and (private.manual_gift_veto_match(after_g, s) or private.manual_gift_veto_match(before_g, s))
      order by s.id for no key update loop
      perform private.record_manual_gift_veto(before_g, st, 'gift_write');
      perform private.record_manual_gift_veto(after_g, st, 'gift_write');
    end loop;
  else
    after_st := new;
    if tg_op = 'UPDATE' then
      before_st := old;
      if after_st.id is distinct from before_st.id and exists (
        select 1 from private.manual_legacy_gift_vetoes where student_id = before_st.id) then
        raise exception 'Observed legacy student identity is immutable';
      end if;
    end if;
    -- The source student is already locked by its DML. Reading gifts acquires no row/FK locks.
    for g in select c.* from public.gift_cards c where
      (before_st.classes_remaining > 0 and private.manual_gift_veto_match(c, before_st))
      or (after_st.classes_remaining > 0 and private.manual_gift_veto_match(c, after_st)) order by c.id loop
      perform private.record_manual_gift_veto(g, before_st, 'student_write');
      perform private.record_manual_gift_veto(g, after_st, 'student_write');
    end loop;
  end if;
  return new;
end $$;
select private.record_manual_gift_veto(g, st, 'rollout') from public.gift_cards g
  join public.students st on st.classes_remaining > 0 and private.manual_gift_veto_match(g, st)
  order by st.id, g.id;
create trigger observe_manual_gift_vetoes after insert or update of recipient_student_id, recipient, recipient_email, sede_id on public.gift_cards
  for each row execute function private.observe_manual_gift_vetoes();
create trigger observe_manual_student_gift_vetoes after insert or update of id, sede_id, classes_remaining, full_name, name, email on public.students
  for each row execute function private.observe_manual_gift_vetoes();

-- Read only the scoped denial flag. Never choose/link a financial identity from a name.
create function private.manual_legacy_gift_ambiguous(p_student_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.students st where st.id = p_student_id
    and private.session_business_read_sede(st.sede_id) and (
      exists (select 1 from private.manual_legacy_gift_vetoes v where v.student_id = st.id)
      or exists (select 1 from public.gift_cards g where private.manual_gift_veto_match(g, st))));
$$;

create view public.manual_credit_entitlements_with_balance with (security_invoker = true) as
select c.id as entitlement_id, c.student_id, c.sede_id, c.request_key, c.mode, c.quantity,
  c.expected_legacy_balance, c.activity, c.starts_on, c.ends_on, c.reason, c.evidence,
  c.approved_by, c.approved_at, c.legacy_snapshot,
  (c.quantity::bigint + coalesce((select sum(m.delta) from public.session_credit_movements m
    where m.manual_credit_id = c.id), 0)) as remaining_classes
from public.student_manual_credit_entitlements c where private.session_business_read_sede(c.sede_id);

create function public.approve_student_manual_credit(p_student_id uuid, p_request_key uuid, p_mode text,
  p_quantity integer, p_expected_legacy_balance integer, p_activity text, p_starts_on date, p_ends_on date,
  p_reason text, p_evidence text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st public.students; prior public.student_manual_credit_entitlements; intent jsonb; result jsonb; entitlement uuid;
begin
  select * into st from public.students where id = p_student_id for update;
  if st.id is null or not private.manual_credit_owner(st.sede_id) then
    raise exception 'Only this workshop owner may approve manual credits' using errcode = '42501';
  end if;
  if p_request_key is null or p_mode is null or p_mode not in ('reconcile_legacy', 'new_manual')
    or p_quantity is null or p_quantity <= 0 or p_activity is null
    or p_activity not in ('mesa', 'torno', 'coworking', 'workshop', 'privada')
    or p_starts_on is null or p_ends_on is null or not isfinite(p_starts_on) or not isfinite(p_ends_on)
    or p_ends_on < p_starts_on or p_reason is null or p_reason !~ '[^[:space:]]' or length(p_reason) > 2000
    or p_evidence is null or p_evidence !~ '[^[:space:]]' or length(p_evidence) > 10000 then
    raise exception 'Explicit mode, positive quantity, activity, finite dates, reason and evidence required';
  end if;
  intent := jsonb_build_object('student_id', p_student_id, 'mode', p_mode, 'quantity', p_quantity,
    'expected_legacy_balance', p_expected_legacy_balance, 'activity', p_activity, 'starts_on', p_starts_on,
    'ends_on', p_ends_on, 'reason', p_reason, 'evidence', p_evidence);
  select * into prior from public.student_manual_credit_entitlements where student_id = st.id and request_key = p_request_key;
  if found then
    if prior.intent <> intent then raise exception 'Idempotency key conflicts with original manual credit intent'; end if;
    return prior.result || jsonb_build_object('replayed', true);
  end if;
  if st.classes_remaining is distinct from p_expected_legacy_balance then
    raise exception 'Stale legacy balance observation' using errcode = '40001';
  end if;
  if p_mode = 'reconcile_legacy' then
    if coalesce(st.student_category, 'membresia') = 'membresia' or st.current_membership_period_id is not null
      or exists (select 1 from public.student_membership_periods where student_id = st.id) then
      raise exception 'Membership balance cannot be duplicated as manual credit';
    end if;
    if exists (select 1 from public.student_manual_credit_entitlements where student_id = st.id and mode = 'reconcile_legacy') then
      raise exception 'Legacy balance is already reconciled';
    end if;
    if st.classes_remaining is null or st.classes_remaining <= 0 or p_quantity <> st.classes_remaining then
      raise exception 'Known legacy reconciliation must allocate the exact positive observed balance';
    end if;
    if private.manual_legacy_gift_ambiguous(st.id) then
      raise exception 'Legacy balance may mirror a historical gift card; reconciliation is forbidden';
    end if;
  end if;
  entitlement := gen_random_uuid();
  result := jsonb_build_object('student_id', st.id, 'request_key', p_request_key, 'entitlement_id', entitlement,
    'remaining_classes', p_quantity, 'replayed', false);
  if not private.manual_credit_owner(st.sede_id) then
    raise exception 'Only this workshop owner may approve manual credits' using errcode = '42501';
  end if;
  insert into public.student_manual_credit_entitlements(id, student_id, sede_id, request_key, mode, quantity,
    expected_legacy_balance, activity, starts_on, ends_on, reason, evidence, approved_by, legacy_snapshot, intent, result)
    values (entitlement, st.id, st.sede_id, p_request_key, p_mode, p_quantity, p_expected_legacy_balance,
      p_activity, p_starts_on, p_ends_on, p_reason, p_evidence, auth.uid(), to_jsonb(st), intent, result);
  return result;
end $$;

-- Preserve the concrete previous implementation and its receipt snapshots.
alter function private.session_business_funding(uuid,uuid) rename to session_business_funding_before_manual;
create function private.session_business_funding(p_session_id uuid, p_student_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare s public.sessions; e public.session_students; st public.students; c record; funding jsonb; usable boolean; d date;
begin
  select * into s from public.sessions where id = p_session_id;
  select * into e from public.session_students where session_id = s.id and student_id = p_student_id;
  select * into st from public.students where id = p_student_id;
  if e.id is null or e.sede_id is distinct from s.sede_id or st.sede_id is distinct from s.sede_id then
    raise exception 'Enrollment must belong to the session sede';
  end if;
  d := private.atomic_session_date(s.date, s.start_time, s.end_time);
  if e.manual_credit_id is not null then
    if e.membership_period_id is not null or e.gift_card_id is not null then raise exception 'Ambiguous session funding'; end if;
    select * into c from public.manual_credit_entitlements_with_balance where entitlement_id = e.manual_credit_id;
    if c.entitlement_id is null or c.student_id is distinct from st.id or c.sede_id is distinct from s.sede_id then
      raise exception 'Explicit manual credit must belong to its roster student and session sede';
    end if;
    usable := c.remaining_classes > 0 and c.activity = s.class_type and st.archived_at is null
      and c.starts_on <= least(d, private.membership_today()) and c.ends_on >= greatest(d, private.membership_today());
    funding := jsonb_build_object('usable', usable, 'overridable', false, 'no_credit_allowed', c.remaining_classes = 0,
      'period_id', null, 'gift_card_id', null, 'manual_credit_id', e.manual_credit_id,
      'snapshot', jsonb_build_object('manual_credit_id', c.entitlement_id, 'quantity', c.quantity,
        'remaining_classes', c.remaining_classes, 'activity', c.activity, 'starts_on', c.starts_on, 'ends_on', c.ends_on,
        'student_category', st.student_category, 'archived_at', st.archived_at, 'session_date', s.date,
        'start_time', s.start_time, 'end_time', s.end_time, 'class_type', s.class_type),
      'reason', 'Original manual credit has no valid available credit');
  else
    funding := private.session_business_funding_before_manual(p_session_id, p_student_id);
    if e.gift_card_id is not null then
      funding := jsonb_set(funding, '{usable}', to_jsonb(coalesce((funding->>'usable')::boolean and exists (
        select 1 from public.gift_cards g where g.id = e.gift_card_id
          and g.activated_at is not null and g.activated_at <= least(d, private.membership_today())), false)));
    end if;
    -- Reconciliation supersedes only the unsupported scalar observation, never membership.
    if e.membership_period_id is null and coalesce(st.student_category, 'membresia') <> 'membresia'
      and funding->>'reason' like 'Unsupported temporal/manual funding:%'
      and exists (select 1 from public.student_manual_credit_entitlements where student_id = st.id and mode = 'reconcile_legacy') then
      funding := jsonb_set(funding, '{no_credit_allowed}', 'true');
    end if;
  end if;
  if (e.manual_credit_id is not null and coalesce(st.student_category, 'membresia') <> 'membresia'
      and st.current_membership_period_id is null and st.classes_remaining is distinct from 0
      and not exists (select 1 from public.student_manual_credit_entitlements where student_id = st.id and mode = 'reconcile_legacy'))
    or exists (select 1 from public.manual_credit_entitlements_with_balance mc where mc.student_id = st.id and mc.sede_id = s.sede_id
    and mc.remaining_classes > 0 and mc.activity = s.class_type
    and mc.starts_on <= least(d, private.membership_today()) and mc.ends_on >= greatest(d, private.membership_today()))
    or exists (select 1 from public.student_membership_periods cp
      where cp.id = st.current_membership_period_id and st.classes_remaining > 0)
    or exists (select 1 from public.gift_cards g where g.recipient_student_id = st.id and g.sede_id = s.sede_id
      and g.payment_status = 'paid' and g.status in ('active', 'pending') and g.num_classes > g.sessions_used
      and g.expiry_date >= greatest(d, private.membership_today())
      and s.class_type = case when g.type = 'torno' then 'torno' when g.type = 'modelado' then 'mesa' end) then
    funding := jsonb_set(funding, '{no_credit_allowed}', 'false');
  end if;
  return funding;
end $$;

create function private.guard_manual_session_source() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.manual_credit_id is distinct from old.manual_credit_id
    and (old.cancelled_at is not null or exists (select 1 from public.sessions where id = old.session_id and completed_at is not null)) then
    raise exception 'Original manual funding is immutable after cancellation or finalization';
  end if;
  if new.manual_credit_id is not null and exists (select 1 from public.sessions where id = new.session_id and attendance_policy_version <> 2) then
    raise exception 'Manual credit requires policy2';
  end if;
  return new;
end $$;
create trigger guard_manual_session_source before insert or update on public.session_students
  for each row execute function private.guard_manual_session_source();

alter function private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb) rename to save_session_reservation_before_manual;
drop function public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb);
create function private.save_session_reservation(p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_sede_id uuid, p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}', p_manual_credit_ids jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare s public.sessions; proposed public.sessions; prior public.session_operation_receipts;
  intent jsonb; result jsonb; roster uuid[]; active_roster uuid[]; existed boolean; locked_history boolean;
begin
  if not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if p_session_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision < 0
    or p_student_ids is null or array_position(p_student_ids, null) is not null or p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
    or p_gift_card_ids is null or jsonb_typeof(p_gift_card_ids) <> 'object'
    or p_manual_credit_ids is null or jsonb_typeof(p_manual_credit_ids) <> 'object' then
    raise exception 'Explicit session, request key, revision, metadata and ID roster required';
  end if;
  if (p_metadata - array['date', 'start_time', 'end_time', 'class_type', 'capacity', 'teacher_id', 'workshop_name', 'private_reason', 'session_audience']) <> '{}' then
    raise exception 'Unsupported reservation metadata; attendance uses its own RPC';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into s from public.sessions where id = p_session_id for update;
  existed := found;
  if existed and s.sede_id <> p_sede_id then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if existed and s.attendance_policy_version = 1 then
    if p_manual_credit_ids <> '{}' then raise exception 'Manual credit requires policy2'; end if;
    return private.save_session_reservation_before_manual(p_session_id, p_request_key, p_expected_revision, p_sede_id, p_metadata, p_student_ids, p_gift_card_ids);
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into roster from unnest(p_student_ids) id;
  if cardinality(roster) <> (select count(distinct id) from unnest(roster) id) then raise exception 'Duplicate roster student IDs'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids || p_manual_credit_ids) c where c.key <> c.key::uuid::text) then
    raise exception 'Funding map keys must be canonical lowercase hyphenated UUIDs';
  end if;
  intent := jsonb_build_object('expected_revision', p_expected_revision, 'metadata', p_metadata,
    'student_ids', to_jsonb(roster), 'gift_card_ids', p_gift_card_ids, 'sede_id', p_sede_id);
  -- Empty map retains the exact shipped intent for delayed old receipts.
  if p_manual_credit_ids <> '{}' then intent := intent || jsonb_build_object('manual_credit_ids', p_manual_credit_ids); end if;
  if existed then
    select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
    if found then
      if prior.operation <> 'reservation' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
      return prior.result || jsonb_build_object('replayed', true);
    end if;
    if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  elsif p_expected_revision <> 0 then raise exception 'Stale session revision' using errcode = '40001'; end if;
  -- Existing authorized receipts may contain numeric UUID values accepted by policy2.
  -- New operations require strings, but an exact old intent must remain replayable.
  if exists (select 1 from jsonb_each(p_gift_card_ids || p_manual_credit_ids) c
    where c.key::uuid <> all(roster) or jsonb_typeof(c.value) <> 'string') then raise exception 'Funding links must identify roster students with UUID strings'; end if;
  if exists (select 1 from jsonb_object_keys(p_manual_credit_ids) k where p_gift_card_ids ? k) then raise exception 'Ambiguous session funding'; end if;
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
  perform 1 from public.student_manual_credit_entitlements where id in (select value::uuid from jsonb_each_text(p_manual_credit_ids)
    union select manual_credit_id from public.session_students where session_id = p_session_id) order by id for update;
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
      and (gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid
        or manual_credit_id is distinct from (p_manual_credit_ids->>student_id::text)::uuid))) then raise exception 'Finalized roster and original funding are locked'; end if;
  if exists (select 1 from public.session_students where session_id = p_session_id and cancelled_at is not null and student_id = any(roster)
    and ((p_gift_card_ids ? student_id::text and gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid)
      or (p_manual_credit_ids ? student_id::text and manual_credit_id is distinct from (p_manual_credit_ids->>student_id::text)::uuid))) then raise exception 'Cancellation and its original funding are immutable'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c left join public.gift_cards g on g.id = c.value::uuid
    where g.id is null or g.sede_id is distinct from p_sede_id or g.recipient_student_id is distinct from c.key::uuid) then raise exception 'Explicit gift card must belong to its roster student and session sede'; end if;
  if exists (select 1 from jsonb_each_text(p_manual_credit_ids) c left join public.student_manual_credit_entitlements mc on mc.id = c.value::uuid
    where mc.id is null or mc.sede_id is distinct from p_sede_id or mc.student_id is distinct from c.key::uuid) then raise exception 'Explicit manual credit must belong to its roster student and session sede'; end if;
  if not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
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
    manual_credit_id = (p_manual_credit_ids->>student_id::text)::uuid,
    membership_period_id = case when p_gift_card_ids ? student_id::text or p_manual_credit_ids ? student_id::text then null
      when gift_card_id is not null or manual_credit_id is not null then (select current_membership_period_id from public.students where id = student_id)
      else membership_period_id end
    where session_id = s.id and student_id = any(active_roster) and s.completed_at is null;
  insert into public.session_students(session_id, student_id, student_name, sede_id, attendance, gift_card_id, membership_period_id, manual_credit_id, is_temporary, temp_group_name)
    select s.id, st.id, upper(trim(concat_ws(' ', st.name, st.surname))), s.sede_id, 'pending', (p_gift_card_ids->>st.id::text)::uuid,
      case when p_gift_card_ids ? st.id::text or p_manual_credit_ids ? st.id::text then null else st.current_membership_period_id end,
      (p_manual_credit_ids->>st.id::text)::uuid, st.student_category = 'temporal', case when st.student_category = 'temporal' then st.group_name end
    from public.students st where st.id = any(active_roster)
      and not exists (select 1 from public.session_students e where e.session_id = s.id and e.student_id = st.id);
  result := jsonb_build_object('session_id', s.id, 'request_key', p_request_key, 'revision', s.revision,
    'session', to_jsonb(s), 'student_ids', (select coalesce(jsonb_agg(student_id order by student_id), '[]') from public.session_students where session_id = s.id),
    'active_student_ids', to_jsonb(active_roster), 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'reservation', intent, result, auth.uid());
  return result;
end $$;
create function public.save_session_reservation(p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_sede_id uuid, p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}', p_manual_credit_ids jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select private.save_session_reservation(p_session_id, p_request_key, p_expected_revision, p_sede_id,
    p_metadata, p_student_ids, p_gift_card_ids, p_manual_credit_ids);
$$;

alter function private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid) rename to save_session_attendance_before_manual;
create function private.save_session_attendance(p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_attendance jsonb, p_finalize boolean, p_teacher_substitute_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sessions; e public.session_students; prior public.session_operation_receipts;
  b public.session_business_billing; penalty public.session_business_penalties; x public.session_business_exceptions;
  attendance jsonb; intent jsonb; result jsonb; item record; funding jsonb;
  billing_kind text; billing_state text; debit_id uuid; adjustment_id uuid; exception_id uuid;
  active_debits integer; gift_net bigint;
begin
  s := private.lock_atomic_session(p_session_id);
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if s.attendance_policy_version = 1 then
    return private.save_session_attendance_before_manual(p_session_id, p_request_key, p_expected_revision, p_attendance, p_finalize, p_teacher_substitute_id);
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
  perform 1 from public.student_manual_credit_entitlements where student_id in
    (select student_id from public.session_students where session_id = s.id) order by id for update;
  perform 1 from public.students where id in (select student_id from public.session_students where session_id = s.id) order by id for update;
  perform 1 from public.session_students where session_id = s.id order by student_id for update;
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
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
        and m.manual_credit_id is not distinct from e.manual_credit_id
        and m.delta = -1 and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id))) then
      raise exception 'Policy2 billing and original debit require reconciliation';
    end if;
    select coalesce(sum(sessions_delta), 0) into gift_net from public.gift_card_movements
      where session_id = s.id and student_id = e.student_id and movement_type in ('redeem', 'reverse');
    if gift_net <> (case when b.debit_id is not null and e.gift_card_id is not null then 1 else 0 end)
      or exists (select 1 from public.gift_card_movements where session_id = s.id and student_id = e.student_id
        and movement_type in ('redeem', 'reverse') and gift_card_id is distinct from e.gift_card_id
        group by gift_card_id having sum(sessions_delta) <> 0) then raise exception 'Policy2 gift ledger and original debit require reconciliation'; end if;
    billing_kind := case when e.cancellation_kind = 'timely' then 'timely_cancellation'
      when e.cancellation_kind = 'late' then 'late_cancellation' when item.status = 'absent' then 'no_show' else 'attendance' end;
    if p_finalize and penalty.id is null and (b.session_id is null or (billing_kind = 'no_show' and b.kind in ('attendance', 'courtesy'))) then
      debit_id := b.debit_id; exception_id := b.exception_id; adjustment_id := null;
      if billing_kind = 'timely_cancellation' then billing_state := 'no_charge';
      elsif debit_id is not null then billing_state := 'charged';
      else
        select * into x from public.session_business_exceptions where id = e.business_exception_id
          and session_id = s.id and student_id = e.student_id and sede_id = s.sede_id and not (funding->>'usable')::boolean;
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
          elsif e.manual_credit_id is null then
            adjustment_id := private.session_business_adjust(e.student_id, e.membership_period_id, -1);
          end if;
          insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, gift_card_id, manual_credit_id,
            delta, adjustment_id, disposition, created_by)
            values (s.id, e.student_id, s.sede_id, s.revision + 1, e.membership_period_id, e.gift_card_id, e.manual_credit_id, -1, adjustment_id,
              case when e.gift_card_id is not null then 'gift_card' when e.manual_credit_id is not null then 'manual_credit' else 'current_period' end, auth.uid()) returning id into debit_id;
          billing_state := 'charged';
        elsif billing_kind in ('no_show', 'late_cancellation') then billing_state := 'incident';
        else raise exception 'Presence requires valid original credit or an explicit current session exception: %', funding->>'reason'; end if;
      end if;
      if billing_kind in ('no_show', 'late_cancellation') then
        insert into public.session_business_penalties(session_id, student_id, sede_id, revision, kind, state, reason,
          period_id, gift_card_id, manual_credit_id, debit_id, created_by)
          values (s.id, e.student_id, s.sede_id, s.revision + 1, billing_kind,
            case when debit_id is null then 'pending' else 'charged' end,
            case when debit_id is null then funding->>'reason' else 'One class: ' || billing_kind end,
            e.membership_period_id, e.gift_card_id, e.manual_credit_id, debit_id, auth.uid()) returning * into penalty;
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
create or replace function public.save_session_attendance(p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_attendance jsonb, p_finalize boolean, p_teacher_substitute_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.save_session_attendance(p_session_id, p_request_key, p_expected_revision, p_attendance, p_finalize, p_teacher_substitute_id);
$$;

create function private.guard_manual_credit_movement() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare c public.student_manual_credit_entitlements; original public.session_credit_movements; balance bigint;
begin
  if new.manual_credit_id is null then return new; end if;
  select * into c from public.student_manual_credit_entitlements where id = new.manual_credit_id for update;
  if c.student_id is distinct from new.student_id or c.sede_id is distinct from new.sede_id then
    raise exception 'Manual credit movement owner mismatch';
  end if;
  if new.delta = 1 then
    select * into original from public.session_credit_movements where id = new.reverses_id;
    if original.id is null or original.delta <> -1 or original.manual_credit_id is distinct from new.manual_credit_id
      or original.session_id is distinct from new.session_id or original.student_id is distinct from new.student_id
      or original.sede_id is distinct from new.sede_id then raise exception 'Manual reversal must reference its exact original debit'; end if;
  end if;
  select c.quantity::bigint + coalesce(sum(delta), 0) into balance from public.session_credit_movements where manual_credit_id = c.id;
  if balance + new.delta not between 0 and c.quantity then raise exception 'Manual credit ledger balance out of bounds'; end if;
  return new;
end $$;
create trigger guard_manual_credit_movement before insert on public.session_credit_movements
  for each row execute function private.guard_manual_credit_movement();

create function public.settle_student_penalty(p_penalty_id uuid, p_request_key uuid, p_expected_revision bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pen public.session_business_penalties; s public.sessions; e public.session_students; st public.students;
  b public.session_business_billing; prior public.session_operation_receipts; funding jsonb; intent jsonb; result jsonb;
  settlement uuid; debit uuid; adjustment uuid;
begin
  -- This lookup takes no child/source lock. The session is always the first lock.
  select * into pen from public.session_business_penalties where id = p_penalty_id;
  s := private.lock_atomic_session(pen.session_id);
  if not private.manual_credit_owner(s.sede_id) then
    raise exception 'Only this workshop owner may settle penalties' using errcode = '42501';
  end if;
  if p_penalty_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision < 0
    or p_reason is null or p_reason !~ '[^[:space:]]' or length(p_reason) > 2000 then
    raise exception 'Penalty, request key, revision and auditable reason required';
  end if;
  intent := jsonb_build_object('penalty_id', p_penalty_id, 'expected_revision', p_expected_revision, 'reason', p_reason);
  select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
  if found then
    if prior.operation <> 'settle_student_penalty' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
    return prior.result || jsonb_build_object('replayed', true);
  end if;
  if s.attendance_policy_version <> 2 or s.completed_at is null then raise exception 'Settlement requires a finalized policy2 incident'; end if;
  if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  perform 1 from public.gift_cards where id = pen.gift_card_id for update;
  perform 1 from public.student_manual_credit_entitlements where id = pen.manual_credit_id for update;
  select * into st from public.students where id = pen.student_id for update;
  select * into e from public.session_students where session_id = s.id and student_id = pen.student_id for update;
  if not private.manual_credit_owner(s.sede_id) then
    raise exception 'Only this workshop owner may settle penalties' using errcode = '42501';
  end if;
  select * into b from public.session_business_billing where session_id = s.id and student_id = pen.student_id;
  if pen.sede_id is distinct from s.sede_id or st.sede_id is distinct from s.sede_id or e.sede_id is distinct from s.sede_id
    or e.id is null or b.session_id is null or b.sede_id is distinct from s.sede_id then raise exception 'Incident identities require reconciliation'; end if;
  if exists (select 1 from public.student_penalty_settlements where penalty_id = pen.id) then raise exception 'Penalty is already settled'; end if;
  if exists (select 1 from public.session_business_waivers where penalty_id = pen.id) then raise exception 'Penalty is already waived'; end if;
  if pen.state <> 'pending' or pen.debit_id is not null or b.state <> 'incident' or b.debit_id is not null
    or b.penalty_id is distinct from pen.id or b.kind is distinct from pen.kind
    or b.finalized_revision > pen.revision or pen.revision > s.revision
    or exists (select 1 from public.session_credit_movements m where m.session_id = s.id and m.student_id = pen.student_id
      and m.delta = -1 and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id)) then
    raise exception 'Pending original incident and billing require reconciliation';
  end if;
  if exists (select 1 from public.gift_card_movements where session_id = s.id and student_id = pen.student_id
    and movement_type in ('redeem', 'reverse') group by gift_card_id having sum(sessions_delta) <> 0) then
    raise exception 'Pending incident gift ledger requires reconciliation';
  end if;
  if num_nonnulls(pen.period_id, pen.gift_card_id, pen.manual_credit_id) <> 1
    or e.membership_period_id is distinct from pen.period_id or e.gift_card_id is distinct from pen.gift_card_id
    or e.manual_credit_id is distinct from pen.manual_credit_id then raise exception 'Only the known original incident source may settle'; end if;
  funding := private.session_business_funding(s.id, st.id);
  if not (funding->>'usable')::boolean then
    raise exception 'Original incident source is not usable: %', funding->>'reason';
  end if;
  if not private.manual_credit_owner(s.sede_id) then
    raise exception 'Only this workshop owner may settle penalties' using errcode = '42501';
  end if;
  if pen.gift_card_id is not null then
    perform private.apply_gift_card_session(pen.gift_card_id, s.id, st.id, false, gen_random_uuid());
  elsif pen.manual_credit_id is null then
    adjustment := private.session_business_adjust(st.id, pen.period_id, -1);
  end if;
  insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, gift_card_id,
    manual_credit_id, delta, adjustment_id, disposition, created_by)
    values (s.id, st.id, s.sede_id, s.revision + 1, pen.period_id, pen.gift_card_id, pen.manual_credit_id, -1, adjustment,
      case when pen.gift_card_id is not null then 'gift_card' when pen.manual_credit_id is not null then 'manual_credit' else 'current_period' end, auth.uid())
    returning id into debit;
  insert into public.student_penalty_settlements(penalty_id, student_id, session_id, sede_id, request_key, revision,
    period_id, gift_card_id, manual_credit_id, debit_id, reason, settled_by, funding_snapshot)
    values (pen.id, st.id, s.id, s.sede_id, p_request_key, s.revision + 1, pen.period_id, pen.gift_card_id,
      pen.manual_credit_id, debit, p_reason, auth.uid(), funding->'snapshot') returning id into settlement;
  update public.session_business_billing set state = 'charged', debit_id = debit where session_id = s.id and student_id = st.id;
  insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
    values (s.id, st.id, s.sede_id, s.revision + 1, 'penalty_settled',
      jsonb_build_object('penalty_id', pen.id, 'settlement_id', settlement, 'debit_id', debit, 'reason', p_reason), auth.uid());
  update public.sessions set revision = revision + 1 where id = s.id returning * into s;
  result := jsonb_build_object('student_id', st.id, 'session_id', s.id, 'penalty_id', pen.id,
    'request_key', p_request_key, 'revision', s.revision, 'settlement_id', settlement, 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'settle_student_penalty', intent, result, auth.uid());
  return result;
end $$;

alter function private.session_business_action(uuid,uuid,uuid,bigint,text,text,text) rename to session_business_action_before_manual;
create function private.session_business_action(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_operation text, p_kind text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sessions; e public.session_students; st public.students; pen public.session_business_penalties;
  debit public.session_credit_movements; prior public.session_operation_receipts;
  intent jsonb; result jsonb; funding jsonb; exception_id uuid; cancelled timestamptz; cancel_kind text;
  adjustment uuid; reversal uuid; disposition text;
begin
  s := private.lock_atomic_session(p_session_id);
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if p_operation = 'waive_session_penalty' and not private.manual_credit_owner(s.sede_id) then
    raise exception 'Only this workshop owner may waive penalties' using errcode = '42501';
  end if;
  -- Old action is safe only after all source locks, including unselected courtesy candidates.
  perform 1 from public.gift_cards where recipient_student_id = p_student_id
    or id in (select gift_card_id from public.session_students where session_id = s.id and student_id = p_student_id) order by id for update;
  perform 1 from public.student_manual_credit_entitlements where student_id = p_student_id order by id for update;
  select * into st from public.students where id = p_student_id for update;
  select * into e from public.session_students where session_id = s.id and student_id = p_student_id for update;
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode = '42501'; end if;
  if p_operation = 'waive_session_penalty' and not private.manual_credit_owner(s.sede_id) then
    raise exception 'Only this workshop owner may waive penalties' using errcode = '42501';
  end if;
  select * into pen from public.session_business_penalties where session_id = s.id and student_id = p_student_id;
  if e.manual_credit_id is null and not exists (select 1 from public.student_penalty_settlements where penalty_id = pen.id) then
    return private.session_business_action_before_manual(p_session_id, p_student_id, p_request_key, p_expected_revision, p_operation, p_kind, p_reason);
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
  if e.id is null or e.sede_id is distinct from s.sede_id or st.sede_id is distinct from s.sede_id then raise exception 'Enrollment must belong to the session sede'; end if;
  if p_operation = 'approve_session_exception' then
    if s.completed_at is not null or e.cancelled_at is not null or pen.id is not null then raise exception 'Exceptions cannot change finalized billing or penalties'; end if;
    if p_kind is null or p_kind not in ('membership_override', 'no_credit') then raise exception 'Unknown session exception kind'; end if;
    funding := private.session_business_funding(s.id, st.id);
    if p_kind = 'membership_override' then raise exception 'Membership override requires known original positive credit needing an exception'; end if;
    if not (funding->>'no_credit_allowed')::boolean then raise exception 'No-credit exception cannot bypass available credit: %', funding->>'reason'; end if;
    insert into public.session_business_exceptions(session_id, student_id, sede_id, revision, kind, manual_credit_id, funding_snapshot, reason, approved_by)
      values (s.id, st.id, s.sede_id, s.revision + 1, p_kind, e.manual_credit_id, funding->'snapshot', p_reason, auth.uid()) returning id into exception_id;
    update public.session_students set business_exception_id = exception_id where id = e.id;
    insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
      values (s.id, st.id, s.sede_id, s.revision + 1, 'exception_approved', jsonb_build_object('exception_id', exception_id, 'kind', p_kind, 'reason', p_reason), auth.uid());
  elsif p_operation = 'cancel_session_reservation' then
    if s.completed_at is not null then raise exception 'Finalized reservations cannot be cancelled'; end if;
    if e.cancelled_at is not null then raise exception 'Reservation is already cancelled'; end if;
    perform private.atomic_session_date(s.date, s.start_time, s.end_time); perform private.session_madrid_instant(s.end_time);
    cancelled := clock_timestamp();
    cancel_kind := case when cancelled <= private.session_madrid_instant(s.start_time) - interval '8 hours' then 'timely' else 'late' end;
    update public.session_students set cancelled_at = cancelled, cancellation_kind = cancel_kind, cancellation_reason = p_reason, cancelled_by = auth.uid() where id = e.id;
    insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
      values (s.id, st.id, s.sede_id, s.revision + 1, 'reservation_cancelled', jsonb_build_object('cancelled_at', cancelled, 'kind', cancel_kind, 'reason', p_reason), auth.uid());
  elsif p_operation = 'waive_session_penalty' then
    if pen.id is null then raise exception 'No recorded penalty to waive'; end if;
    if exists (select 1 from public.session_business_waivers where penalty_id = pen.id) then raise exception 'Penalty is already waived'; end if;
    select * into debit from public.session_credit_movements where id = coalesce(pen.debit_id,
      (select debit_id from public.student_penalty_settlements where penalty_id = pen.id));
    if debit.id is not null then
      if debit.session_id <> s.id or debit.student_id <> st.id or debit.sede_id <> s.sede_id or debit.delta <> -1
        or debit.period_id is distinct from pen.period_id or debit.gift_card_id is distinct from pen.gift_card_id
        or debit.manual_credit_id is distinct from pen.manual_credit_id
        or e.membership_period_id is distinct from debit.period_id or e.gift_card_id is distinct from debit.gift_card_id
        or e.manual_credit_id is distinct from debit.manual_credit_id
        or exists (select 1 from public.session_credit_movements where reverses_id = debit.id) then raise exception 'Original penalty debit requires reconciliation'; end if;
      if debit.gift_card_id is not null then
        perform private.apply_gift_card_session(debit.gift_card_id, s.id, st.id, true, gen_random_uuid());
        disposition := 'gift_card';
      elsif debit.manual_credit_id is not null then disposition := 'manual_credit';
      else
        disposition := 'original_period_credit';
        if st.current_membership_period_id = debit.period_id then
          adjustment := private.session_business_adjust(st.id, debit.period_id, 1); disposition := 'current_period';
        end if;
      end if;
      insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, gift_card_id, manual_credit_id,
        delta, reverses_id, adjustment_id, disposition, created_by)
        values (s.id, st.id, s.sede_id, s.revision + 1, debit.period_id, debit.gift_card_id, debit.manual_credit_id,
          1, debit.id, adjustment, disposition, auth.uid()) returning id into reversal;
    end if;
    insert into public.session_business_waivers(penalty_id, session_id, student_id, sede_id, revision, reason, reversal_id, waived_by)
      values (pen.id, s.id, st.id, s.sede_id, s.revision + 1, p_reason, reversal, auth.uid());
    update public.session_business_billing set state = 'waived', debit_id = null where session_id = s.id and student_id = st.id;
    insert into public.session_business_events(session_id, student_id, sede_id, revision, event, details, actor_id)
      values (s.id, st.id, s.sede_id, s.revision + 1, 'penalty_waived', jsonb_build_object('penalty_id', pen.id, 'reversal_id', reversal, 'reason', p_reason), auth.uid());
  else raise exception 'Unknown business operation'; end if;
  update public.sessions set revision = revision + 1 where id = s.id returning * into s;
  result := jsonb_build_object('session_id', s.id, 'student_id', st.id, 'request_key', p_request_key, 'revision', s.revision,
    'exception_id', exception_id, 'penalty_id', pen.id, 'cancelled_at', cancelled, 'cancellation_kind', cancel_kind, 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, p_operation, intent, result, auth.uid());
  return result;
end $$;
create or replace function public.approve_session_exception(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_kind text, p_reason text) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'approve_session_exception', p_kind, p_reason);
$$;
create or replace function public.cancel_session_reservation(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_reason text) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'cancel_session_reservation', null, p_reason);
$$;
create or replace function public.waive_session_penalty(p_session_id uuid, p_student_id uuid, p_request_key uuid,
  p_expected_revision bigint, p_reason text) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'waive_session_penalty', null, p_reason);
$$;

create or replace view public.session_business_state with (security_invoker = true) as
select e.session_id, e.student_id, s.sede_id, s.attendance_policy_version as policy_version,
  case when e.cancelled_at is null then 'reserved' else 'cancelled' end as reservation_state,
  e.cancelled_at, e.cancellation_kind, x.id as exception_id, x.kind as exception_kind,
  x.period_id as exception_period_id, x.reason as exception_reason, x.approved_by,
  case when w.penalty_id is not null then 'waived'
    when z.id is not null then 'charged' when b.state is not null then b.state
    when s.attendance_policy_version = 1 and exists (select 1 from public.session_credit_movements m
      where m.session_id = e.session_id and m.student_id = e.student_id and m.delta = -1
        and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id)) then 'charged'
    when s.attendance_policy_version = 1 and s.completed_at is not null then 'no_charge' else 'unfinalized' end as billing_state,
  coalesce(b.kind, case when s.attendance_policy_version = 1 and e.attendance = 'present' then 'attendance' end) as billing_kind,
  p.id as penalty_id, case when w.penalty_id is not null then 'waived' when z.id is not null then 'charged' else p.state end as penalty_state,
  p.reason as penalty_reason, e.cancellation_reason, e.cancelled_by, x.gift_card_id as exception_gift_card_id, x.approved_at,
  b.debit_id as billing_debit_id, e.membership_period_id as funding_period_id, e.gift_card_id as funding_gift_card_id,
  w.reason as waiver_reason, w.waived_by, w.waived_at, b.finalized_revision,
  e.manual_credit_id as funding_manual_credit_id, x.manual_credit_id as exception_manual_credit_id,
  p.manual_credit_id as penalty_manual_credit_id, z.id as settlement_id, z.debit_id as settlement_debit_id,
  z.reason as settlement_reason, z.settled_by, z.settled_at, z.revision as settlement_revision
from public.session_students e join public.sessions s on s.id = e.session_id and s.sede_id = e.sede_id
left join public.session_business_exceptions x on x.id = e.business_exception_id
  and x.session_id = e.session_id and x.student_id = e.student_id and x.sede_id = s.sede_id
left join public.session_business_billing b on b.session_id = e.session_id and b.student_id = e.student_id and b.sede_id = s.sede_id
left join public.session_business_penalties p on p.session_id = e.session_id and p.student_id = e.student_id and p.sede_id = s.sede_id
left join public.session_business_waivers w on w.penalty_id = p.id and w.sede_id = s.sede_id
left join public.student_penalty_settlements z on z.penalty_id = p.id and z.session_id = e.session_id and z.student_id = e.student_id and z.sede_id = s.sede_id
where private.session_business_read_sede(s.sede_id);

create view public.session_pending_penalties with (security_invoker = true) as
select p.id as penalty_id, p.student_id, p.session_id, p.sede_id, s.revision as expected_revision,
  p.revision as incident_revision, p.kind, p.state as original_penalty_state, p.reason as incident_reason,
  p.period_id as original_period_id, p.gift_card_id as original_gift_card_id, p.manual_credit_id as original_manual_credit_id,
  v.penalty_state, v.billing_state, v.settlement_id, v.settlement_debit_id, v.settlement_reason, v.settled_by, v.settled_at,
  v.settlement_revision, w.penalty_id is not null as is_waived,
  p.state = 'pending' and v.settlement_id is null and w.penalty_id is null as is_pending,
  p.created_by, p.created_at
from public.session_business_penalties p join public.sessions s on s.id = p.session_id and s.sede_id = p.sede_id
join public.session_business_state v on v.penalty_id = p.id and v.student_id = p.student_id and v.sede_id = p.sede_id
left join public.session_business_waivers w on w.penalty_id = p.id
where private.session_business_read_sede(p.sede_id);

create view public.student_credit_profile with (security_invoker = true) as
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

revoke all on public.manual_credit_entitlements_with_balance, public.student_credit_profile, public.session_pending_penalties,
  public.session_business_state from public, anon, authenticated, service_role;
grant select on public.manual_credit_entitlements_with_balance, public.student_credit_profile,
  public.session_pending_penalties, public.session_business_state to authenticated;
revoke all on function private.manual_credit_owner(uuid), private.manual_legacy_gift_ambiguous(uuid),
  private.manual_gift_veto_match(public.gift_cards,public.students),
  private.record_manual_gift_veto(public.gift_cards,public.students,text), private.observe_manual_gift_vetoes(),
  private.guard_manual_session_source(), private.guard_manual_credit_movement(),
  private.session_business_funding(uuid,uuid), private.session_business_funding_before_manual(uuid,uuid),
  private.save_session_reservation_before_manual(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb),
  private.save_session_attendance_before_manual(uuid,uuid,bigint,jsonb,boolean,uuid),
  private.session_business_action_before_manual(uuid,uuid,uuid,bigint,text,text,text),
  private.session_business_action(uuid,uuid,uuid,bigint,text,text,text),
  private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb),
  private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb),
  public.approve_student_manual_credit(uuid,uuid,text,integer,integer,text,date,date,text,text),
  public.settle_student_penalty(uuid,uuid,bigint,text) from public, anon, authenticated, service_role;
grant execute on function private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb),
  private.manual_legacy_gift_ambiguous(uuid),
  private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb),
  public.approve_student_manual_credit(uuid,uuid,text,integer,integer,text,date,date,text,text),
  public.settle_student_penalty(uuid,uuid,bigint,text) to authenticated;
notify pgrst, 'reload schema';
commit;
