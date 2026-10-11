-- Follow-up only: do not infer recipient identities, rewrite legacy balances,
-- regenerate expiry dates, or replace any historical movement.
begin;

create or replace function public.ensure_gift_card_recipient_student_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.recipient_student_id is null then
    if tg_op = 'UPDATE' then
      if old.recipient_student_id is null
        and new.recipient is not distinct from old.recipient
        and new.sede_id is not distinct from old.sede_id then return new; end if;
    end if;
    raise exception 'Explicit recipient_student_id required; names are not identities';
  end if;
  if not exists (select 1 from public.students s
    where s.id = new.recipient_student_id and s.sede_id = new.sede_id) then
    raise exception 'Recipient must belong to the gift card sede';
  end if;
  -- Category and display-name changes never replace an explicit person.
  return new;
end $$;
revoke all on function public.ensure_gift_card_recipient_student_link()
  from public, anon, authenticated, service_role;

drop index public.gift_card_movements_redeem_unique_idx;
alter table public.gift_card_movements
  add column ledger_order bigint generated always as identity,
  add column reverses_movement_id uuid references public.gift_card_movements(id) on delete restrict;
alter table public.gift_card_movements
  drop constraint gift_card_movements_sessions_delta_check,
  add constraint gift_card_movements_sessions_delta_check
    check (sessions_delta <> 0 or movement_type = 'cancel');
create unique index gift_card_one_reversal_per_movement
  on public.gift_card_movements(reverses_movement_id) where reverses_movement_id is not null;
create index gift_card_session_ledger_idx
  on public.gift_card_movements(gift_card_id, session_id, student_id);
revoke all on sequence public.gift_card_movements_ledger_order_seq from public, anon, authenticated, service_role;

-- Restrict deletion rather than nulling identities or cascading away evidence.
alter table public.gift_card_movements
  drop constraint gift_card_movements_gift_card_id_fkey,
  drop constraint gift_card_movements_session_id_fkey,
  drop constraint gift_card_movements_student_id_fkey,
  add constraint gift_card_movements_gift_card_id_fkey foreign key (gift_card_id)
    references public.gift_cards(id) on delete restrict,
  add constraint gift_card_movements_session_id_fkey foreign key (session_id)
    references public.sessions(id) on delete restrict,
  add constraint gift_card_movements_student_id_fkey foreign key (student_id)
    references public.students(id) on delete restrict;
alter table public.gift_cards
  drop constraint gift_cards_recipient_student_id_fkey,
  add constraint gift_cards_recipient_student_id_fkey foreign key (recipient_student_id)
    references public.students(id) on delete restrict;

-- NOT VALID preserves pre-existing cross-sede anomalies for explicit review.
-- New references and later parent tenant changes cannot create another anomaly.
create unique index gift_recipient_student_sede_key on public.students(id, sede_id);
create unique index gift_session_sede_key on public.sessions(id, sede_id);
create unique index gift_card_sede_key on public.gift_cards(id, sede_id);
alter table public.gift_cards add constraint gift_card_recipient_sede_fk
  foreign key (recipient_student_id, sede_id) references public.students(id, sede_id) on delete restrict not valid;
alter table public.gift_card_movements
  add constraint gift_movement_card_sede_fk foreign key (gift_card_id, sede_id)
    references public.gift_cards(id, sede_id) on delete restrict not valid,
  add constraint gift_movement_session_sede_fk foreign key (session_id, sede_id)
    references public.sessions(id, sede_id) on delete restrict not valid,
  add constraint gift_movement_student_sede_fk foreign key (student_id, sede_id)
    references public.students(id, sede_id) on delete restrict not valid;

