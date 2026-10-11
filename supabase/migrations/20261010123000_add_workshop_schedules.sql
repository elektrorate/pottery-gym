-- Weekly opening hours are scoped to the workshop (sede), not to a browser.
create table if not exists public.workshop_schedules (
  id uuid primary key default gen_random_uuid(),
  sede_id uuid not null default private.current_sede_id() references public.sedes(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  is_open boolean not null default false,
  opens_at time without time zone,
  closes_at time without time zone,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workshop_schedules_hours_valid check (
    (not is_open and opens_at is null and closes_at is null)
    or (is_open and opens_at is not null and closes_at is not null and opens_at < closes_at)
  ),
  constraint workshop_schedules_sede_day_unique unique (sede_id, day_of_week)
);

revoke all on table public.workshop_schedules from anon;
grant select, insert, update, delete on table public.workshop_schedules to authenticated;
alter table public.workshop_schedules enable row level security;

drop policy if exists "workshop_schedules_select_authorized" on public.workshop_schedules;
drop policy if exists "workshop_schedules_insert_authorized" on public.workshop_schedules;
drop policy if exists "workshop_schedules_update_authorized" on public.workshop_schedules;
drop policy if exists "workshop_schedules_delete_authorized" on public.workshop_schedules;

create policy "workshop_schedules_select_authorized"
on public.workshop_schedules for select to authenticated
using ((select private.can_access_sede(sede_id)));

create policy "workshop_schedules_insert_authorized"
on public.workshop_schedules for insert to authenticated
with check ((select private.can_access_sede(sede_id)));

create policy "workshop_schedules_update_authorized"
on public.workshop_schedules for update to authenticated
using ((select private.can_access_sede(sede_id)))
with check ((select private.can_access_sede(sede_id)));

create policy "workshop_schedules_delete_authorized"
on public.workshop_schedules for delete to authenticated
using ((select private.can_access_sede(sede_id)));
