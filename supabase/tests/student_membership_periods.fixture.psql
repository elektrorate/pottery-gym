\set ON_ERROR_STOP on
-- Keep PASS/error notices visible without dumping fixture snapshots.
\o /dev/null
-- Disposable fixture only. It deliberately does not reconstruct Supabase.
drop schema public cascade;
create schema public;
drop schema if exists auth cascade;
drop schema if exists private cascade;
create schema auth;
create schema private;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
    create role anon nologin;
  end if;
end $$;
grant usage on schema public, auth, private to authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function private.can_access_sede(sede uuid) returns boolean language sql stable as $$
  select auth.uid() = '00000000-0000-0000-0000-000000000001'::uuid
    and sede = '30000000-0000-0000-0000-000000000001'::uuid;
$$;
create table public.students (
  id uuid primary key, sede_id uuid not null, name text,
  student_category text default 'membresia', status text default 'membresia',
  membership_tier text, bonos_asignados integer, classes_remaining integer,
  membership_activated_at date, expiry_date :expiry_type, price numeric,
  payment_status text check (payment_status in ('paid', 'pending')),
  archived_at date
);
alter table public.students enable row level security;
create policy fixture_students on public.students to authenticated
  using (private.can_access_sede(sede_id)) with check (private.can_access_sede(sede_id));
