-- ROLLOUT GATE: deploy only with period-aware T2b consumers. The old frontend
-- cannot safely coexist with these protected membership/class projections.
-- Period payment is an observation, never inferred from legacy status.
create table public.student_membership_periods (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  sede_id uuid not null,
  predecessor_id uuid references public.student_membership_periods(id),
  request_key uuid,
  membership_tier text,
  plan_price numeric,
  allocated_classes integer check (allocated_classes >= 0),
  starts_on date,
  ends_on date,
  payment_status text check (payment_status in ('pending', 'paid')),
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  legacy_snapshot jsonb,
  outgoing_snapshot jsonb,
  unique (student_id, request_key),
  unique (student_id, id),
  check (starts_on is null or isfinite(starts_on)),
  check (ends_on is null or isfinite(ends_on)),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create unique index student_membership_one_successor
  on public.student_membership_periods(predecessor_id) where predecessor_id is not null;
alter table public.students add column current_membership_period_id uuid;
alter table public.students add constraint students_membership_owner_fk
  foreign key (id, current_membership_period_id)
  references public.student_membership_periods(student_id, id)
  deferrable initially deferred;
alter table public.student_membership_periods enable row level security;
create policy membership_period_read on public.student_membership_periods
  for select to authenticated
  using (auth.uid() is not null and private.can_access_sede(sede_id));
revoke all on public.student_membership_periods from public, anon, authenticated;
grant select on public.student_membership_periods to authenticated;

-- This trigger is INVOKER: current_user changes only across a real definer
-- boundary, not via caller-set settings. The owner is the migration owner.
create function private.guard_student_membership_projection() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user = pg_get_userbyid((select relowner from pg_class
      where oid = 'public.student_membership_periods'::regclass)) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.current_membership_period_id is not null then
      raise exception 'Membership identity must be initialized by the server';
    end if;
    return new;
  end if;
  -- Only membresia (or the NULL legacy default) is membership-managed.
  -- Known nonmembership categories keep their gift-card/group operations.
  if coalesce(old.student_category, 'membresia') <> 'membresia'
    and new.student_category is not distinct from old.student_category
    and old.current_membership_period_id is null and new.current_membership_period_id is null then
    return new;
  end if;
  if new.student_category is distinct from old.student_category
    or new.current_membership_period_id is distinct from old.current_membership_period_id
    or new.payment_status is distinct from old.payment_status
    or new.membership_tier is distinct from old.membership_tier
    or new.membership_activated_at is distinct from old.membership_activated_at
    or new.expiry_date is distinct from old.expiry_date
    or new.bonos_asignados is distinct from old.bonos_asignados
    or (old.current_membership_period_id is not null and (
      new.classes_remaining is distinct from old.classes_remaining
      or new.student_category is distinct from old.student_category
      or new.status is distinct from old.status
      or new.sede_id is distinct from old.sede_id
      or new.price is distinct from old.price)) then
    raise exception 'Protected membership projection; use period RPCs (stale class writes rejected)';
  end if;
  return new;
end $$;
revoke all on function private.guard_student_membership_projection() from public, anon, authenticated;
create trigger guard_student_membership_projection before insert or update on public.students
  for each row execute function private.guard_student_membership_projection();

create function private.membership_today() returns date
language sql stable security invoker set search_path = '' as $$
  select (now() at time zone 'Europe/Madrid')::date;
$$;
-- Keep date-only legacy values unchanged and normalize timestamp observations
-- explicitly to UTC, independent of the session timezone.
create function private.membership_expiry_date(value date) returns date
language sql immutable security invoker set search_path = '' as $$ select value; $$;
create function private.membership_expiry_date(value timestamp) returns date
language sql immutable security invoker set search_path = '' as $$ select value::date; $$;
create function private.membership_expiry_date(value timestamptz) returns date
language sql immutable security invoker set search_path = '' as $$
  select (value at time zone 'UTC')::date;
$$;
revoke all on function private.membership_expiry_date(date),
  private.membership_expiry_date(timestamp), private.membership_expiry_date(timestamptz) from public, anon;
grant execute on function private.membership_expiry_date(date),
  private.membership_expiry_date(timestamp), private.membership_expiry_date(timestamptz) to authenticated;

create function private.membership_month_end(start_date date) returns date
language sql immutable security invoker set search_path = '' as $$
  select (start_date + interval '1 month')::date - 1;
$$;
revoke all on function private.membership_today(), private.membership_month_end(date) from public, anon;
grant execute on function private.membership_today() to authenticated;

create function private.membership_plan(plan text)
returns table (price numeric, allocation integer)
language sql immutable security invoker set search_path = '' as $$
  select price, allocation from (values ('plata',90::numeric,3), ('gold',120::numeric,4),
    ('platinum',180::numeric,8)) as plans(tier, price, allocation) where tier = plan;
$$;
-- Overload dispatch preserves the target column type; DATE is never assigned
-- through a timestamptz cast that could shift a day in the caller's timezone.
create function private.membership_expiry_projection(value date, sample date) returns date
language sql immutable set search_path = '' as $$ select value; $$;
create function private.membership_expiry_projection(value date, sample timestamp) returns timestamp
language sql immutable set search_path = '' as $$ select value::timestamp; $$;
create function private.membership_expiry_projection(value date, sample timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$ select value::timestamp at time zone 'UTC'; $$;
revoke all on function private.membership_plan(text),
  private.membership_expiry_projection(date,date), private.membership_expiry_projection(date,timestamp),
  private.membership_expiry_projection(date,timestamptz) from public, anon, authenticated;

create function private.prepare_initial_student_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
declare plan_record record;
begin
  -- NULL follows the existing membership default; explicit categories do not.
  if coalesce(new.student_category, 'membresia') <> 'membresia' then return new; end if;
  if auth.uid() is null or not private.can_access_sede(new.sede_id) then
    raise exception 'Student not accessible' using errcode = '42501';
  end if;
  new.membership_tier := coalesce(new.membership_tier, 'gold');
  select * into plan_record from private.membership_plan(new.membership_tier);
  if not found or (new.bonos_asignados is not null and new.bonos_asignados <> plan_record.allocation) then
    raise exception 'Allocation must match the selected fixed membership plan';
  end if;
  new.student_category := 'membresia';
  new.current_membership_period_id := gen_random_uuid();
  new.price := plan_record.price;
  new.bonos_asignados := plan_record.allocation;
  new.classes_remaining := plan_record.allocation;
  new.payment_status := 'pending';
  new.membership_activated_at := private.membership_today();
  new.expiry_date := private.membership_expiry_projection(
    private.membership_month_end(new.membership_activated_at), new.expiry_date);
  return new;
end $$;
create function private.initialize_student_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.student_category, 'membresia') <> 'membresia' then return new; end if;
  if auth.uid() is null or not private.can_access_sede(new.sede_id) then
    raise exception 'Student not accessible' using errcode = '42501';
  end if;
  insert into public.student_membership_periods
    (id, student_id, sede_id, membership_tier, plan_price, allocated_classes,
      starts_on, ends_on, payment_status, activated_at)
  values (new.current_membership_period_id, new.id, new.sede_id, new.membership_tier,
    new.price, new.bonos_asignados, new.membership_activated_at,
    private.membership_expiry_date(new.expiry_date), 'pending', now());
  return new;
end $$;
revoke all on function private.prepare_initial_student_membership(),
  private.initialize_student_membership() from public, anon, authenticated;
-- PostgreSQL runs same-event triggers alphabetically: guard rejects caller IDs
-- before prepare generates the identity returned by INSERT ... RETURNING.
create trigger prepare_initial_student_membership before insert on public.students
  for each row execute function private.prepare_initial_student_membership();
create trigger initialize_student_membership after insert on public.students
  for each row execute function private.initialize_student_membership();

-- All callers lock the student BEFORE looking up or changing a period.
create function private.lock_membership_student(target_student uuid) returns public.students
language plpgsql security definer set search_path = '' as $$
declare s public.students;
begin
  select * into s from public.students where id = target_student for update;
  if not found or auth.uid() is null or not private.can_access_sede(s.sede_id) then
    raise exception 'Student not accessible' using errcode = '42501';
  end if;
  return s;
end $$;

create function private.reconcile_student_membership(target_student uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.students; p public.student_membership_periods; current_id uuid;
begin
  s := private.lock_membership_student(target_student);
  if coalesce(s.student_category, 'membresia') <> 'membresia' then
    raise exception 'Only membership students can manage membership periods';
  end if;
  current_id := s.current_membership_period_id;
  if current_id is null then
    insert into public.student_membership_periods
      (student_id, sede_id, membership_tier, plan_price, allocated_classes, starts_on,
       ends_on, payment_status, legacy_snapshot, activated_at)
    values (s.id, s.sede_id, s.membership_tier, s.price, s.bonos_asignados,
      s.membership_activated_at, private.membership_expiry_date(s.expiry_date),
      s.payment_status, to_jsonb(s), now()) returning id into current_id;
    update public.students set current_membership_period_id = current_id where id = s.id;
  end if;
  select * into p from public.student_membership_periods
    where predecessor_id = current_id and starts_on <= private.membership_today();
  if found then
    update public.student_membership_periods set outgoing_snapshot = to_jsonb(s)
      where id = current_id;
    update public.students set current_membership_period_id = p.id,
      membership_tier = p.membership_tier, price = p.plan_price, bonos_asignados = p.allocated_classes,
      classes_remaining = p.allocated_classes, membership_activated_at = p.starts_on,
      expiry_date = private.membership_expiry_projection(p.ends_on, s.expiry_date), payment_status = p.payment_status
      where id = s.id;
    update public.student_membership_periods set activated_at = now() where id = p.id;
    current_id := p.id;
  end if;
  return current_id;
end $$;

create function private.schedule_student_membership(
  target_student uuid, request_key uuid, plan text, class_allocation integer
) returns public.student_membership_periods
language plpgsql security definer set search_path = '' as $$
declare s public.students; p public.student_membership_periods;
  current_id uuid; start_date date; expiry date; plan_record record;
begin
  s := private.lock_membership_student(target_student);
  if coalesce(s.student_category, 'membresia') <> 'membresia' then
    raise exception 'Only membership students can renew memberships';
  end if;
  select * into plan_record from private.membership_plan(plan);
  if not found or request_key is null or class_allocation is distinct from plan_record.allocation then
    raise exception 'A request key and allocation matching the fixed membership plan are required';
  end if;
  current_id := private.reconcile_student_membership(target_student);
  select * into p from public.student_membership_periods
    where student_id = target_student and student_membership_periods.request_key = schedule_student_membership.request_key;
  if found then
    if p.membership_tier <> plan or p.allocated_classes <> class_allocation then
      raise exception 'Idempotency key conflicts with original arguments';
    end if;
    return p;
  end if;
  if exists (select 1 from public.student_membership_periods where predecessor_id = current_id) then
    raise exception 'A successor is already queued';
  end if;
  select ends_on into expiry from public.student_membership_periods where id = current_id;
  if expiry is not null and not isfinite(expiry) then raise exception 'Finite expiry required'; end if;
  start_date := greatest(private.membership_today(), coalesce(expiry + 1, private.membership_today()));
  insert into public.student_membership_periods
    (student_id, sede_id, predecessor_id, request_key, membership_tier, plan_price,
     allocated_classes, starts_on, ends_on, payment_status)
  values (s.id, s.sede_id, current_id, request_key, plan, plan_record.price, class_allocation,
    start_date, private.membership_month_end(start_date), 'pending') returning * into p;
  perform private.reconcile_student_membership(target_student);
  select * into p from public.student_membership_periods where id = p.id;
  return p;
end $$;

create function private.activate_student_membership(target_student uuid) returns public.student_membership_periods
language plpgsql security definer set search_path = '' as $$
declare current_id uuid; p public.student_membership_periods;
begin
  current_id := private.reconcile_student_membership(target_student);
  select * into p from public.student_membership_periods where id = current_id;
  return p;
end $$;

create function private.confirm_student_membership_payment(target_period uuid) returns public.student_membership_periods
language plpgsql security definer set search_path = '' as $$
declare student uuid; current_id uuid; p public.student_membership_periods;
begin
  -- Identity lookup is not a lock; all mutation locks remain student-first.
  select student_id into student from public.student_membership_periods where id = target_period;
  perform private.lock_membership_student(student);
  current_id := private.reconcile_student_membership(student);
  update public.student_membership_periods set payment_status = 'paid',
    confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(confirmed_by, auth.uid())
    where id = target_period returning * into p;
  if current_id = target_period then
    update public.students set payment_status = 'paid' where id = student;
  end if;
  return p;
end $$;

-- Durable receipts make consumption/restoration retries observational, not a
-- second adjustment. They are not accounting/payment transactions.
create table public.student_membership_class_adjustments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  sede_id uuid not null,
  period_id uuid not null,
  request_key uuid not null,
  expected_balance integer not null check (expected_balance >= 0),
  delta integer not null check (delta <> 0),
  resulting_balance integer not null check (resulting_balance >= 0),
  adjusted_by uuid not null,
  adjusted_at timestamptz not null default now(),
  unique (student_id, request_key),
  foreign key (student_id, period_id) references public.student_membership_periods(student_id,id)
);
alter table public.student_membership_class_adjustments enable row level security;
create policy membership_adjustment_read on public.student_membership_class_adjustments
  for select to authenticated using (auth.uid() is not null and private.can_access_sede(sede_id));
revoke all on public.student_membership_class_adjustments from public, anon, authenticated;
grant select on public.student_membership_class_adjustments to authenticated;

create function private.adjust_student_membership_classes(target_student uuid, target_period uuid,
  adjustment_key uuid, expected integer, class_delta integer)
returns public.student_membership_class_adjustments
language plpgsql security definer set search_path = '' as $$
declare s public.students; current_id uuid; allocation integer;
  receipt public.student_membership_class_adjustments; new_balance bigint;
begin
  s := private.lock_membership_student(target_student);
  current_id := private.reconcile_student_membership(target_student);
  if adjustment_key is null or target_period is null or expected is null or class_delta is null
    or class_delta = 0 then raise exception 'Period, key, expected balance and nonzero delta required'; end if;
  select * into receipt from public.student_membership_class_adjustments
    where student_id = target_student and request_key = adjustment_key;
  if found then
    if receipt.period_id <> target_period or receipt.expected_balance <> expected or receipt.delta <> class_delta then
      raise exception 'Idempotency key conflicts with original class adjustment';
    end if;
    return receipt;
  end if;
  if current_id <> target_period then
    raise exception 'Stale membership period' using errcode = '40001';
  end if;
  select * into s from public.students where id = target_student;
  if s.classes_remaining is distinct from expected then
    raise exception 'Stale class balance' using errcode = '40001';
  end if;
  select allocated_classes into allocation from public.student_membership_periods where id = current_id;
  new_balance := expected::bigint + class_delta::bigint;
  if allocation is null or expected < 0 or new_balance < 0 or new_balance > allocation then
    raise exception 'Class balance must remain between zero and period allocation';
  end if;
  update public.students set classes_remaining = new_balance::integer where id = target_student;
  insert into public.student_membership_class_adjustments
    (student_id,sede_id,period_id,request_key,expected_balance,delta,resulting_balance,adjusted_by)
  values (s.id,s.sede_id,current_id,adjustment_key,expected,class_delta,new_balance::integer,auth.uid())
  returning * into receipt;
  return receipt;
end $$;
create function public.adjust_student_membership_classes(student_id uuid, period_id uuid,
  request_key uuid, expected_balance integer, delta integer)
returns public.student_membership_class_adjustments
language sql security invoker set search_path = '' as $$
  select private.adjust_student_membership_classes(student_id,period_id,request_key,expected_balance,delta);
$$;
revoke all on function private.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer),
  public.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer) from public, anon;
