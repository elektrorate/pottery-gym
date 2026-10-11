-- Rollback-only integration check: never leaves a test student in the database.
begin;
select plan(2);

do $$
declare
  test_id uuid;
  test_sede uuid;
  today date := (now() at time zone 'Europe/Madrid')::date;
  actual text;
begin
  if public.student_lifecycle('membresia','paid','membresia','2026-10-10',null,'2026-10-10') <> 'active'
    or public.student_lifecycle('membresia','paid','membresia','2026-10-10',null,'2026-10-15') <> 'pending'
    or public.student_lifecycle('membresia','paid','membresia','2026-10-10',null,'2026-10-16') <> 'archived'
    or public.student_lifecycle('temporal','pending','needs_renewal','2026-01-01',null,'2026-10-16') <> 'temporary'
    or public.student_lifecycle('membresia',null,'needs_renewal','2026-11-01',null,'2026-10-16') <> 'pending'
  then raise exception 'Lifecycle boundary mismatch'; end if;

  insert into public.sedes (name, slug)
    values ('LIFECYCLE ROLLBACK TEST', 'lifecycle-rollback-test')
    returning id into test_sede;

  insert into public.students (sede_id,full_name,name,phone,student_category,status,payment_status,expiry_date,classes_remaining)
    values (test_sede,'LIFECYCLE ROLLBACK TEST','LIFECYCLE ROLLBACK TEST','','membresia','membresia','paid',today::timestamp at time zone 'UTC',0)
    returning id into test_id;
  select lifecycle_status into actual from public.students_with_lifecycle where id=test_id;
  if actual <> 'active' then raise exception 'Paid member with zero classes must stay active'; end if;
  update public.students set payment_status='pending' where id=test_id;
  select lifecycle_status into actual from public.students_with_lifecycle where id=test_id;
  if actual <> 'pending' then raise exception 'Payment not persisted'; end if;
  update public.students set expiry_date=(today-6)::timestamp at time zone 'UTC',repetir_mensualmente=true where id=test_id;
  select lifecycle_status into actual from public.students_with_lifecycle where id=test_id;
  if actual <> 'archived' then raise exception 'Day six must be inactive despite renewal preference'; end if;
  update public.students set payment_status='paid',expiry_date=(today+30)::timestamp at time zone 'UTC',archived_at=null where id=test_id;
  select lifecycle_status into actual from public.students_with_lifecycle where id=test_id;
  if actual <> 'active' then raise exception 'Renewal did not reactivate'; end if;
  update public.students set student_category='temporal',expiry_date=(today-60)::timestamp at time zone 'UTC' where id=test_id;
  select lifecycle_status into actual from public.students_with_lifecycle where id=test_id;
  if actual <> 'temporary' then raise exception 'Temporary incorrectly classified'; end if;
  if has_table_privilege('anon','public.students_with_lifecycle','select') then raise exception 'Anonymous view access'; end if;
end;
$$;
select pass('Lifecycle transitions and persistence are correct');
set local role authenticated;
select is(
  (select count(*) from public.students_with_lifecycle),
  0::bigint,
  'Authenticated role without an identity cannot see lifecycle rows'
);
reset role;
select * from finish();
rollback;
