-- Persist a capacity per scheduled class instead of relying on UI defaults.
alter table public.sessions
  add column if not exists capacity integer;

update public.sessions
set capacity = case when class_type = 'torno' then 5 else 8 end
where capacity is null;

alter table public.sessions
  alter column capacity set default 8,
  alter column capacity set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sessions_capacity_positive'
      and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions
      add constraint sessions_capacity_positive check (capacity between 1 and 100);
  end if;
end
$$;

-- Do not allow a class capacity to be lowered below its current enrolment.
create or replace function public.validate_session_capacity_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  enrolled_count integer;
begin
  select count(*)::integer
    into enrolled_count
    from public.session_students
   where session_id = new.id;

  if new.capacity < enrolled_count then
    raise exception 'La capacidad no puede ser menor que los alumnos inscritos (%).', enrolled_count
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists sessions_validate_capacity_update on public.sessions;
create trigger sessions_validate_capacity_update
before update of capacity on public.sessions
for each row execute function public.validate_session_capacity_update();

-- Protect the limit even when a client bypasses the calendar UI.
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
  select capacity
    into max_capacity
    from public.sessions
   where id = new.session_id;

  if max_capacity is null then
    return new;
  end if;

  previous_student_id := null;
  if tg_op = 'UPDATE' then
    previous_student_id := old.student_id;
  end if;

  select count(*)::integer
    into enrolled_count
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
