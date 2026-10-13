-- Temporary students follow the lifecycle of their gift-card bonuses.
-- The database remains the source of truth so attendance, manual redemption
-- and retries all apply the same rule atomically.

create or replace function private.sync_temporary_student_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  student_row public.students;
  today date := (now() at time zone 'Europe/Madrid')::date;
begin
  if new.recipient_student_id is null then
    return new;
  end if;

  select * into student_row
  from public.students
  where id = new.recipient_student_id
  for update;

  if student_row.id is null or student_row.student_category <> 'temporal' then
    return new;
  end if;

  -- Assigning a new usable bonus reactivates an archived temporary student.
  if new.status in ('active', 'pending')
    and coalesce(new.sessions_used, 0) < coalesce(new.num_classes, 0)
    and (new.expiry_date is null or new.expiry_date >= today) then
    if student_row.archived_at is not null then
      update public.students set archived_at = null where id = student_row.id;
    end if;
    return new;
  end if;

  -- Exhausting one bonus archives only when no other usable bonus remains.
  if new.status not in ('exhausted', 'consumed')
    or coalesce(new.sessions_used, 0) < coalesce(new.num_classes, 0)
    or student_row.archived_at is not null then
    return new;
  end if;

  if exists (
    select 1
    from public.gift_cards card
    where card.recipient_student_id = student_row.id
      and card.id <> new.id
      and card.status in ('active', 'pending')
      and coalesce(card.sessions_used, 0) < coalesce(card.num_classes, 0)
      and (card.expiry_date is null or card.expiry_date >= today)
  ) then
    return new;
  end if;

  update public.students
  set archived_at = coalesce(archived_at, today)
  where id = student_row.id
    and archived_at is null;
  return new;
end;
$$;

revoke all on function private.sync_temporary_student_archive() from public, anon, authenticated, service_role;

drop trigger if exists sync_temporary_student_archive on public.gift_cards;
create trigger sync_temporary_student_archive
after insert or update of status, sessions_used, num_classes, recipient_student_id, expiry_date
on public.gift_cards
for each row execute function private.sync_temporary_student_archive();

comment on function private.sync_temporary_student_archive() is
  'Archives temporary students when their last usable gift card is exhausted and reactivates them when a new usable card is assigned.';

-- Older temporary students may still carry their balance directly on students
-- (classes_remaining/bonos_asignados) instead of having a gift_cards row. Keep
-- that legacy representation under the same lifecycle rule.
create or replace function private.sync_legacy_temporary_student_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Europe/Madrid')::date;
begin
  if coalesce(new.student_category, 'membresia') <> 'temporal' then
    return new;
  end if;

  -- A usable Gift Card or a positive legacy balance reactivates the student.
  if coalesce(new.classes_remaining, 0) > 0
    or exists (
      select 1
      from public.gift_cards card
      where card.recipient_student_id = new.id
        and card.status in ('active', 'pending')
        and coalesce(card.sessions_used, 0) < coalesce(card.num_classes, 0)
        and (card.expiry_date is null or card.expiry_date >= today)
    ) then
    if new.archived_at is not null then
      update public.students set archived_at = null where id = new.id;
    end if;
    return new;
  end if;

  -- Do not archive an empty draft that never received a bonus. Once a
  -- temporary bonus was assigned, zero legacy balance means it is exhausted.
  if new.archived_at is null
    and coalesce(new.bonos_asignados, 0) > 0
    and not exists (
      select 1
      from public.gift_cards card
      where card.recipient_student_id = new.id
        and card.status in ('active', 'pending')
        and coalesce(card.sessions_used, 0) < coalesce(card.num_classes, 0)
        and (card.expiry_date is null or card.expiry_date >= today)
    ) then
    update public.students set archived_at = today where id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function private.sync_legacy_temporary_student_archive() from public, anon, authenticated, service_role;

drop trigger if exists sync_legacy_temporary_student_archive on public.students;
create trigger sync_legacy_temporary_student_archive
after insert or update of student_category, classes_remaining, bonos_asignados
on public.students
for each row execute function private.sync_legacy_temporary_student_archive();

comment on function private.sync_legacy_temporary_student_archive() is
  'Archives legacy temporary students when their direct balance reaches zero and reactivates them when balance or a usable Gift Card returns.';

-- Backfill unarchived temporary students with either a demonstrably exhausted
-- Gift Card or an exhausted legacy balance.
update public.students student
set archived_at = coalesce(student.archived_at, (now() at time zone 'Europe/Madrid')::date)
where student.student_category = 'temporal'
  and student.archived_at is null
  and (
    (
      coalesce(student.bonos_asignados, 0) > 0
      and coalesce(student.classes_remaining, 0) <= 0
    )
    or exists (
      select 1 from public.gift_cards exhausted
      where exhausted.recipient_student_id = student.id
        and exhausted.status in ('exhausted', 'consumed')
        and coalesce(exhausted.sessions_used, 0) >= coalesce(exhausted.num_classes, 0)
    )
  )
  and not exists (
    select 1 from public.gift_cards usable
    where usable.recipient_student_id = student.id
      and usable.status in ('active', 'pending')
      and coalesce(usable.sessions_used, 0) < coalesce(usable.num_classes, 0)
      and (usable.expiry_date is null or usable.expiry_date >= (now() at time zone 'Europe/Madrid')::date)
  );