create table public.gift_card_operation_receipts (
  request_key uuid primary key,
  gift_card_id uuid not null references public.gift_cards(id) on delete restrict,
  sede_id uuid not null,
  session_id uuid references public.sessions(id) on delete restrict,
  student_id uuid references public.students(id) on delete restrict,
  operation text not null check (operation in ('redeem', 'reverse')),
  card_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table public.gift_card_operation_receipts
  add constraint gift_receipt_card_sede_fk foreign key (gift_card_id, sede_id)
    references public.gift_cards(id, sede_id) on delete restrict,
  add constraint gift_receipt_session_sede_fk foreign key (session_id, sede_id)
    references public.sessions(id, sede_id) on delete restrict,
  add constraint gift_receipt_student_sede_fk foreign key (student_id, sede_id)
    references public.students(id, sede_id) on delete restrict;
alter table public.gift_card_operation_receipts enable row level security;
create policy gift_card_receipts_read on public.gift_card_operation_receipts
  for select to authenticated using (auth.uid() is not null and private.can_access_sede(sede_id));
revoke all on public.gift_card_operation_receipts, public.gift_card_movements
  from public, anon, authenticated, service_role;
grant select on public.gift_card_operation_receipts, public.gift_card_movements to authenticated, service_role;
drop policy if exists gift_card_movements_insert_authorized on public.gift_card_movements;
drop policy if exists gift_card_movements_update_authorized on public.gift_card_movements;
drop policy if exists gift_card_movements_delete_authorized on public.gift_card_movements;

create function private.guard_gift_card_history() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user <> pg_get_userbyid((select relowner from pg_class where oid = tg_relid)) then
    raise exception 'Gift card history is server-managed' using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Gift card history is append-only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_gift_card_history before insert or update or delete on public.gift_card_movements
  for each row execute function private.guard_gift_card_history();
create trigger guard_gift_card_receipts before insert or update or delete on public.gift_card_operation_receipts
  for each row execute function private.guard_gift_card_history();

-- INVOKER guard: a caller-set GUC cannot impersonate a SECURITY DEFINER writer.
create function private.guard_gift_card_projection() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare canonical_expiry date;
begin
  if tg_op = 'DELETE' then
    raise exception 'Gift cards must be cancelled, not deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if current_user <> pg_get_userbyid((select relowner from pg_class
      where oid = 'public.gift_cards'::regclass)) and (
      new.sessions_used is distinct from old.sessions_used
      or new.status is distinct from old.status
      or new.consumed_at is distinct from old.consumed_at
      or new.payment_status is distinct from old.payment_status) then
      raise exception 'Protected gift card projection; use gift card RPCs' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.sede_id is distinct from old.sede_id then
      raise exception 'Gift card identity and sede are immutable';
    end if;
    if (new.num_classes is distinct from old.num_classes and (new.num_classes is null or new.num_classes < 1))
      or (new.type is distinct from old.type and (new.type is null or new.type not in ('modelado', 'torno'))) then
      raise exception 'Valid gift card allocation and type required';
    end if;
    if exists (select 1 from public.gift_card_movements where gift_card_id = old.id)
      or exists (select 1 from public.gift_card_operation_receipts where gift_card_id = old.id) then
      if new.recipient_student_id is distinct from old.recipient_student_id
        or new.num_classes is distinct from old.num_classes or new.type is distinct from old.type
        or new.activated_at is distinct from old.activated_at
        or new.validity_months is distinct from old.validity_months
        or new.expiry_date is distinct from old.expiry_date then
        raise exception 'Gift card terms and recipient are immutable after ledger use';
      end if;
    end if;
    if new.activated_at is not distinct from old.activated_at
      and new.validity_months is not distinct from old.validity_months then
      if new.expiry_date is distinct from old.expiry_date then
        raise exception 'Expiry is server-calculated from activation and validity';
      end if;
      return new;
    end if;
  else
    if coalesce(new.sessions_used, 0) <> 0 or new.consumed_at is not null
      or coalesce(new.status, 'pending') not in ('pending', 'active') then
      raise exception 'New gift cards cannot contain consumption history';
    end if;
    new.sessions_used := 0;
    new.payment_status := coalesce(new.payment_status, 'pending');
    if new.payment_status not in ('pending', 'paid') then
      raise exception 'New gift cards require pending or paid payment status';
    end if;
    new.status := case when new.payment_status = 'paid' then 'active' else 'pending' end;
    new.activated_at := coalesce(new.activated_at, (now() at time zone 'UTC')::date);
    new.validity_months := coalesce(new.validity_months, 3);
  end if;
  if new.num_classes is null or new.num_classes < 1 or new.type not in ('modelado', 'torno')
    or new.type is null or new.activated_at is null or not isfinite(new.activated_at)
    or new.validity_months is null or new.validity_months not in (3, 6, 8) then
    raise exception 'Valid gift card allocation, type, activation and validity required';
  end if;
  canonical_expiry := (new.activated_at + make_interval(months => new.validity_months))::date;
  if tg_op = 'INSERT' and new.expiry_date is not null and new.expiry_date <> canonical_expiry then
    raise exception 'Expiry is server-calculated from activation and validity';
  end if;
  new.expiry_date := canonical_expiry;
  return new;
