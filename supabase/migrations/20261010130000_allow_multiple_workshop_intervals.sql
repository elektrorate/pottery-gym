-- A workshop can have several opening intervals on the same day, for example
-- 10:00-14:00 and 16:00-20:00.
alter table public.workshop_schedules
  add column if not exists slot_index smallint;

with numbered_slots as (
  select id,
         row_number() over (partition by sede_id, day_of_week order by opens_at nulls last, id) - 1 as slot_index
    from public.workshop_schedules
)
update public.workshop_schedules as schedules
   set slot_index = numbered_slots.slot_index
  from numbered_slots
 where schedules.id = numbered_slots.id
   and schedules.slot_index is null;

alter table public.workshop_schedules
  alter column slot_index set default 0,
  alter column slot_index set not null;

alter table public.workshop_schedules
  drop constraint if exists workshop_schedules_sede_day_unique,
  drop constraint if exists workshop_schedules_slot_index_valid,
  drop constraint if exists workshop_schedules_sede_day_slot_unique;

alter table public.workshop_schedules
  add constraint workshop_schedules_slot_index_valid check (slot_index between 0 and 20);

alter table public.workshop_schedules
  add constraint workshop_schedules_sede_day_slot_unique unique (sede_id, day_of_week, slot_index);