grant select, insert, update, delete on public.students to authenticated;
create function public.test_assert(ok boolean, label text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
-- Seed BEFORE the migration: these are true pre-management observations.
set timezone = 'UTC';
insert into public.students(id, sede_id, name, membership_tier, bonos_asignados,
  classes_remaining, expiry_date, payment_status, archived_at, price)
select ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
  case when n = 8 then '30000000-0000-0000-0000-000000000002'::uuid
    else '30000000-0000-0000-0000-000000000001'::uuid end,
  'fixture', 'gold', 4, 2,
  case when n = 3 then (now() at time zone 'Europe/Madrid')::date - 10
    when n = 4 then null when n = 5 then (now() at time zone 'Europe/Madrid')::date
    else (now() at time zone 'Europe/Madrid')::date + 10 end,
  case when n = 2 then 'paid' else null end,
  case when n = 2 then (now() at time zone 'Europe/Madrid')::date - 30 else null end,
  case when n = 2 then 777 else null end
from generate_series(1,9) n;
insert into public.students(id,sede_id,student_category,classes_remaining) values
  ('10000000-0000-0000-0000-000000000010','30000000-0000-0000-0000-000000000001','temporal',2);
insert into public.students(id,sede_id,student_category,classes_remaining,price,bonos_asignados,expiry_date) values
  ('10000000-0000-0000-0000-000000000021','30000000-0000-0000-0000-000000000001','grupo_temporal',6,65,null,null),
  ('10000000-0000-0000-0000-000000000022','30000000-0000-0000-0000-000000000001','grupal',7,70,null,null),
  ('10000000-0000-0000-0000-000000000025','30000000-0000-0000-0000-000000000001',null,2,35,4,
    (now() at time zone 'Europe/Madrid')::date+10);
\i :migration
set timezone = 'America/Los_Angeles';
select public.test_assert(private.membership_month_end('2026-10-11') = '2026-11-10', 'exact month');
select public.test_assert(private.membership_month_end('2027-01-31') = '2027-02-27', 'clamped non-leap month');
select public.test_assert(private.membership_month_end('2028-01-31') = '2028-02-28', 'clamped leap month');
select public.test_assert(public.student_lifecycle('membresia',null,'active',
  private.membership_today()+1,null,private.membership_today()) = 'pending', 'no lifecycle payment inference');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
with created as (
  insert into public.students(id,sede_id,name,membership_tier,payment_status,price,
    classes_remaining,expiry_date,archived_at)
  values ('10000000-0000-0000-0000-000000000011','30000000-0000-0000-0000-000000000001',
    'new membership','gold','paid',999,99,'2099-01-01',private.membership_today())
  returning *
) select public.test_assert(current_membership_period_id is not null and payment_status='pending'
  and price=120 and classes_remaining=4 and archived_at is not null,
  'INSERT RETURNING has atomic pending identity and validated plan') from created;
select public.test_assert(p.id=s.current_membership_period_id and p.payment_status='pending'
  and p.confirmed_at is null and p.legacy_snapshot is null and p.plan_price=120
  and private.membership_expiry_date(s.expiry_date)=p.ends_on
  and p.starts_on=private.membership_today() and p.ends_on=(p.starts_on + interval '1 month')::date-1,
  'new membership period is initialized without invented legacy or timezone shift')
from public.students s join public.student_membership_periods p on p.id=s.current_membership_period_id
where s.id='10000000-0000-0000-0000-000000000011';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011','plata',3);
select public.test_assert(plan_price=90 and allocated_classes=3 and payment_status='pending','plata fixed plan snapshot')
from public.student_membership_periods where request_key='20000000-0000-0000-0000-000000000011';
insert into public.students(id,sede_id,name,student_category,payment_status,classes_remaining,price)
values ('10000000-0000-0000-0000-000000000012','30000000-0000-0000-0000-000000000001',
  'gift recipient','temporal','paid',2,45);
select public.test_assert(student_category='temporal' and current_membership_period_id is null
  and classes_remaining=2 and price=45 and payment_status='paid',
  'temporary INSERT preserves category/classes/price/payment') from public.students
where id='10000000-0000-0000-0000-000000000012';
update public.students set classes_remaining=1,expiry_date='2099-01-01',price=50
where id='10000000-0000-0000-0000-000000000012';
select public.test_assert(student_category='temporal' and current_membership_period_id is null
  and classes_remaining=1 and price=50 and payment_status='paid',
  'temporary gift-card insertion/updates do not create a membership')
from public.students where id='10000000-0000-0000-0000-000000000012';
do $$ begin
  begin
    perform public.schedule_student_membership('10000000-0000-0000-0000-000000000010',
      '20000000-0000-0000-0000-000000000010','gold',4);
    raise exception 'FAIL: temporary renewal accepted';
  exception when raise_exception then
    if sqlerrm <> 'Only membership students can renew memberships' then raise; end if;
  end;
  begin
    perform public.activate_student_membership('10000000-0000-0000-0000-000000000010');
    raise exception 'FAIL: temporary activation accepted';
  exception when raise_exception then
    if sqlerrm <> 'Only membership students can manage membership periods' then raise; end if;
  end;
  begin
    insert into public.students(id,sede_id,membership_tier,bonos_asignados)
    values ('10000000-0000-0000-0000-000000000013','30000000-0000-0000-0000-000000000001','plata',8);
    raise exception 'FAIL: invalid initial allocation accepted';
  exception when raise_exception then
    if sqlerrm <> 'Allocation must match the selected fixed membership plan' then raise; end if;
  end;
  begin
    perform public.schedule_student_membership('10000000-0000-0000-0000-000000000011',
      '20000000-0000-0000-0000-000000000099','gold',99);
    raise exception 'FAIL: arbitrary allocation accepted';
  exception when raise_exception then
    if sqlerrm <> 'A request key and allocation matching the fixed membership plan are required' then raise; end if;
  end;
end $$;
with created as (
  insert into public.students(id,sede_id,student_category,classes_remaining,price,payment_status)
  values ('10000000-0000-0000-0000-000000000023','30000000-0000-0000-0000-000000000001','grupo_temporal',5,67,'paid'),
    ('10000000-0000-0000-0000-000000000024','30000000-0000-0000-0000-000000000001','grupal',6,68,'paid')
  returning *
) select public.test_assert(current_membership_period_id is null and payment_status='paid'
  and ((student_category='grupo_temporal' and classes_remaining=5 and price=67)
    or (student_category='grupal' and classes_remaining=6 and price=68)),
  'known nonmembership INSERT preserves category/classes/price/payment') from created;
update public.students set classes_remaining=classes_remaining-1,price=price+1,expiry_date='2099-01-01'
where id in ('10000000-0000-0000-0000-000000000023','10000000-0000-0000-0000-000000000024');
select public.test_assert(current_membership_period_id is null and
  ((student_category='grupo_temporal' and classes_remaining=4 and price=68)
    or (student_category='grupal' and classes_remaining=5 and price=69)),
  'nonmembership gift-card/group updates remain unmanaged') from public.students
where id in ('10000000-0000-0000-0000-000000000023','10000000-0000-0000-0000-000000000024');
do $$ declare s public.students; unchanged public.students;
begin
  for s in select * from public.students where student_category in ('temporal','grupo_temporal','grupal') loop
    begin
      perform public.activate_student_membership(s.id);
      raise exception 'FAIL: nonmembership activation accepted';
    exception when raise_exception then
      if sqlerrm <> 'Only membership students can manage membership periods' then raise; end if;
    end;
    begin
      perform public.schedule_student_membership(s.id,gen_random_uuid(),'gold',4);
      raise exception 'FAIL: nonmembership renewal accepted';
    exception when raise_exception then
      if sqlerrm <> 'Only membership students can renew memberships' then raise; end if;
    end;
    begin
      perform public.adjust_student_membership_classes(s.id,gen_random_uuid(),gen_random_uuid(),s.classes_remaining,-1);
      raise exception 'FAIL: nonmembership class adjustment accepted';
    exception when raise_exception then
      if sqlerrm <> 'Only membership students can manage membership periods' then raise; end if;
    end;
    select * into unchanged from public.students where id=s.id;
    perform public.test_assert(to_jsonb(s)=to_jsonb(unchanged) and unchanged.current_membership_period_id is null,
      'nonmembership RPC rejection preserves all fields: ' || s.student_category);
  end loop;
end $$;
select public.test_assert(count(*)=0,'nonmembership categories have no period or adjustment history')
from (select p.student_id from public.student_membership_periods p join public.students s on s.id=p.student_id
  where s.student_category in ('temporal','grupo_temporal','grupal')
  union all select a.student_id from public.student_membership_class_adjustments a join public.students s on s.id=a.student_id
  where s.student_category in ('temporal','grupo_temporal','grupal')) unmanaged;
-- NULL is the legacy membership default, but snapshotting does not rewrite it.
select public.activate_student_membership('10000000-0000-0000-0000-000000000025');
select public.test_assert(s.student_category is null and s.classes_remaining=2 and s.price=35
  and p.payment_status is null and p.legacy_snapshot->'student_category'='null'::jsonb,
  'NULL legacy category uses default without rewriting raw category/payment')
from public.students s join public.student_membership_periods p on p.id=s.current_membership_period_id
where s.id='10000000-0000-0000-0000-000000000025';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000025',
  '20000000-0000-0000-0000-000000000025','gold',4);
