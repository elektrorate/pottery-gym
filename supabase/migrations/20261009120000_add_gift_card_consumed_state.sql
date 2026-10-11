alter table public.gift_cards
  add column if not exists consumed_at date;

alter table public.gift_cards
  drop constraint if exists gift_cards_status_check;

alter table public.gift_cards
  add constraint gift_cards_status_check check (status in ('pending', 'active', 'exhausted', 'consumed', 'expired', 'cancelled'));

create index if not exists gift_cards_consumed_at_idx on public.gift_cards(consumed_at);

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
  if card.status in ('cancelled', 'exhausted', 'consumed', 'expired') then raise exception 'El bono no tiene sesiones disponibles'; end if;
  if p_student_id is null or not exists (
    select 1
    from public.session_students
    where session_id = p_session_id
      and student_id = p_student_id
      and sede_id = card.sede_id
  ) then
    raise exception 'La sesión no está vinculada al alumno del bono';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = card.sede_id) then
    raise exception 'La sesión no pertenece al taller del bono';
  end if;
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
        status = case when coalesce(sessions_used, 0) + 1 >= num_classes then 'consumed' else 'active' end,
        consumed_at = case when coalesce(sessions_used, 0) + 1 >= num_classes then today else null end
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
begin
  select * into card from public.gift_cards where id = p_gift_card_id for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if p_student_id is null or not exists (
    select 1
    from public.session_students
    where session_id = p_session_id
      and student_id = p_student_id
      and sede_id = card.sede_id
  ) then
    raise exception 'La sesión no está vinculada al alumno del bono';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = card.sede_id) then
    raise exception 'La sesión no pertenece al taller del bono';
  end if;

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
      status = case when expiry_date < (now() at time zone 'UTC')::date then 'expired' else 'active' end,
      consumed_at = null
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;

create or replace function public.consume_gift_card(
  p_gift_card_id uuid,
  p_consumed_at date default ((now() at time zone 'UTC')::date)
)
returns public.gift_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.gift_cards;
begin
  select * into card from public.gift_cards where id = p_gift_card_id for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if card.status in ('cancelled', 'consumed', 'exhausted') then raise exception 'El bono ya está archivado'; end if;
  if card.expiry_date < ((now() at time zone 'UTC')::date) then
    update public.gift_cards set status = 'expired' where id = card.id;
    raise exception 'El bono temporal está caducado';
  end if;

  update public.gift_cards
  set status = 'consumed', consumed_at = coalesce(p_consumed_at, (now() at time zone 'UTC')::date)
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;

create or replace function public.cancel_gift_card(
  p_gift_card_id uuid
)
returns public.gift_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.gift_cards;
begin
  select * into card
  from public.gift_cards
  where id = p_gift_card_id
  for update;

  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if card.status in ('cancelled', 'consumed', 'exhausted') then raise exception 'El bono ya está archivado'; end if;

  update public.gift_cards
  set status = 'cancelled'
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;

revoke all on function public.redeem_gift_card_session(uuid, uuid, uuid) from public, anon;
revoke all on function public.reverse_gift_card_session(uuid, uuid, uuid) from public, anon;
revoke all on function public.consume_gift_card(uuid, date) from public, anon;
revoke all on function public.cancel_gift_card(uuid) from public, anon;
grant execute on function public.redeem_gift_card_session(uuid, uuid, uuid) to authenticated;
grant execute on function public.reverse_gift_card_session(uuid, uuid, uuid) to authenticated;
grant execute on function public.consume_gift_card(uuid, date) to authenticated;
grant execute on function public.cancel_gift_card(uuid) to authenticated;