end $$;
-- Remove the old 30-day default, not any persisted observation.
alter table public.gift_cards alter column expiry_date drop default;
create trigger guard_gift_card_projection before insert or update or delete on public.gift_cards
  for each row execute function private.guard_gift_card_projection();
revoke delete, truncate on public.gift_cards from public, anon, authenticated, service_role;
revoke all on function private.guard_gift_card_history(), private.guard_gift_card_projection()
  from public, anon, authenticated, service_role;

create function private.lock_gift_card(p_gift_card_id uuid, p_sede_id uuid default null)
returns public.gift_cards language plpgsql security definer set search_path = '' as $$
declare card public.gift_cards;
begin
  select * into card from public.gift_cards where id = p_gift_card_id for update;
  if not found then raise exception 'Bono no encontrado'; end if;
  if p_sede_id is null then
    if auth.uid() is null or not private.can_access_sede(card.sede_id) then
      raise exception 'No autorizado para este bono' using errcode = '42501';
    end if;
  elsif current_setting('role', true) <> 'service_role' or card.sede_id is distinct from p_sede_id then
    raise exception 'No autorizado para este bono' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sedes where id = card.sede_id and is_active is true) then
    raise exception 'No autorizado para una sede inactiva' using errcode = '42501';
  end if;
  return card;
end $$;

