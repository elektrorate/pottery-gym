-- Complete mixed sessions: each roster entry belongs to one activity block.
alter table public.session_students add column if not exists activity_type text;
alter table public.session_students drop constraint if exists session_students_activity_type_check;
alter table public.session_students add constraint session_students_activity_type_check
  check (activity_type is null or activity_type in ('mesa','torno','coworking','workshop','privada'));

-- The parent keeps one shared interval while blocks hold the independent capacities/teachers.
-- Rebuild the existing atomic functions from their installed definitions so this migration
-- remains compatible with the policy revisions already deployed.
do $$
declare fn text;
begin
  foreach fn in array array[
    'private.save_session_reservation_v1(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb)',
    'private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb)',
    'private.save_session_reservation_v2(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb)',
    'private.session_business_funding(uuid,uuid)',
    'private.session_business_funding_before_manual(uuid,uuid)',
    'private.session_manual_credit_funding(uuid,uuid)'
  ] loop
    begin
      select pg_get_functiondef(fn::regprocedure) into fn;
      fn := replace(fn, '''mesa'', ''torno'', ''coworking''', '''mesa'', ''torno'', ''mixto'', ''coworking''');
      fn := replace(fn, '''mesa'', ''torno'', ''coworking'', ''workshop''', '''mesa'', ''torno'', ''mixto'', ''coworking'', ''workshop''');
      fn := replace(fn, 's.class_type = case when', 'coalesce(e.activity_type, s.class_type) = case when');
      fn := replace(fn, 's.class_type = case when', 'coalesce(e.activity_type, s.class_type) = case when');
      fn := replace(fn, 'mc.activity = s.class_type', 'mc.activity = coalesce(e.activity_type, s.class_type)');
      execute fn;
    exception when undefined_function then null;
    end;
  end loop;
end $$;

alter table public.session_activity_blocks add column if not exists activity_type text;
update public.session_activity_blocks set activity_type = activity_type where activity_type is null;

drop policy if exists session_activity_blocks_select on public.session_activity_blocks;
create policy session_activity_blocks_select on public.session_activity_blocks
  for select to authenticated using (private.can_access_sede(sede_id));
drop policy if exists session_activity_blocks_write on public.session_activity_blocks;
create policy session_activity_blocks_write on public.session_activity_blocks
  for all to authenticated using (private.can_access_sede(sede_id)) with check (private.can_access_sede(sede_id));

grant select, insert, update, delete on public.session_activity_blocks, public.session_activity_block_students to authenticated;
