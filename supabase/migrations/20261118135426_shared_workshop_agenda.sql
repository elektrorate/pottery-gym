begin;

create table public.workshop_activities (
  id uuid primary key,
  sede_id uuid not null references public.sedes(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  activity_date date not null,
  starts_at time not null,
  ends_at time not null,
  description text not null default '' check (length(description) <= 4000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  revision bigint not null default 0 check (revision >= 0),
  last_request_id uuid not null,
  source_key text,
  check (ends_at > starts_at),
  unique (sede_id, source_key)
);
create index workshop_activities_sede_date on public.workshop_activities(sede_id, activity_date);
alter table public.workshop_activities enable row level security;
create policy activities_read on public.workshop_activities for select to authenticated using (private.can_access_sede(sede_id));
create policy activities_insert on public.workshop_activities for insert to authenticated with check (private.can_access_sede(sede_id) and created_by=auth.uid() and updated_by=auth.uid());
create policy activities_update on public.workshop_activities for update to authenticated using (private.can_access_sede(sede_id)) with check (private.can_access_sede(sede_id) and updated_by=auth.uid());
grant select,insert,update on public.workshop_activities to authenticated;
revoke all on public.workshop_activities from anon;

create table public.workshop_activity_events (
  sede_id uuid not null references public.sedes(id),
  request_id uuid not null,
  activity_id uuid not null references public.workshop_activities(id),
  actor_id uuid not null references public.profiles(id),
  operation text not null check (operation in ('create','update','delete','restore')),
  recorded_at timestamptz not null default now(),
  before_state jsonb,
  after_state jsonb not null,
  primary key(sede_id,request_id)
);
alter table public.workshop_activity_events enable row level security;
create policy activity_events_read on public.workshop_activity_events for select to authenticated using (private.can_access_sede(sede_id));
grant select on public.workshop_activity_events to authenticated;
revoke all on public.workshop_activity_events from anon;

create function private.guard_workshop_activity() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not private.can_access_sede(new.sede_id) then raise exception 'Activity not accessible' using errcode='42501'; end if;
  if tg_op='INSERT' then
    new.created_by:=auth.uid(); new.updated_by:=auth.uid(); new.created_at:=now(); new.updated_at:=now(); new.revision:=0; new.deleted_at:=null;
  else
    if new.id<>old.id or new.sede_id<>old.sede_id or new.created_by<>old.created_by or new.created_at<>old.created_at or new.source_key is distinct from old.source_key then raise exception 'Activity identity is immutable'; end if;
    if new.revision<>old.revision+1 then raise exception 'Stale activity revision' using errcode='40001'; end if;
    new.updated_by:=auth.uid(); new.updated_at:=now();
  end if;
  return new;
end $$;
revoke all on function private.guard_workshop_activity() from public,anon,authenticated;
create trigger guard_workshop_activity before insert or update on public.workshop_activities for each row execute function private.guard_workshop_activity();

create function private.audit_workshop_activity() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.workshop_activity_events(sede_id,request_id,activity_id,actor_id,operation,before_state,after_state)
  values(new.sede_id,new.last_request_id,new.id,auth.uid(),case when tg_op='INSERT' then 'create' when old.deleted_at is null and new.deleted_at is not null then 'delete' when old.deleted_at is not null and new.deleted_at is null then 'restore' else 'update' end,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  return new;
end $$;
revoke all on function private.audit_workshop_activity() from public,anon,authenticated;
create trigger audit_workshop_activity after insert or update on public.workshop_activities for each row execute function private.audit_workshop_activity();

create function public.save_workshop_activity(p_sede_id uuid,p_activity_id uuid,p_request_id uuid,p_expected_revision bigint,p_action text,p_payload jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_row public.workshop_activities; receipt public.workshop_activity_events; expected jsonb;
begin
  if auth.uid() is null or not private.can_access_sede(p_sede_id) then raise exception 'Activity not accessible' using errcode='42501'; end if;
  if p_action is null or p_action not in ('create','update','delete','restore') or p_request_id is null or p_activity_id is null or p_expected_revision is null or p_expected_revision<0 then raise exception 'Invalid activity operation'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload-array['title','activity_date','starts_at','ends_at','description','source_key']<>'{}' then raise exception 'Invalid activity payload'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_activity_id::text,0));
  select * into receipt from public.workshop_activity_events where sede_id=p_sede_id and request_id=p_request_id;
  if found then
    expected:=jsonb_build_object('action',p_action,'revision',p_expected_revision,'payload',p_payload);
    if receipt.actor_id<>auth.uid() or receipt.activity_id<>p_activity_id or receipt.operation<>p_action then raise exception 'Request identity conflict'; end if;
    -- Compare the caller's fields to the persisted result before returning its receipt.
    if exists(select 1 from jsonb_each(p_payload) e where receipt.after_state->e.key is distinct from case when e.key in ('starts_at','ends_at') then to_jsonb((e.value #>> '{}')::time) else e.value end)
      or coalesce((receipt.after_state->>'revision')::bigint,0)<>(case when p_action='create' then 0 else p_expected_revision+1 end)
      or ((receipt.after_state->>'deleted_at') is not null)<>(p_action='delete') then raise exception 'Request payload conflict'; end if;
    return receipt.after_state;
  end if;
  select * into current_row from public.workshop_activities where id=p_activity_id and sede_id=p_sede_id for update;
  if p_action='create' then
    if found or p_expected_revision<>0 then raise exception 'Activity already exists' using errcode='40001'; end if;
    insert into public.workshop_activities(id,sede_id,title,activity_date,starts_at,ends_at,description,created_by,updated_by,last_request_id,source_key)
    values(p_activity_id,p_sede_id,p_payload->>'title',(p_payload->>'activity_date')::date,(p_payload->>'starts_at')::time,(p_payload->>'ends_at')::time,coalesce(p_payload->>'description',''),auth.uid(),auth.uid(),p_request_id,p_payload->>'source_key') returning * into current_row;
  else
    if not found or current_row.revision<>p_expected_revision then raise exception 'Stale activity revision' using errcode='40001'; end if;
    if p_action in ('delete','restore') and p_payload<>'{}' then raise exception 'Removal only accepts an empty payload'; end if;
    if p_action='delete' and current_row.deleted_at is not null then raise exception 'Activity already deleted'; end if;
    if p_action='restore' and current_row.deleted_at is null then raise exception 'Activity is not deleted'; end if;
    if p_action='update' and current_row.deleted_at is not null then raise exception 'Restore activity before editing'; end if;
    update public.workshop_activities set title=coalesce(p_payload->>'title',title),activity_date=coalesce((p_payload->>'activity_date')::date,activity_date),starts_at=coalesce((p_payload->>'starts_at')::time,starts_at),ends_at=coalesce((p_payload->>'ends_at')::time,ends_at),description=coalesce(p_payload->>'description',description),deleted_at=case when p_action='delete' then now() when p_action='restore' then null else deleted_at end,revision=revision+1,last_request_id=p_request_id where id=p_activity_id and sede_id=p_sede_id returning * into current_row;
  end if;
  return to_jsonb(current_row);
end $$;
revoke all on function public.save_workshop_activity(uuid,uuid,uuid,bigint,text,jsonb) from public,anon;
grant execute on function public.save_workshop_activity(uuid,uuid,uuid,bigint,text,jsonb) to authenticated;
commit;
