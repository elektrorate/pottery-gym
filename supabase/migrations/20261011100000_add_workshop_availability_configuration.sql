-- Persistent per-workshop defaults and date-specific opening exceptions.
create table if not exists public.workshop_capacity_defaults (
  id uuid primary key default gen_random_uuid(),
  sede_id uuid not null references public.sedes(id) on delete cascade,
  class_type text not null check (class_type in ('mesa', 'torno', 'coworking', 'workshop', 'privada')),
  capacity integer not null check (capacity between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workshop_capacity_defaults_sede_type_unique unique (sede_id, class_type)
);

insert into public.workshop_capacity_defaults (sede_id, class_type, capacity)
select sedes.id, activity.class_type, case when activity.class_type = 'torno' then 5 else 8 end
from public.sedes sedes
cross join (values ('mesa'), ('torno'), ('coworking'), ('workshop'), ('privada')) as activity(class_type)
on conflict (sede_id, class_type) do nothing;

revoke all on table public.workshop_capacity_defaults from anon;
grant select, insert, update on table public.workshop_capacity_defaults to authenticated;
alter table public.workshop_capacity_defaults enable row level security;

create policy "workshop_capacity_defaults_select_authorized"
on public.workshop_capacity_defaults for select to authenticated
using ((select private.can_access_sede(sede_id)));

create policy "workshop_capacity_defaults_insert_authorized"
on public.workshop_capacity_defaults for insert to authenticated
with check ((select private.can_access_sede(sede_id)));

create policy "workshop_capacity_defaults_update_authorized"
on public.workshop_capacity_defaults for update to authenticated
using ((select private.can_access_sede(sede_id)))
with check ((select private.can_access_sede(sede_id)));

create table if not exists public.workshop_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  sede_id uuid not null references public.sedes(id) on delete cascade,
  exception_date date not null,
  slot_index smallint not null default 0 check (slot_index between 0 and 20),
  is_open boolean not null default false,
  opens_at time without time zone,
  closes_at time without time zone,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workshop_schedule_exceptions_hours_valid check (
    (not is_open and opens_at is null and closes_at is null)
    or (is_open and opens_at is not null and closes_at is not null and opens_at < closes_at)
  ),
  constraint workshop_schedule_exceptions_date_slot_unique unique (sede_id, exception_date, slot_index)
);

create index if not exists workshop_schedule_exceptions_sede_date_idx
  on public.workshop_schedule_exceptions(sede_id, exception_date);

revoke all on table public.workshop_schedule_exceptions from anon;
grant select, insert, update, delete on table public.workshop_schedule_exceptions to authenticated;
alter table public.workshop_schedule_exceptions enable row level security;

create policy "workshop_schedule_exceptions_select_authorized"
on public.workshop_schedule_exceptions for select to authenticated
using ((select private.can_access_sede(sede_id)));

create policy "workshop_schedule_exceptions_insert_authorized"
on public.workshop_schedule_exceptions for insert to authenticated
with check ((select private.can_access_sede(sede_id)));

create policy "workshop_schedule_exceptions_update_authorized"
on public.workshop_schedule_exceptions for update to authenticated
using ((select private.can_access_sede(sede_id)))
with check ((select private.can_access_sede(sede_id)));

create policy "workshop_schedule_exceptions_delete_authorized"
on public.workshop_schedule_exceptions for delete to authenticated
using ((select private.can_access_sede(sede_id)));

-- Replace all rows for one scope in a single transaction so a failed save cannot
-- leave half of a weekly schedule or exception behind.
create or replace function public.replace_workshop_schedule(
  p_sede_id uuid,
  p_schedule jsonb
)
returns setof public.workshop_schedules
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not private.can_access_sede(p_sede_id) then
    raise exception 'No autorizado para esta sede';
  end if;

  delete from public.workshop_schedules where sede_id = p_sede_id;

  insert into public.workshop_schedules (sede_id, day_of_week, slot_index, is_open, opens_at, closes_at)
  select p_sede_id, item.day_of_week, item.slot_index, item.is_open, item.opens_at, item.closes_at
  from jsonb_to_recordset(coalesce(p_schedule, '[]'::jsonb)) as item(
    day_of_week smallint,
    slot_index smallint,
    is_open boolean,
    opens_at time,
    closes_at time
  );

  return query
  select * from public.workshop_schedules
  where sede_id = p_sede_id
  order by day_of_week, slot_index;
end;
$$;

revoke all on function public.replace_workshop_schedule(uuid, jsonb) from public, anon;
grant execute on function public.replace_workshop_schedule(uuid, jsonb) to authenticated;

create or replace function public.replace_workshop_schedule_exception(
  p_sede_id uuid,
  p_exception_date date,
  p_slots jsonb
)
returns setof public.workshop_schedule_exceptions
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not private.can_access_sede(p_sede_id) then
    raise exception 'No autorizado para esta sede';
  end if;

  delete from public.workshop_schedule_exceptions
  where sede_id = p_sede_id and exception_date = p_exception_date;

  insert into public.workshop_schedule_exceptions (sede_id, exception_date, slot_index, is_open, opens_at, closes_at, reason)
  select p_sede_id, p_exception_date, item.slot_index, item.is_open, item.opens_at, item.closes_at, item.reason
  from jsonb_to_recordset(coalesce(p_slots, '[]'::jsonb)) as item(
    slot_index smallint,
    is_open boolean,
    opens_at time,
    closes_at time,
    reason text
  );

  return query
  select * from public.workshop_schedule_exceptions
  where sede_id = p_sede_id and exception_date = p_exception_date
  order by slot_index;
end;
$$;

revoke all on function public.replace_workshop_schedule_exception(uuid, date, jsonb) from public, anon;
grant execute on function public.replace_workshop_schedule_exception(uuid, date, jsonb) to authenticated;

-- Lock the parent session while counting so two concurrent last-place inserts
-- cannot both pass the capacity check.
create or replace function public.validate_session_student_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  max_capacity integer;
  enrolled_count integer;
  previous_student_id uuid;
begin
  select capacity into max_capacity
  from public.sessions
  where id = new.session_id
  for update;

  if max_capacity is null then return new; end if;

  previous_student_id := null;
  if tg_op = 'UPDATE' then previous_student_id := old.student_id; end if;

  select count(distinct student_id)::integer into enrolled_count
  from public.session_students
  where session_id = new.session_id
    and student_id is distinct from previous_student_id;

  if enrolled_count >= max_capacity then
    raise exception 'La sesión ya ha alcanzado su capacidad máxima de % alumnos.', max_capacity
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists session_students_validate_capacity on public.session_students;
create trigger session_students_validate_capacity
before insert or update of session_id, student_id on public.session_students
for each row execute function public.validate_session_student_capacity();