create function private.apply_gift_card_session(
  p_gift_card_id uuid, p_session_id uuid, p_student_id uuid, p_reverse boolean,
  p_request_key uuid default null, p_sede_id uuid default null
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
declare card public.gift_cards; receipt public.gift_card_operation_receipts;
  net bigint; redeem_id uuid; today date := (now() at time zone 'UTC')::date;
  manual_archive boolean;
  operation text := case when p_reverse then 'reverse' else 'redeem' end;
begin
  if p_session_id is null or p_student_id is null or p_reverse is null then
    raise exception 'Explicit session, student and operation required';
  end if;
  -- Shared attendance lock order: session -> card -> enrollment. A failed tenant
  -- check rolls back these locks together with the attempted statement.
  perform 1 from public.sessions where id = p_session_id for update;
  card := private.lock_gift_card(p_gift_card_id, p_sede_id);
  if p_request_key is not null then
    select * into receipt from public.gift_card_operation_receipts where request_key = p_request_key;
    if found then
      if receipt.gift_card_id <> card.id or receipt.session_id is distinct from p_session_id
        or receipt.student_id is distinct from p_student_id or receipt.operation <> operation then
        raise exception 'Idempotency key conflicts with original gift card operation';
      end if;
      return jsonb_populate_record(null::public.gift_cards, receipt.card_snapshot);
    end if;
  end if;
  if card.recipient_student_id is distinct from p_student_id or not exists (
    select 1 from public.students where id = p_student_id and sede_id = card.sede_id) then
    raise exception 'Student must be the explicit gift card recipient in the same sede';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = card.sede_id) then
    raise exception 'Session must belong to the gift card sede';
  end if;
  -- Lock enrollment after the card, and reject another card's enrollment.
  perform 1 from public.session_students where session_id = p_session_id and student_id = p_student_id
    and sede_id = card.sede_id and (gift_card_id is null or gift_card_id = card.id) for update;
  if not found then raise exception 'Session is not linked to the gift card recipient'; end if;
  if exists (select 1 from public.gift_card_movements where gift_card_id = card.id
    and session_id = p_session_id and student_id = p_student_id and sede_id is distinct from card.sede_id) then
    raise exception 'Legacy gift card ledger requires explicit reconciliation';
  end if;
  select coalesce(sum(sessions_delta), 0) into net from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id = p_student_id
      and movement_type in ('redeem', 'reverse');
  if net not in (0, 1) then raise exception 'Legacy gift card ledger requires explicit reconciliation'; end if;
  -- State retries are checked BEFORE availability, including the final session.
  if (p_reverse and net = 1) or (not p_reverse and net = 0) then
    if p_reverse then
      if card.sessions_used is null or card.sessions_used < 1 then
        raise exception 'Gift card balance cannot reverse its ledger; reconciliation required';
      end if;
      select m.id into redeem_id from public.gift_card_movements m
        where m.gift_card_id = card.id and m.session_id = p_session_id and m.student_id = p_student_id
          and m.movement_type = 'redeem' and not exists (
            select 1 from public.gift_card_movements r where r.reverses_movement_id = m.id)
        order by m.ledger_order desc limit 1;
      manual_archive := (card.status = 'consumed' and card.sessions_used < card.num_classes)
        or exists (select 1 from public.gift_card_movements where gift_card_id = card.id and movement_type = 'manual');
      insert into public.gift_card_movements
        (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note, reverses_movement_id)
        values (card.id, p_session_id, p_student_id, card.sede_id, 'reverse', -1,
          'Correccion de asistencia', redeem_id);
      update public.gift_cards set sessions_used = sessions_used - 1,
        status = case when card.status = 'cancelled' then 'cancelled'
          when manual_archive then 'consumed'
          when card.expiry_date < today then 'expired'
          when card.payment_status is distinct from 'paid' then 'pending' else 'active' end,
        consumed_at = case when manual_archive then card.consumed_at else null end
        where id = card.id returning * into card;
    else
      if card.payment_status is distinct from 'paid' then raise exception 'El bono no esta pagado'; end if;
      if card.status is null or card.status not in ('active', 'pending')
        or card.type is null or card.type not in ('modelado', 'torno')
        or card.expiry_date is null or card.expiry_date < today
        or card.sessions_used is null or card.num_classes is null or card.sessions_used >= card.num_classes then
        raise exception 'El bono no tiene sesiones disponibles o esta caducado';
      end if;
      if exists (select 1 from public.sessions where id = p_session_id
        and (class_type is null or class_type <> case when card.type = 'torno' then 'torno' else 'mesa' end)) then
        raise exception 'Session class type is incompatible with the gift card';
      end if;
      if exists (select 1 from public.gift_card_movements where session_id = p_session_id
        and student_id = p_student_id and gift_card_id <> card.id and movement_type in ('redeem', 'reverse')
        group by gift_card_id having sum(sessions_delta) <> 0) then
        raise exception 'Session already has another gift card consumption; reconcile its ledger first';
      end if;
      insert into public.gift_card_movements
        (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
        values (card.id, p_session_id, p_student_id, card.sede_id, 'redeem', 1, 'Asistencia validada');
      update public.session_students set gift_card_id = card.id
        where session_id = p_session_id and student_id = p_student_id;
      update public.gift_cards set sessions_used = sessions_used + 1,
        status = case when sessions_used + 1 = num_classes then 'consumed' else 'active' end,
        consumed_at = case when sessions_used + 1 = num_classes then today else null end
        where id = card.id returning * into card;
    end if;
  end if;
  if p_request_key is not null then
    insert into public.gift_card_operation_receipts
      (request_key, gift_card_id, sede_id, session_id, student_id, operation, card_snapshot, created_by)
      values (p_request_key, card.id, card.sede_id, p_session_id, p_student_id, operation, to_jsonb(card), auth.uid());
  end if;
  return card;
end $$;

create or replace function public.redeem_gift_card_session(
  p_gift_card_id uuid, p_session_id uuid, p_student_id uuid default null
) returns public.gift_cards language sql security definer set search_path = '' as $$
  select private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, false);
$$;
create or replace function public.reverse_gift_card_session(
  p_gift_card_id uuid, p_session_id uuid, p_student_id uuid default null
) returns public.gift_cards language sql security definer set search_path = '' as $$
  select private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, true);