grant execute on function private.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer),
  public.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer) to authenticated;

create function public.schedule_student_membership(student_id uuid, request_key uuid,
  membership_tier text, allocated_classes integer) returns public.student_membership_periods
language sql security invoker set search_path = '' as $$
  select private.schedule_student_membership(student_id, request_key, membership_tier, allocated_classes);
$$;
create function public.activate_student_membership(student_id uuid) returns public.student_membership_periods
language sql security invoker set search_path = '' as $$
  select private.activate_student_membership(student_id);
$$;
create function public.confirm_student_membership_payment(period_id uuid) returns public.student_membership_periods
language sql security invoker set search_path = '' as $$
  select private.confirm_student_membership_payment(period_id);
$$;
revoke all on function private.lock_membership_student(uuid),
  private.reconcile_student_membership(uuid), private.activate_student_membership(uuid),
  private.schedule_student_membership(uuid,uuid,text,integer),
  private.confirm_student_membership_payment(uuid) from public, anon, authenticated;
grant execute on function private.activate_student_membership(uuid),
  private.schedule_student_membership(uuid,uuid,text,integer),
  private.confirm_student_membership_payment(uuid) to authenticated;
revoke all on function public.activate_student_membership(uuid),
  public.schedule_student_membership(uuid,uuid,text,integer),
  public.confirm_student_membership_payment(uuid) from public, anon;