select public.test_assert(student_category is null and classes_remaining=2 and price=35,
  'NULL legacy renewal queues without rewriting current observations') from public.students
where id='10000000-0000-0000-0000-000000000025';
with created as (
  insert into public.students(id,sede_id,student_category)
  values ('10000000-0000-0000-0000-000000000026','30000000-0000-0000-0000-000000000001',null)
  returning *
) select public.test_assert(student_category='membresia' and current_membership_period_id is not null
  and payment_status='pending' and classes_remaining=4 and price=120,
  'new NULL category follows the existing membership default') from created;
select public.test_assert(count(*)=0,'temporary activation has no snapshot side effect')
from public.student_membership_periods where student_id='10000000-0000-0000-0000-000000000010';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001','platinum',8);
select public.test_assert(classes_remaining = 2 and payment_status is null
  and membership_tier = 'gold' and private.membership_expiry_date(expiry_date) = private.membership_today()+10,
  'early renewal leaves current fields untouched') from public.students where id = '10000000-0000-0000-0000-000000000001';
select public.test_assert(payment_status is null and confirmed_at is null
  and legacy_snapshot->>'expiry_date' is not null, 'legacy unknown/raw observation retained')
from public.student_membership_periods where student_id = '10000000-0000-0000-0000-000000000001' and request_key is null;
select public.test_assert(payment_status = 'pending' and starts_on = private.membership_today()+11
  and plan_price=180 and allocated_classes=8,
  'future successor pending') from public.student_membership_periods where request_key = '20000000-0000-0000-0000-000000000001';