$$;
create function public.redeem_gift_card_session_once(
  p_gift_card_id uuid, p_session_id uuid, p_student_id uuid, p_request_key uuid
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_request_key is null then raise exception 'Request key required'; end if;
  return private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, false, p_request_key);
end $$;
create function public.reverse_gift_card_session_once(
  p_gift_card_id uuid, p_session_id uuid, p_student_id uuid, p_request_key uuid
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_request_key is null then raise exception 'Request key required'; end if;
  return private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, true, p_request_key);
end $$;
create or replace function public.external_redeem_gift_card_session(
  p_sede_id uuid, p_gift_card_id uuid, p_session_id uuid, p_student_id uuid
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_sede_id is null then raise exception 'Explicit API sede required'; end if;
  return private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, false, null, p_sede_id);
end $$;
create or replace function public.external_reverse_gift_card_session(
  p_sede_id uuid, p_gift_card_id uuid, p_session_id uuid, p_student_id uuid
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_sede_id is null then raise exception 'Explicit API sede required'; end if;
  return private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, true, null, p_sede_id);
end $$;
create function public.external_redeem_gift_card_session_once(
  p_sede_id uuid, p_gift_card_id uuid, p_session_id uuid, p_student_id uuid, p_request_key uuid
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_sede_id is null or p_request_key is null then raise exception 'Explicit API sede and request key required'; end if;
  return private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, false, p_request_key, p_sede_id);
end $$;
create function public.external_reverse_gift_card_session_once(
  p_sede_id uuid, p_gift_card_id uuid, p_session_id uuid, p_student_id uuid, p_request_key uuid
) returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_sede_id is null or p_request_key is null then raise exception 'Explicit API sede and request key required'; end if;
  return private.apply_gift_card_session(p_gift_card_id, p_session_id, p_student_id, true, p_request_key, p_sede_id);
end $$;

create function private.archive_gift_card(p_gift_card_id uuid, p_cancel boolean,
  p_consumed_at date default null, p_sede_id uuid default null)
returns public.gift_cards language plpgsql security definer set search_path = '' as $$
declare card public.gift_cards; today date := (now() at time zone 'UTC')::date; remaining integer;
begin
  card := private.lock_gift_card(p_gift_card_id, p_sede_id);
  if p_cancel then
    if card.status = 'cancelled' then return card; end if;
    if card.status in ('consumed', 'exhausted') then raise exception 'El bono ya esta consumido'; end if;
    update public.gift_cards set status = 'cancelled' where id = card.id returning * into card;
    -- Cancellation is a lifecycle observation, not a fictitious class refund.
    insert into public.gift_card_movements(gift_card_id, sede_id, movement_type, sessions_delta, note)
      values (card.id, card.sede_id, 'cancel', 0, 'Anulacion confirmada');
  else
    if card.status in ('consumed', 'exhausted') then return card; end if;
    if p_consumed_at is not null and p_consumed_at <> today then
      raise exception 'Manual consumption date must be the server date';
    end if;
    if card.payment_status is distinct from 'paid' or card.status is null or card.status not in ('active', 'pending')
      or card.expiry_date is null or card.expiry_date < today then
      raise exception 'El bono no esta pagado, esta anulado o caducado';
    end if;
    if card.recipient_student_id is null or not exists (select 1 from public.students
      where id = card.recipient_student_id and sede_id = card.sede_id) then
      raise exception 'Explicit same-sede recipient required before gift card consumption';
    end if;
    remaining := card.num_classes - card.sessions_used;
    if remaining is null or remaining < 1 then raise exception 'Gift card balance requires reconciliation'; end if;
    insert into public.gift_card_movements(gift_card_id, sede_id, movement_type, sessions_delta, note)
      values (card.id, card.sede_id, 'manual', remaining, 'Consumo manual confirmado');
    update public.gift_cards set sessions_used = num_classes, status = 'consumed', consumed_at = today
      where id = card.id returning * into card;
  end if;
  return card;
