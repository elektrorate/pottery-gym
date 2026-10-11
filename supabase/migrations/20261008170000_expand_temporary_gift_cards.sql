alter table public.gift_cards
  add column if not exists code text,
  add column if not exists buyer_phone text,
  add column if not exists buyer_email text,
  add column if not exists recipient_email text,
  add column if not exists validity_months integer,
  add column if not exists activated_at date,
  add column if not exists price numeric(10, 2),
  add column if not exists payment_status text,
  add column if not exists status text,
  add column if not exists sessions_used integer,
  add column if not exists delivery_format text,
  add column if not exists dedication text,
  add column if not exists internal_notes text;

update public.gift_cards
set code = coalesce(code, 'CR-' || upper(substr(replace(id::text, '-', ''), 1, 10))),
    validity_months = coalesce(validity_months, 3),
    activated_at = coalesce(activated_at, (coalesce(scheduled_date, created_at) at time zone 'UTC')::date),
    payment_status = coalesce(payment_status, 'paid'),
    sessions_used = coalesce(sessions_used, 0),
    delivery_format = coalesce(delivery_format, 'digital'),
    status = case
      when coalesce(sessions_used, 0) >= num_classes then 'exhausted'
      when expiry_date < (now() at time zone 'UTC')::date then 'expired'
      else coalesce(status, 'active')
    end
where code is null
   or validity_months is null
   or activated_at is null
   or payment_status is null
   or sessions_used is null
   or delivery_format is null
   or status is null;

alter table public.gift_cards
  alter column code set default ('CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  alter column validity_months set default 3,
  alter column payment_status set default 'pending',
  alter column sessions_used set default 0,
  alter column delivery_format set default 'digital',
  alter column status set default 'pending';

create unique index if not exists gift_cards_code_unique_idx on public.gift_cards(code);
create index if not exists gift_cards_status_idx on public.gift_cards(status);
create index if not exists gift_cards_expiry_date_idx on public.gift_cards(expiry_date);

alter table public.gift_cards
  drop constraint if exists gift_cards_validity_months_check,
  drop constraint if exists gift_cards_payment_status_check,
  drop constraint if exists gift_cards_status_check,
  drop constraint if exists gift_cards_delivery_format_check,
  drop constraint if exists gift_cards_sessions_used_check;

alter table public.gift_cards
  add constraint gift_cards_validity_months_check check (validity_months in (3, 6, 8)),
  add constraint gift_cards_payment_status_check check (payment_status in ('pending', 'paid', 'refunded')),
  add constraint gift_cards_status_check check (status in ('pending', 'active', 'exhausted', 'expired', 'cancelled')),
  add constraint gift_cards_delivery_format_check check (delivery_format in ('digital', 'physical')),
  add constraint gift_cards_sessions_used_check check (sessions_used >= 0 and sessions_used <= num_classes);

create table if not exists public.gift_card_movements (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.gift_cards(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  student_id uuid references public.students(id) on delete set null,
  sede_id uuid not null default private.current_sede_id(),
  movement_type text not null check (movement_type in ('redeem', 'reverse', 'manual', 'cancel')),
  sessions_delta integer not null check (sessions_delta <> 0),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists gift_card_movements_card_idx on public.gift_card_movements(gift_card_id, created_at desc);
create unique index if not exists gift_card_movements_redeem_unique_idx
  on public.gift_card_movements(gift_card_id, session_id, student_id)
  where movement_type = 'redeem';

alter table public.session_students
  add column if not exists gift_card_id uuid references public.gift_cards(id) on delete set null;

create index if not exists session_students_gift_card_idx on public.session_students(gift_card_id);

alter table public.gift_card_movements enable row level security;
grant select, insert, update, delete on table public.gift_card_movements to authenticated;

drop policy if exists gift_card_movements_select_authorized on public.gift_card_movements;
drop policy if exists gift_card_movements_insert_authorized on public.gift_card_movements;
drop policy if exists gift_card_movements_update_authorized on public.gift_card_movements;
drop policy if exists gift_card_movements_delete_authorized on public.gift_card_movements;

create policy gift_card_movements_select_authorized
on public.gift_card_movements for select to authenticated
using ((select private.can_access_sede(sede_id)));

create policy gift_card_movements_insert_authorized
on public.gift_card_movements for insert to authenticated
with check ((select private.can_access_sede(sede_id)));

create policy gift_card_movements_update_authorized
on public.gift_card_movements for update to authenticated
using ((select private.can_access_sede(sede_id)))
with check ((select private.can_access_sede(sede_id)));

create policy gift_card_movements_delete_authorized
on public.gift_card_movements for delete to authenticated
using ((select private.can_access_sede(sede_id)));

create or replace function public.redeem_gift_card_session(
  p_gift_card_id uuid,
  p_session_id uuid,
  p_student_id uuid default null
)
returns public.gift_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.gift_cards;
  inserted_id uuid;
  today date := (now() at time zone 'UTC')::date;
begin
  select * into card
  from public.gift_cards
  where id = p_gift_card_id
  for update;

  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if card.payment_status <> 'paid' then raise exception 'El bono no está pagado'; end if;
  if card.status in ('cancelled', 'exhausted') then raise exception 'El bono no tiene sesiones disponibles'; end if;
  if card.expiry_date < today then
    update public.gift_cards set status = 'expired' where id = card.id;
    raise exception 'El bono temporal está caducado';
  end if;
  if coalesce(card.sessions_used, 0) >= card.num_classes then raise exception 'El bono no tiene sesiones disponibles'; end if;

  insert into public.gift_card_movements (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_session_id, p_student_id, card.sede_id, 'redeem', 1, 'Asistencia validada')
  on conflict (gift_card_id, session_id, student_id) where movement_type = 'redeem' do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    update public.gift_cards
    set sessions_used = coalesce(sessions_used, 0) + 1,
        status = case when coalesce(sessions_used, 0) + 1 >= num_classes then 'exhausted' else 'active' end
    where id = card.id;
  end if;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;

create or replace function public.reverse_gift_card_session(
  p_gift_card_id uuid,
  p_session_id uuid,
  p_student_id uuid default null
)
returns public.gift_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.gift_cards;
  inserted_id uuid;
begin
  select * into card from public.gift_cards where id = p_gift_card_id for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;

  if exists (
    select 1 from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id is not distinct from p_student_id and movement_type = 'reverse'
  ) then
    return card;
  end if;

  if not exists (
    select 1 from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id is not distinct from p_student_id and movement_type = 'redeem'
  ) then
    return card;
  end if;

  insert into public.gift_card_movements (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_session_id, p_student_id, card.sede_id, 'reverse', -1, 'Corrección de asistencia');

  update public.gift_cards
  set sessions_used = greatest(0, coalesce(sessions_used, 0) - 1),
      status = case when expiry_date < (now() at time zone 'UTC')::date then 'expired' else 'active' end
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;

revoke all on function public.redeem_gift_card_session(uuid, uuid, uuid) from public, anon;
revoke all on function public.reverse_gift_card_session(uuid, uuid, uuid) from public, anon;
grant execute on function public.redeem_gift_card_session(uuid, uuid, uuid) to authenticated;
grant execute on function public.reverse_gift_card_session(uuid, uuid, uuid) to authenticated;