grant execute on function public.activate_student_membership(uuid),
  public.schedule_student_membership(uuid,uuid,text,integer),
  public.confirm_student_membership_payment(uuid) to authenticated;

create view public.students_effective_membership with (security_invoker = true) as
select s.id as student_id, s.sede_id, s.archived_at,
  p.id as effective_period_id, s.current_membership_period_id as materialized_period_id,
  coalesce(p.membership_tier, s.membership_tier) as membership_tier,
  case when p.id is null then s.price else p.plan_price end as plan_price,
  coalesce(p.allocated_classes, s.bonos_asignados) as allocated_classes,
  case when p.id is distinct from s.current_membership_period_id and p.id is not null
    then p.allocated_classes else s.classes_remaining end as classes_remaining,
  case when p.id is null then s.membership_activated_at else p.starts_on end as starts_on,
  case when p.id is null then private.membership_expiry_date(s.expiry_date) else p.ends_on end as ends_on,
  case when p.id is null then s.payment_status else p.payment_status end as payment_status,
  p.confirmed_at, p.confirmed_by
from public.students s
left join lateral (
  select candidate.* from public.student_membership_periods candidate
  where candidate.student_id = s.id and (
    candidate.id = s.current_membership_period_id or
    (candidate.predecessor_id = s.current_membership_period_id
      and candidate.starts_on <= private.membership_today()))
  order by (candidate.id = s.current_membership_period_id) asc limit 1
) p on true;
revoke all on public.students_effective_membership from public, anon;
grant select on public.students_effective_membership to authenticated;

create or replace function public.student_lifecycle(
  category text, payment text, legacy_status text, due_date date,
  manual_archive date, as_of date
) returns text language sql immutable security invoker set search_path = '' as $$
  select case when manual_archive is not null then 'archived'
    when category = 'temporal' then 'temporary'
    when due_date is not null and as_of - due_date >= 6 then 'expired'
    when due_date is null or due_date < as_of then 'pending'
    when payment is distinct from 'paid' then 'pending' else 'active' end;
$$;
notify pgrst, 'reload schema';