select public.test_assert((public.schedule_student_membership(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','platinum',8)).id = id,
  'identical retry returns original') from public.student_membership_periods where request_key = '20000000-0000-0000-0000-000000000001';
do $$ begin
  begin
    perform public.schedule_student_membership('10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001','gold',4);
    raise exception 'FAIL: conflicting retry accepted';
  exception when raise_exception then
    if sqlerrm not like 'Idempotency key conflicts%' then raise; end if;
  end;
  begin
    perform public.schedule_student_membership('10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000099','gold',4);
    raise exception 'FAIL: second successor accepted';
  exception when raise_exception then
    if sqlerrm <> 'A successor is already queued' then raise; end if;
  end;
end $$;
select public.confirm_student_membership_payment(id) from public.student_membership_periods
where request_key = '20000000-0000-0000-0000-000000000001';
select public.test_assert(payment_status is null, 'scheduled confirmation does not pay current')
from public.students where id = '10000000-0000-0000-0000-000000000001';
select public.activate_student_membership('10000000-0000-0000-0000-000000000002');
select public.test_assert(payment_status = 'paid' and confirmed_at is null, 'explicit legacy paid preserved without fabricated confirmation')
from public.student_membership_periods where student_id = '10000000-0000-0000-0000-000000000002';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002','gold',4);
select public.test_assert(payment_status='paid' and archived_at is not null and price=777, 'paid current/archive/raw price unchanged')
from public.students where id = '10000000-0000-0000-0000-000000000002';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000003','gold',4);
select public.schedule_student_membership('10000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000004','gold',4);
select public.test_assert(starts_on = private.membership_today() and payment_status='pending', 'expired/undated starts today')
from public.student_membership_periods where request_key in ('20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004');
select public.test_assert(legacy_snapshot->>'expiry_date' is null and ends_on is null,
  'undated raw snapshot not invented') from public.student_membership_periods
where student_id = '10000000-0000-0000-0000-000000000004' and request_key is null;
select public.schedule_student_membership('10000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000005','gold',4);
select public.test_assert(starts_on = private.membership_today()+1, 'inclusive expiry day starts tomorrow')
from public.student_membership_periods where request_key = '20000000-0000-0000-0000-000000000005';
-- Rejection helper catches ONLY expected errors, never its own sentinel.
do $$ begin
  begin
    perform public.activate_student_membership('10000000-0000-0000-0000-000000000008');
    raise exception 'FAIL: foreign tenant accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.student_membership_periods set payment_status='paid';
    raise exception 'FAIL: history update accepted';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.student_membership_periods;
    raise exception 'FAIL: history delete accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.student_membership_periods(student_id,sede_id) values
      ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: history insert accepted';
  exception when insufficient_privilege then null; end;
  -- A caller-set GUC is not an authorization token.
  perform set_config('app.membership_rpc','true',true);
  begin
    update public.students set payment_status='paid' where id='10000000-0000-0000-0000-000000000003';
    raise exception 'FAIL: projection bypass accepted';
  exception when raise_exception then
    if sqlerrm not like 'Protected membership projection%' then raise; end if;
  end;
  begin
    update public.students set classes_remaining=99 where id='10000000-0000-0000-0000-000000000003';
    raise exception 'FAIL: stale class write accepted';
  exception when raise_exception then
    if sqlerrm not like 'Protected membership projection%' then raise; end if;
  end;
  begin
    update public.students set price=999 where id='10000000-0000-0000-0000-000000000003';
    raise exception 'FAIL: direct managed price write accepted';
  exception when raise_exception then
    if sqlerrm not like 'Protected membership projection%' then raise; end if;
  end;
  begin
    delete from public.students where id='10000000-0000-0000-0000-000000000003';
    raise exception 'FAIL: person/history deletion accepted';
  exception when foreign_key_violation then null; end;
end $$;
update public.students set name='ordinary profile', archived_at=private.membership_today()
where id='10000000-0000-0000-0000-000000000003';
reset role;
-- Privileged fixture clock movement, never a callable caller clock override.
update public.student_membership_periods set starts_on = private.membership_today()-1,
  ends_on=private.membership_today()+20 where request_key='20000000-0000-0000-0000-000000000002';
set role authenticated;
select public.test_assert(payment_status='pending' and classes_remaining=4 and plan_price=120
  and effective_period_id <> materialized_period_id and archived_at is not null,
  'effective view switches without materialization; no paid reuse')
from public.students_effective_membership where student_id='10000000-0000-0000-0000-000000000002';
-- Membership mutation reconciles the due successor BEFORE confirming history.
select public.confirm_student_membership_payment(id) from public.student_membership_periods
where student_id='10000000-0000-0000-0000-000000000002' and request_key is null;
select public.test_assert(payment_status='pending' and archived_at is not null and price=120
  and private.membership_expiry_date(expiry_date)=private.membership_today()+20,
  'historical confirmation isolated, due reconciled, price projected, timezone-safe expiry, archive retained')
from public.students where id='10000000-0000-0000-0000-000000000002';
select public.test_assert(outgoing_snapshot->>'classes_remaining' = '2'
  and legacy_snapshot is not null, 'outgoing and original observations retained')
from public.student_membership_periods where student_id='10000000-0000-0000-0000-000000000002' and request_key is null;
select public.adjust_student_membership_classes(id,current_membership_period_id,
  '40000000-0000-0000-0000-000000000001',4,-3) from public.students
where id='10000000-0000-0000-0000-000000000002';
select public.adjust_student_membership_classes(id,current_membership_period_id,
  '40000000-0000-0000-0000-000000000001',4,-3) from public.students
where id='10000000-0000-0000-0000-000000000002';
select public.test_assert(count(*)=1 and min(resulting_balance)=1, 'class consumption retry has one original receipt')
from public.student_membership_class_adjustments where request_key='40000000-0000-0000-0000-000000000001';
select public.activate_student_membership('10000000-0000-0000-0000-000000000002');
select public.activate_student_membership('10000000-0000-0000-0000-000000000002');
select public.test_assert(classes_remaining=1, 'activation replay never refills') from public.students
where id='10000000-0000-0000-0000-000000000002';
select public.test_assert((public.schedule_student_membership(
  '10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','gold',4)).id = id,
  'original key still replays after activation') from public.student_membership_periods
where request_key='20000000-0000-0000-0000-000000000002';
select public.confirm_student_membership_payment(current_membership_period_id) from public.students
where id='10000000-0000-0000-0000-000000000002';
select public.test_assert(payment_status='paid' and classes_remaining=1, 'current explicit confirmation without refill')
from public.students where id='10000000-0000-0000-0000-000000000002';
-- Receipt retries, stale period/balance protection and bounded restoration.
do $$ declare s public.students; historical uuid; p public.student_membership_periods;
begin
  select * into s from public.students where id='10000000-0000-0000-0000-000000000002';
  select id into historical from public.student_membership_periods where student_id=s.id and request_key is null;
  begin
    perform public.adjust_student_membership_classes(s.id,historical,gen_random_uuid(),1,-1);
    raise exception 'FAIL: historical period adjusted successor';
  exception when serialization_failure then
    if sqlerrm <> 'Stale membership period' then raise; end if;
  end;
  begin
    perform public.adjust_student_membership_classes(s.id,s.current_membership_period_id,gen_random_uuid(),4,-1);
    raise exception 'FAIL: stale expected balance accepted';
  exception when serialization_failure then
    if sqlerrm <> 'Stale class balance' then raise; end if;
  end;
  begin
    perform public.adjust_student_membership_classes(s.id,s.current_membership_period_id,
      '40000000-0000-0000-0000-000000000001',4,-2);
    raise exception 'FAIL: changed adjustment retry accepted';
  exception when raise_exception then
    if sqlerrm <> 'Idempotency key conflicts with original class adjustment' then raise; end if;
  end;
  begin
    perform public.adjust_student_membership_classes(s.id,s.current_membership_period_id,gen_random_uuid(),1,-2);
    raise exception 'FAIL: negative balance accepted';
  exception when raise_exception then
    if sqlerrm <> 'Class balance must remain between zero and period allocation' then raise; end if;
  end;
  begin
    perform public.adjust_student_membership_classes(s.id,s.current_membership_period_id,gen_random_uuid(),1,4);
    raise exception 'FAIL: over-allocation restore accepted';
  exception when raise_exception then
    if sqlerrm <> 'Class balance must remain between zero and period allocation' then raise; end if;
  end;
  begin
    update public.student_membership_class_adjustments set resulting_balance=4;
    raise exception 'FAIL: adjustment receipt edited';
  exception when insufficient_privilege then null; end;
  begin
    perform private.lock_membership_student(s.id);
    raise exception 'FAIL: internal lock helper callable';
  exception when insufficient_privilege then null; end;
  select * into p from public.student_membership_periods where id=s.current_membership_period_id;
  perform public.confirm_student_membership_payment(p.id);
  perform public.test_assert((select confirmed_at=p.confirmed_at and confirmed_by=p.confirmed_by
    from public.student_membership_periods where id=p.id),'confirmation retry retains audit metadata');
end $$;
select public.adjust_student_membership_classes(id,current_membership_period_id,
  '40000000-0000-0000-0000-000000000002',1,2) from public.students
where id='10000000-0000-0000-0000-000000000002';
select public.adjust_student_membership_classes(id,current_membership_period_id,
  '40000000-0000-0000-0000-000000000002',1,2) from public.students
where id='10000000-0000-0000-0000-000000000002';
select public.test_assert(classes_remaining=3 and archived_at is not null and payment_status='paid',
  'restoration replay does not refill or change archive/payment') from public.students
where id='10000000-0000-0000-0000-000000000002';
-- Adjustment must validate the DATE-effective identity, not the stale pointer.
reset role;
update public.student_membership_periods set starts_on=private.membership_today()-1,
  ends_on=private.membership_today()+20 where request_key='20000000-0000-0000-0000-000000000011';
set role authenticated;
do $$ declare s public.students;
begin
  select * into s from public.students where id='10000000-0000-0000-0000-000000000011';
  begin
    perform public.adjust_student_membership_classes(s.id,s.current_membership_period_id,gen_random_uuid(),4,-1);
    raise exception 'FAIL: outgoing screen changed due successor';
  exception when serialization_failure then
    if sqlerrm <> 'Stale membership period' then raise; end if;
  end;
end $$;
select public.adjust_student_membership_classes(student_id,effective_period_id,
  '40000000-0000-0000-0000-000000000011',3,-1) from public.students_effective_membership
where student_id='10000000-0000-0000-0000-000000000011';
select public.test_assert(price=90 and classes_remaining=2 and archived_at is not null,
  'effective period class adjustment reconciles due before consumption') from public.students
where id='10000000-0000-0000-0000-000000000011';
select public.schedule_student_membership('10000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000012','gold',4);
reset role;
update public.student_membership_periods set starts_on=private.membership_today(),
  ends_on=private.membership_today()+21 where request_key='20000000-0000-0000-0000-000000000012';
set role authenticated;
select public.adjust_student_membership_classes(student_id,effective_period_id,
  '40000000-0000-0000-0000-000000000012',4,-1) from public.students_effective_membership
where student_id='10000000-0000-0000-0000-000000000011';
select public.adjust_student_membership_classes(student_id,period_id,
  '40000000-0000-0000-0000-000000000011',3,-1) from public.student_membership_class_adjustments
where request_key='40000000-0000-0000-0000-000000000011';
select public.test_assert(classes_remaining=3 and price=120 and payment_status='pending'
  and archived_at is not null,'historical receipt replay cannot alter successor balance/payment/archive')
from public.students where id='10000000-0000-0000-0000-000000000011';
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select public.test_assert(count(*)=0,'unauthorized user cannot read effective memberships')
from public.students_effective_membership;
select public.test_assert(count(*)=0,'unauthorized user cannot read periods/receipts')
from (select student_id from public.student_membership_periods
  union all select student_id from public.student_membership_class_adjustments) history;
do $$ begin
  begin
    perform public.adjust_student_membership_classes('10000000-0000-0000-0000-000000000002',
      gen_random_uuid(),gen_random_uuid(),3,-1);
    raise exception 'FAIL: foreign user class adjustment accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.students(id,sede_id) values
      ('10000000-0000-0000-0000-000000000014','30000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: cross-tenant initial membership accepted';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '';
do $$ begin
  begin
    perform public.activate_student_membership('10000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: null auth accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_assert(not has_function_privilege('anon','public.adjust_student_membership_classes(uuid,uuid,uuid,integer,integer)','execute')
  and not has_function_privilege('anon','public.schedule_student_membership(uuid,uuid,text,integer)','execute')
  and not has_function_privilege('anon','public.confirm_student_membership_payment(uuid)','execute')
  and not has_function_privilege('authenticated','private.reconcile_student_membership(uuid)','execute')
  and not has_function_privilege('authenticated','private.initialize_student_membership()','execute'),
  'RPC/trigger/internal-helper grants reject unauthorized execution');
set role anon;
do $$ begin
  begin
    perform public.activate_student_membership('10000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: anon RPC accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.student_membership_periods;
    raise exception 'FAIL: anon history accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
