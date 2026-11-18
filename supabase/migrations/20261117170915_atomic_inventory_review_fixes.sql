-- Every insert, including older clients, validates stock under the item lock.
-- The invoker's existing tenant RLS remains in force.
alter table public.inventory_movements add column if not exists request_payload jsonb;

create or replace function public.validate_inventory_movement()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  item public.inventory_items%rowtype;
  balance numeric;
begin
  if auth.uid() is null then raise exception 'Inicia sesión antes de registrar un movimiento.' using errcode='42501'; end if;
  if new.inventory_item_id is distinct from coalesce(new.item_id,new.inventory_item_id) then
    raise exception 'El movimiento debe referirse a un único material.' using errcode='22023';
  end if;
  select * into item from public.inventory_items where id=new.inventory_item_id for update;
  if not found then raise exception 'Material no disponible para esta sede.' using errcode='42501'; end if;
  if item.status::text='archived' then raise exception 'No se pueden mover existencias de un material archivado.' using errcode='22023'; end if;
  if new.sede_id is not null and new.sede_id<>item.sede_id then raise exception 'La sede no coincide con el material.' using errcode='42501'; end if;
  if nullif(btrim(new.reason),'') is null then raise exception 'El motivo es obligatorio.' using errcode='22023'; end if;
  balance := coalesce(item.current_quantity,0);
  if balance<0 or balance::text in ('NaN','Infinity','-Infinity') then raise exception 'El saldo actual no es válido.' using errcode='22023'; end if;
  if new.type::text='adjust' then
    if new.new_quantity is null or new.new_quantity<0 or new.new_quantity::text in ('NaN','Infinity','-Infinity') then
      raise exception 'El saldo ajustado debe ser un número mayor o igual a cero.' using errcode='22023';
    end if;
    new.quantity := abs(new.new_quantity-balance);
  else
    if new.quantity is null or new.quantity<=0 or new.quantity::text in ('NaN','Infinity','-Infinity') then
      raise exception 'La cantidad debe ser un número mayor que cero.' using errcode='22023';
    end if;
    if new.type::text='out' and new.quantity>balance then
      raise exception 'La salida no puede superar las existencias disponibles.' using errcode='22023';
    end if;
    new.new_quantity := case when new.type::text='in' then balance+new.quantity else balance-new.quantity end;
  end if;
  if new.unit is not null and new.unit is distinct from item.unit then
    raise exception 'La unidad debe coincidir con la unidad del material.' using errcode='22023';
  end if;
  new.item_id := item.id;
  new.sede_id := item.sede_id;
  new.user_id := auth.uid();
  new.unit := item.unit;
  update public.inventory_items set current_quantity=new.new_quantity,updated_at=now() where id=item.id;
  if not found then raise exception 'No tienes permiso para actualizar este material.' using errcode='42501'; end if;
  return new;
end;
$$;
revoke all on function public.validate_inventory_movement() from public,anon;
create trigger validate_inventory_movement before insert on public.inventory_movements
for each row execute function public.validate_inventory_movement();

create or replace function public.record_inventory_movement(
  p_request_id uuid,p_item_id uuid,p_type text,p_quantity numeric,p_new_quantity numeric,
  p_unit text,p_reason text,p_date text,p_notes text,p_expected_quantity numeric
) returns public.inventory_movements
language plpgsql security invoker set search_path = '' as $$
declare
  item public.inventory_items%rowtype;
  result public.inventory_movements%rowtype;
  payload jsonb;
begin
  if auth.uid() is null or p_request_id is null then raise exception 'Inicia sesión y proporciona un identificador de operación.' using errcode='42501'; end if;
  if p_type not in ('in','out','adjust') or p_type is null then raise exception 'Tipo de movimiento no válido.' using errcode='22023'; end if;
  select * into item from public.inventory_items where id=p_item_id for update;
  if not found then raise exception 'Material no disponible para esta sede.' using errcode='42501'; end if;
  payload := jsonb_build_object('item',p_item_id,'type',p_type,'quantity',p_quantity,'target',p_new_quantity,
    'unit',p_unit,'reason',p_reason,'date',p_date,'notes',p_notes,'expected',p_expected_quantity);
  select * into result from public.inventory_movements where id=p_request_id;
  if found then
    if result.user_id is distinct from auth.uid() or result.request_payload is distinct from payload then
      raise exception 'Este identificador ya corresponde a otro movimiento. Recupera la operación original.' using errcode='22023';
    end if;
    return result;
  end if;
  if p_expected_quantity is null or p_expected_quantity is distinct from coalesce(item.current_quantity,0) then
    raise exception 'Las existencias han cambiado. Recarga el material antes de guardar.' using errcode='40001';
  end if;
  insert into public.inventory_movements(id,inventory_item_id,item_id,sede_id,type,quantity,new_quantity,unit,reason,date,notes,user_id,request_payload)
  values(p_request_id,item.id,item.id,item.sede_id,p_type::public.movement_type,p_quantity,p_new_quantity,p_unit,p_reason,p_date,p_notes,auth.uid(),payload)
  returning * into result;
  return result;
end;
$$;
revoke all on function public.record_inventory_movement(uuid,uuid,text,numeric,numeric,text,text,text,text,numeric) from public,anon;
grant execute on function public.record_inventory_movement(uuid,uuid,text,numeric,numeric,text,text,text,text,numeric) to authenticated;