end $$;
create or replace function public.consume_gift_card(p_gift_card_id uuid,
  p_consumed_at date default ((now() at time zone 'UTC')::date))
returns public.gift_cards language sql security definer set search_path = '' as $$
  select private.archive_gift_card(p_gift_card_id, false, p_consumed_at);
$$;
create or replace function public.cancel_gift_card(p_gift_card_id uuid)
returns public.gift_cards language sql security definer set search_path = '' as $$
  select private.archive_gift_card(p_gift_card_id, true);
$$;
create or replace function public.external_consume_gift_card(p_sede_id uuid, p_gift_card_id uuid,
  p_consumed_at date default ((now() at time zone 'UTC')::date))
returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_sede_id is null then raise exception 'Explicit API sede required'; end if;
  return private.archive_gift_card(p_gift_card_id, false, p_consumed_at, p_sede_id);
end $$;
create or replace function public.external_cancel_gift_card(p_sede_id uuid, p_gift_card_id uuid)
returns public.gift_cards language plpgsql security definer set search_path = '' as $$
begin
  if p_sede_id is null then raise exception 'Explicit API sede required'; end if;
  return private.archive_gift_card(p_gift_card_id, true, null, p_sede_id);
end $$;
create function public.confirm_gift_card_payment(p_gift_card_id uuid)
returns public.gift_cards language plpgsql security definer set search_path = '' as $$
declare card public.gift_cards;
begin
  card := private.lock_gift_card(p_gift_card_id);
  if card.payment_status = 'paid' then return card; end if;
  if card.payment_status is distinct from 'pending' or card.status is distinct from 'pending' then
    raise exception 'Only pending gift cards can confirm payment';
  end if;
  if card.recipient_student_id is null or not exists (select 1 from public.students
    where id = card.recipient_student_id and sede_id = card.sede_id) then
    raise exception 'Explicit same-sede recipient required before gift card payment';
  end if;
  update public.gift_cards set payment_status = 'paid',
    status = case when expiry_date < (now() at time zone 'UTC')::date then 'expired' else 'active' end
    where id = card.id returning * into card;
  return card;
end $$;

revoke all on function private.lock_gift_card(uuid,uuid),
  private.apply_gift_card_session(uuid,uuid,uuid,boolean,uuid,uuid),
  private.archive_gift_card(uuid,boolean,date,uuid) from public, anon, authenticated, service_role;
revoke all on function public.redeem_gift_card_session(uuid,uuid,uuid),
  public.reverse_gift_card_session(uuid,uuid,uuid), public.redeem_gift_card_session_once(uuid,uuid,uuid,uuid),
  public.reverse_gift_card_session_once(uuid,uuid,uuid,uuid), public.consume_gift_card(uuid,date),
  public.cancel_gift_card(uuid), public.confirm_gift_card_payment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.redeem_gift_card_session(uuid,uuid,uuid),
  public.reverse_gift_card_session(uuid,uuid,uuid), public.redeem_gift_card_session_once(uuid,uuid,uuid,uuid),
  public.reverse_gift_card_session_once(uuid,uuid,uuid,uuid), public.consume_gift_card(uuid,date),
  public.cancel_gift_card(uuid), public.confirm_gift_card_payment(uuid) to authenticated;
revoke all on function public.external_redeem_gift_card_session(uuid,uuid,uuid,uuid),
  public.external_reverse_gift_card_session(uuid,uuid,uuid,uuid),
  public.external_redeem_gift_card_session_once(uuid,uuid,uuid,uuid,uuid),
  public.external_reverse_gift_card_session_once(uuid,uuid,uuid,uuid,uuid), public.external_consume_gift_card(uuid,uuid,date),
  public.external_cancel_gift_card(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.external_redeem_gift_card_session(uuid,uuid,uuid,uuid),
  public.external_reverse_gift_card_session(uuid,uuid,uuid,uuid),
  public.external_redeem_gift_card_session_once(uuid,uuid,uuid,uuid,uuid),
  public.external_reverse_gift_card_session_once(uuid,uuid,uuid,uuid,uuid), public.external_consume_gift_card(uuid,uuid,date),
  public.external_cancel_gift_card(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
