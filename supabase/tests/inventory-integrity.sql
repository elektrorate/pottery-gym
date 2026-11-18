-- Transactional regression: run as an authenticated workshop actor in a test database.
-- All fixture rows and writes are rolled back. Supply JWT claims before this file.
begin;
set local role authenticated;
do $$
declare
  fixture_item_id uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  result public.inventory_movements%rowtype;
  balance numeric;
  movement_count bigint;
begin
  insert into public.inventory_items(id,name,category,current_quantity,unit,status)
  values(fixture_item_id,'PRUEBA CODEX SQL rollback','glaze',10,'kg','active');
  result := public.record_inventory_movement(request_id,fixture_item_id,'in',3,null,'kg','PRUEBA CODEX entrada','2026-11-17',null,10);
  if result.new_quantity<>13 then raise exception 'Entry balance mismatch'; end if;
  result := public.record_inventory_movement(request_id,fixture_item_id,'in',3,null,'kg','PRUEBA CODEX entrada','2026-11-17',null,10);
  select current_quantity into balance from public.inventory_items where id=fixture_item_id;
  select count(*) into movement_count from public.inventory_movements where inventory_item_id=fixture_item_id;
  if balance<>13 or movement_count<>1 then raise exception 'Retry duplicated inventory movement'; end if;
  begin
    perform public.record_inventory_movement(gen_random_uuid(),fixture_item_id,'out',20,null,'kg','PRUEBA CODEX exceso','2026-11-17',null,13);
    raise exception 'Excess withdrawal was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_inventory_movement(gen_random_uuid(),fixture_item_id,'in',1,null,'kg','PRUEBA CODEX stale','2026-11-17',null,10);
    raise exception 'Stale stock was accepted';
  exception when sqlstate '40001' then null;
  end;
  begin
    insert into public.inventory_movements(inventory_item_id,type,quantity,unit,reason) values(fixture_item_id,'out',20,'kg','PRUEBA CODEX direct');
    raise exception 'Direct insert bypassed stock validation';
  exception when sqlstate '22023' then null;
  end;
  begin
    insert into public.inventory_movements(id,inventory_item_id,type,quantity,unit,reason) values(request_id,fixture_item_id,'in',1,'kg','PRUEBA CODEX duplicate');
    raise exception 'Duplicate insert was accepted';
  exception when unique_violation then null;
  end;
  select current_quantity into balance from public.inventory_items where id=fixture_item_id;
  select count(*) into movement_count from public.inventory_movements where inventory_item_id=fixture_item_id;
  if balance<>13 or movement_count<>1 then raise exception 'A rejected insert modified stock or ledger'; end if;
  result := public.record_inventory_movement(gen_random_uuid(),fixture_item_id,'adjust',null,2,'kg','PRUEBA CODEX ajuste','2026-11-17',null,13);
  if result.new_quantity<>2 or result.quantity<>11 then raise exception 'Adjustment mismatch'; end if;
  begin
    perform public.record_inventory_movement(gen_random_uuid(),fixture_item_id,'adjust',null,-1,'kg','PRUEBA CODEX negativo','2026-11-17',null,2);
    raise exception 'Negative adjustment was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_inventory_movement(gen_random_uuid(),gen_random_uuid(),'in',1,null,'kg','PRUEBA CODEX no access','2026-11-17',null,0);
    raise exception 'An inaccessible item was accepted';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: entry, adjustment, idempotency, insufficient stock, stale state, direct inserts, rollback and item authorization';
end;
$$;
rollback;
