-- Rollback-only integration check for workshop defaults and date exceptions.
begin;
select plan(1);

do $$
declare
  test_sede uuid;
  default_count integer;
  exception_count integer;
begin
  insert into public.sedes (name, slug)
  values ('WORKSHOP AVAILABILITY ROLLBACK TEST', 'workshop-availability-rollback-test')
  returning id into test_sede;

  insert into public.workshop_capacity_defaults (sede_id, class_type, capacity)
  select test_sede, activity.class_type, case when activity.class_type = 'torno' then 5 else 8 end
  from (values ('mesa'), ('torno'), ('coworking'), ('workshop'), ('privada')) as activity(class_type);

  select count(*) into default_count
  from public.workshop_capacity_defaults
  where sede_id = test_sede;
  if default_count < 5 then
    raise exception 'Expected five activity capacity defaults, got %', default_count;
  end if;

  insert into public.workshop_schedule_exceptions
    (sede_id, exception_date, slot_index, is_open, opens_at, closes_at, reason)
  values
    (test_sede, '2099-01-02', 0, false, null, null, 'Cierre de prueba'),
    (test_sede, '2099-01-03', 0, true, '10:00', '14:00', 'Horario de prueba');

  select count(*) into exception_count
  from public.workshop_schedule_exceptions
  where sede_id = test_sede
    and exception_date in ('2099-01-02', '2099-01-03');
  if exception_count <> 2 then
    raise exception 'Exception rows were not persisted';
  end if;
end;
$$;

select pass('Workshop defaults and date exceptions persist inside the transaction');
select * from finish();
rollback;
