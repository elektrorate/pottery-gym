-- Follow-up only. Do not infer or rebill the original mixed-session history.
begin;
lock table public.sessions, public.session_students, public.session_activity_blocks,
  public.session_activity_block_students in share row exclusive mode;

create unique index mixed_teacher_sede_key on public.teachers(id, sede_id);
alter table public.session_activity_blocks
  drop constraint session_activity_blocks_session_id_fkey,
  add constraint mixed_block_session_sede_fk foreign key(session_id,sede_id)
    references public.sessions(id,sede_id) on delete restrict not valid,
  add constraint mixed_block_teacher_sede_fk foreign key(teacher_id,sede_id)
    references public.teachers(id,sede_id) on delete restrict not valid;
alter table public.session_activity_block_students
  drop constraint session_activity_block_students_block_id_fkey,
  drop constraint session_activity_block_students_block_id_session_id_fkey,
  drop constraint session_activity_block_students_session_id_student_id_fkey,
  add constraint mixed_block_roster_block_fk foreign key(block_id,session_id)
    references public.session_activity_blocks(id,session_id) on delete restrict not valid,
  add constraint mixed_block_roster_enrollment_fk foreign key(session_id,student_id)
    references public.session_students(session_id,student_id) on delete restrict not valid;

do $$ declare t text; p record; begin
  foreach t in array array['session_activity_blocks','session_activity_block_students'] loop
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I',p.policyname,t);
    end loop;
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;
create policy mixed_block_read on public.session_activity_blocks for select to authenticated
  using(private.session_business_read_sede(sede_id) and exists(select 1 from public.sessions s
    where s.id=session_id and s.sede_id=session_activity_blocks.sede_id));
create policy mixed_block_roster_read on public.session_activity_block_students for select to authenticated
  using(exists(select 1 from public.session_activity_blocks b join public.sessions s on s.id=b.session_id and s.sede_id=b.sede_id
    where b.id=block_id and b.session_id=session_activity_block_students.session_id and private.session_business_read_sede(s.sede_id)));

-- A caller GUC cannot establish this context. Only the definer RPC can write it.
create table private.mixed_session_writers (
  backend_pid integer not null, transaction_id bigint not null, session_id uuid not null,
  primary key(backend_pid,transaction_id,session_id)
);
create table private.mixed_session_reservations (
  session_id uuid not null, request_key uuid not null, sede_id uuid not null, revision bigint not null,
  blocks_snapshot jsonb not null, roster_snapshot jsonb not null, session_snapshot jsonb not null,
  created_by uuid not null, created_at timestamptz not null default clock_timestamp(),
  primary key(session_id,request_key), unique(session_id,revision),
  foreign key(session_id,sede_id) references public.sessions(id,sede_id) on delete restrict
);
alter table private.mixed_session_writers enable row level security;
alter table private.mixed_session_reservations enable row level security;
revoke all on private.mixed_session_writers,private.mixed_session_reservations from public,anon,authenticated,service_role;
create trigger guard_mixed_origin_history before insert or update or delete on private.mixed_session_reservations
  for each row execute function private.guard_session_history();

create function private.guard_atomic_mixed_state() returns trigger
language plpgsql security invoker set search_path='' as $$
declare sid uuid; s public.sessions; bid uuid;
begin
  if tg_table_name='session_students' then
    if tg_op='UPDATE' and new.activity_type is not distinct from old.activity_type then return new; end if;
    if tg_op='INSERT' and new.activity_type is null then return new; end if;
    sid:=new.session_id;
  elsif tg_op='DELETE' then sid:=old.session_id;
  else sid:=new.session_id; end if;
  if current_user<>pg_get_userbyid((select relowner from pg_class where oid=tg_relid)) then
    raise exception 'Mixed state is server-managed; use save_session_reservation' using errcode='42501';
  end if;
  if not exists(select 1 from private.mixed_session_writers where backend_pid=pg_backend_pid()
    and transaction_id=txid_current() and session_id=sid) then
    raise exception 'Mixed state requires the atomic reservation path' using errcode='42501';
  end if;
  select * into s from public.sessions where id=sid;
  if s.class_type is distinct from 'mixto' or s.attendance_policy_version<>2 then raise exception 'Activity blocks require policy2 mixto'; end if;
  if tg_op in ('UPDATE','DELETE') then
    if tg_table_name='session_activity_blocks' then
      if tg_op='UPDATE' and (new.id is distinct from old.id or new.session_id is distinct from old.session_id
        or new.sede_id is distinct from old.sede_id) then raise exception 'Mixed block identity is immutable'; end if;
      bid:=old.id;
    elsif tg_table_name='session_activity_block_students' then
      bid:=old.block_id;
      if exists(select 1 from public.session_students where session_id=old.session_id and student_id=old.student_id and cancelled_at is not null) then
        raise exception 'Cancelled activity assignment is immutable';
      end if;
    else
      if old.cancelled_at is not null then raise exception 'Cancelled activity assignment is immutable'; end if;
    end if;
    if s.completed_at is not null or (tg_table_name='session_activity_blocks' and bid is not null and exists(select 1 from public.session_activity_block_students r
      join public.session_students e on e.session_id=r.session_id and e.student_id=r.student_id
      where r.block_id=bid and e.cancelled_at is not null)) then
      raise exception 'Finalized or cancelled activity block is immutable';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_atomic_mixed_blocks before insert or update or delete on public.session_activity_blocks
  for each row execute function private.guard_atomic_mixed_state();
create trigger guard_atomic_mixed_roster before insert or update or delete on public.session_activity_block_students
  for each row execute function private.guard_atomic_mixed_state();
create trigger guard_atomic_mixed_activity before insert or update of activity_type on public.session_students
  for each row execute function private.guard_atomic_mixed_state();

create function private.guard_mixed_parent_history() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if old.class_type='mixto' and (old.completed_at is not null or exists(select 1 from public.session_students
    where session_id=old.id and cancelled_at is not null)) and (
    new.class_type is distinct from old.class_type or new.date is distinct from old.date
    or new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time
    or new.capacity is distinct from old.capacity or new.teacher_id is distinct from old.teacher_id) then
    raise exception 'Mixed history locks interval, capacity and original activity teachers';
  end if;
  return new;
end $$;
create trigger guard_mixed_parent_history before update on public.sessions
  for each row execute function private.guard_mixed_parent_history();

create function private.mixed_activity(p_session_id uuid,p_student_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare s public.sessions; e public.session_students; b public.session_activity_blocks;
  origin private.mixed_session_reservations; shape jsonb; roster_item jsonb; context jsonb;
begin
  select * into s from public.sessions where id=p_session_id;
  select * into e from public.session_students where session_id=s.id and student_id=p_student_id;
  if e.id is null or e.sede_id is distinct from s.sede_id or not exists(select 1 from public.students where id=e.student_id and sede_id=s.sede_id) then
    raise exception 'Enrollment must belong to the session sede';
  end if;
  if s.class_type<>'mixto' then return jsonb_build_object('activity_type',s.class_type,'block_id',null,'teacher_id',s.teacher_id,'capacity',s.capacity); end if;
  select b0.* into b from public.session_activity_blocks b0 join public.session_activity_block_students r
    on r.block_id=b0.id and r.session_id=b0.session_id where r.session_id=s.id and r.student_id=e.student_id;
  if b.id is null or b.sede_id is distinct from s.sede_id or e.activity_type is distinct from b.activity_type
    or s.attendance_policy_version<>2 or b.capacity not between 1 and 100
    or (b.teacher_id is not null and not exists(select 1 from public.teachers where id=b.teacher_id and sede_id=s.sede_id))
    or s.capacity<>(select coalesce(sum(capacity),0) from public.session_activity_blocks where session_id=s.id)
    or s.capacity not between 1 and 100
    or b.capacity<(select count(*) from public.session_activity_block_students r join public.session_students en
      on en.session_id=r.session_id and en.student_id=r.student_id where r.block_id=b.id and en.cancelled_at is null) then
    raise exception 'Mixed activity assignment requires reconciliation';
  end if;
  shape:=jsonb_build_object('id',b.id,'activity_type',b.activity_type,'teacher_id',b.teacher_id,'capacity',b.capacity,
    'student_ids',(select coalesce(jsonb_agg(student_id order by student_id),'[]') from public.session_activity_block_students where block_id=b.id));
  roster_item:=jsonb_build_object('student_id',e.student_id,'block_id',b.id,'activity_type',e.activity_type,
    'period_id',e.membership_period_id,'gift_card_id',e.gift_card_id,'manual_credit_id',e.manual_credit_id);
  context:=to_jsonb(s)-array['id','sede_id','revision','created_at','completed_at','teacher_substitute_id','type','title','max_capacity','instructor_id','workshop_name','private_reason','session_audience'];
  select * into origin from private.mixed_session_reservations where session_id=s.id order by revision desc limit 1;
  if origin.session_id is null or origin.sede_id is distinct from s.sede_id or origin.revision>s.revision
    or origin.session_snapshot is distinct from context or not origin.blocks_snapshot @> jsonb_build_array(shape)
    or not origin.roster_snapshot @> jsonb_build_array(roster_item) then
    raise exception 'Mixed funding provenance requires an atomic reservation before the incident';
  end if;
  return jsonb_build_object('activity_type',b.activity_type,'block_id',b.id,'teacher_id',b.teacher_id,'capacity',b.capacity);
end $$;
create function private.mixed_activity_verified(p_session_id uuid,p_student_id uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.sessions where id=p_session_id and private.session_business_read_sede(sede_id)) then return false; end if;
  perform private.mixed_activity(p_session_id,p_student_id); return true;
exception when raise_exception then return false;
end $$;

alter function private.session_business_funding(uuid,uuid) rename to session_business_funding_before_atomic_mixed;
create function private.session_business_funding(p_session_id uuid,p_student_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare s public.sessions; e public.session_students; st public.students; c record; a jsonb; f jsonb; d date; usable boolean;
begin
  select * into s from public.sessions where id=p_session_id;
  if s.class_type is distinct from 'mixto' then return private.session_business_funding_before_atomic_mixed(p_session_id,p_student_id); end if;
  a:=private.mixed_activity(p_session_id,p_student_id);
  select * into e from public.session_students where session_id=s.id and student_id=p_student_id;
  select * into st from public.students where id=p_student_id;
  d:=private.atomic_session_date(s.date,s.start_time,s.end_time);
  if e.manual_credit_id is not null then
    if e.membership_period_id is not null or e.gift_card_id is not null then raise exception 'Ambiguous session funding'; end if;
    select * into c from public.manual_credit_entitlements_with_balance where entitlement_id=e.manual_credit_id;
    if c.entitlement_id is null or c.student_id is distinct from st.id or c.sede_id is distinct from s.sede_id then
      raise exception 'Explicit manual credit must belong to its roster student and session sede';
    end if;
    usable:=c.remaining_classes>0 and c.activity=a->>'activity_type' and st.archived_at is null
      and c.starts_on<=least(d,private.membership_today()) and c.ends_on>=greatest(d,private.membership_today());
    f:=jsonb_build_object('usable',usable,'overridable',false,'no_credit_allowed',c.remaining_classes=0,
      'period_id',null,'gift_card_id',null,'manual_credit_id',e.manual_credit_id,
      'snapshot',jsonb_build_object('manual_credit_id',c.entitlement_id,'quantity',c.quantity,'remaining_classes',c.remaining_classes,
        'activity',c.activity,'starts_on',c.starts_on,'ends_on',c.ends_on,'student_category',st.student_category,'archived_at',st.archived_at,
        'session_date',s.date,'start_time',s.start_time,'end_time',s.end_time,'class_type',s.class_type),
      'reason','Original manual credit has no valid available credit');
  else
    f:=private.session_business_funding_before_manual(p_session_id,p_student_id);
    if e.gift_card_id is not null then f:=jsonb_set(f,'{usable}',to_jsonb(coalesce((f->>'usable')::boolean and exists(
      select 1 from public.gift_cards where id=e.gift_card_id and activated_at<=least(d,private.membership_today())),false))); end if;
    if e.membership_period_id is null and coalesce(st.student_category,'membresia')<>'membresia'
      and f->>'reason' like 'Unsupported temporal/manual funding:%'
      and exists(select 1 from public.student_manual_credit_entitlements where student_id=st.id and mode='reconcile_legacy') then
      f:=jsonb_set(f,'{no_credit_allowed}','true');
    end if;
  end if;
  if (e.manual_credit_id is not null and coalesce(st.student_category,'membresia')<>'membresia'
      and st.current_membership_period_id is null and st.classes_remaining is distinct from 0
      and not exists(select 1 from public.student_manual_credit_entitlements where student_id=st.id and mode='reconcile_legacy'))
    or exists(select 1 from public.manual_credit_entitlements_with_balance mc where mc.student_id=st.id and mc.sede_id=s.sede_id
      and mc.remaining_classes>0 and mc.activity=a->>'activity_type' and mc.starts_on<=least(d,private.membership_today())
      and mc.ends_on>=greatest(d,private.membership_today()))
    or exists(select 1 from public.student_membership_periods where id=st.current_membership_period_id and st.classes_remaining>0)
    or exists(select 1 from public.gift_cards g where g.recipient_student_id=st.id and g.sede_id=s.sede_id
      and g.payment_status='paid' and g.status in('active','pending') and g.num_classes>g.sessions_used
      and g.expiry_date>=greatest(d,private.membership_today())
      and a->>'activity_type'=case when g.type='torno' then 'torno' when g.type='modelado' then 'mesa' end) then
      f:=jsonb_set(f,'{no_credit_allowed}','false');
  end if;
  return jsonb_set(f,'{snapshot}',f->'snapshot'||jsonb_build_object('activity_type',a->>'activity_type',
    'activity_block_id',a->'block_id','activity_teacher_id',a->'teacher_id','activity_capacity',a->'capacity'));
end $$;

alter function private.apply_gift_card_session(uuid,uuid,uuid,boolean,uuid,uuid) rename to apply_gift_card_session_before_atomic_mixed;
create function private.apply_gift_card_session(p_gift_card_id uuid,p_session_id uuid,p_student_id uuid,p_reverse boolean,
  p_request_key uuid default null,p_sede_id uuid default null) returns public.gift_cards
language plpgsql security definer set search_path='' as $$
declare s public.sessions; card public.gift_cards; receipt public.gift_card_operation_receipts; a jsonb; net bigint;
begin
  select * into s from public.sessions where id=p_session_id for update;
  -- Reverse the exact original gift ledger; never reinterpret activity after a renewal/correction.
  if s.class_type is distinct from 'mixto' or p_reverse is true then
    return private.apply_gift_card_session_before_atomic_mixed(p_gift_card_id,p_session_id,p_student_id,p_reverse,p_request_key,p_sede_id);
  end if;
  if p_reverse is null or p_student_id is null or p_sede_id is not null then raise exception 'Explicit mixed gift operation required'; end if;
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode='42501'; end if;
  card:=private.lock_gift_card(p_gift_card_id,p_sede_id);
  if not private.session_employee_sede(s.sede_id) then raise exception 'Session not accessible' using errcode='42501'; end if;
  if p_request_key is not null then
    select * into receipt from public.gift_card_operation_receipts where request_key=p_request_key;
    if found then
      if receipt.gift_card_id<>card.id or receipt.session_id is distinct from p_session_id
        or receipt.student_id is distinct from p_student_id or receipt.operation<>'redeem' then raise exception 'Idempotency key conflicts with original gift card operation'; end if;
      return jsonb_populate_record(null::public.gift_cards,receipt.card_snapshot);
    end if;
  end if;
  perform 1 from public.session_students where session_id=s.id and student_id=p_student_id and sede_id=s.sede_id
    and gift_card_id=card.id for update;
  if not found or card.sede_id is distinct from s.sede_id or card.recipient_student_id is distinct from p_student_id then
    raise exception 'Student must be the explicit gift card recipient in the same sede';
  end if;
  a:=private.mixed_activity(s.id,p_student_id);
  select coalesce(sum(sessions_delta),0) into net from public.gift_card_movements where gift_card_id=card.id
    and session_id=s.id and student_id=p_student_id and movement_type in('redeem','reverse');
  if net not in(0,1) or exists(select 1 from public.gift_card_movements where gift_card_id=card.id
    and session_id=s.id and student_id=p_student_id and sede_id is distinct from s.sede_id) then raise exception 'Legacy gift card ledger requires explicit reconciliation'; end if;
  if net=0 then
    if not (private.session_business_funding(s.id,p_student_id)->>'usable')::boolean
      or a->>'activity_type' is distinct from (case when card.type='torno' then 'torno' when card.type='modelado' then 'mesa' end) then
      raise exception 'Original mixed gift is not valid available funding';
    end if;
    if exists(select 1 from public.gift_card_movements where session_id=s.id and student_id=p_student_id and gift_card_id<>card.id
      and movement_type in('redeem','reverse') group by gift_card_id having sum(sessions_delta)<>0) then
      raise exception 'Session already has another gift card consumption; reconcile its ledger first';
    end if;
    insert into public.gift_card_movements(gift_card_id,session_id,student_id,sede_id,movement_type,sessions_delta,note)
      values(card.id,s.id,p_student_id,s.sede_id,'redeem',1,'Asistencia validada');
    update public.gift_cards set sessions_used=sessions_used+1,status=case when sessions_used+1=num_classes then 'consumed' else 'active' end,
      consumed_at=case when sessions_used+1=num_classes then (now() at time zone 'UTC')::date else null end where id=card.id returning * into card;
  end if;
  if p_request_key is not null then insert into public.gift_card_operation_receipts(request_key,gift_card_id,sede_id,session_id,student_id,operation,card_snapshot,created_by)
    values(p_request_key,card.id,s.sede_id,s.id,p_student_id,'redeem',to_jsonb(card),auth.uid()); end if;
  return card;
end $$;

alter function private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb) rename to save_session_reservation_before_atomic_mixed;
drop function public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb);
create function private.save_session_reservation(p_session_id uuid,p_request_key uuid,p_expected_revision bigint,p_sede_id uuid,
  p_metadata jsonb,p_student_ids uuid[],p_gift_card_ids jsonb default '{}',p_manual_credit_ids jsonb default '{}',p_activity_blocks jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare s public.sessions; proposed public.sessions; prior public.session_operation_receipts; existed boolean;
  roster uuid[]; active_roster uuid[]; block_students uuid[]; ids uuid[]; blocks jsonb:='[]'; saved jsonb; bindings jsonb;
  intent jsonb; result jsonb; item jsonb; spec jsonb; bid uuid; total integer:=0; sid uuid; teacher uuid; cap integer; typ text; history boolean;
begin
  if not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode='42501'; end if;
  if p_session_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision<0
    or p_metadata is null or jsonb_typeof(p_metadata)<>'object' or p_student_ids is null or array_position(p_student_ids,null) is not null
    or p_gift_card_ids is null or jsonb_typeof(p_gift_card_ids)<>'object' or p_manual_credit_ids is null or jsonb_typeof(p_manual_credit_ids)<>'object'
    or p_activity_blocks is null or jsonb_typeof(p_activity_blocks)<>'array' then raise exception 'Explicit reservation metadata, roster and block array required'; end if;
  if p_metadata-array['date','start_time','end_time','class_type','capacity','teacher_id','workshop_name','private_reason','session_audience']<>'{}' then
    raise exception 'Unsupported reservation metadata; attendance uses its own RPC'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text,0));
  select * into s from public.sessions where id=p_session_id for update; existed:=found;
  if (existed and s.sede_id<>p_sede_id) or not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode='42501'; end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into roster from unnest(p_student_ids) id;
  if cardinality(roster)<>(select count(distinct id) from unnest(roster) id) then raise exception 'Duplicate roster student IDs'; end if;
  for item in select value from jsonb_array_elements(p_activity_blocks) loop
    if jsonb_typeof(item)<>'object' or not item ?& array['activity_type','teacher_id','capacity','student_ids']
      or item-array['id','activity_type','teacher_id','capacity','student_ids']<>'{}'
      or jsonb_typeof(item->'activity_type')<>'string' or item->>'activity_type' not in('mesa','torno','coworking','workshop','privada')
      or jsonb_typeof(item->'teacher_id') not in('string','null') or jsonb_typeof(item->'capacity')<>'number'
      or (item->>'capacity') !~ '^[0-9]+$' or jsonb_typeof(item->'student_ids')<>'array'
      or (item ? 'id' and jsonb_typeof(item->'id')<>'string') then raise exception 'Exact activity, teacher, integer capacity and UUID student arrays required'; end if;
    cap:=(item->>'capacity')::integer; if cap not between 1 and 100 then raise exception 'Block capacity must be between 1 and 100'; end if;
    if exists(select 1 from jsonb_array_elements(item->'student_ids') v where jsonb_typeof(v)<>'string') then raise exception 'Block students require UUID strings'; end if;
    select coalesce(array_agg(value::uuid order by value::uuid),'{}'::uuid[]) into ids from jsonb_array_elements_text(item->'student_ids');
    if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Duplicate block student IDs'; end if;
    spec:=jsonb_build_object('activity_type',item->>'activity_type','teacher_id',(item->>'teacher_id')::uuid,'capacity',cap,'student_ids',to_jsonb(ids));
    if item ? 'id' then spec:=spec||jsonb_build_object('id',(item->>'id')::uuid); end if;
    blocks:=blocks||jsonb_build_array(spec); total:=total+cap;
  end loop;
  select coalesce(jsonb_agg(value order by value->>'activity_type',value->>'teacher_id',value->>'capacity',value->'student_ids'::text,value->>'id'),'[]') into blocks from jsonb_array_elements(blocks);
  intent:=jsonb_build_object('expected_revision',p_expected_revision,'metadata',p_metadata,'student_ids',to_jsonb(roster),'gift_card_ids',p_gift_card_ids,'sede_id',p_sede_id);
  if p_manual_credit_ids<>'{}' then intent:=intent||jsonb_build_object('manual_credit_ids',p_manual_credit_ids); end if;
  if blocks<>'[]' then intent:=intent||jsonb_build_object('activity_blocks',blocks); end if;
  select * into prior from public.session_operation_receipts where session_id=s.id and request_key=p_request_key;
  if found then
    if prior.operation<>'reservation' or prior.intent<>intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
    return prior.result||jsonb_build_object('replayed',true);
  end if;
  proposed:=jsonb_populate_record(null::public.sessions,coalesce(to_jsonb(s),'{}')||p_metadata);
  if proposed.class_type is distinct from 'mixto' then
    if blocks<>'[]' or s.class_type='mixto' then raise exception 'Activity blocks require mixto; mixed sessions cannot become classic'; end if;
    return private.save_session_reservation_before_atomic_mixed(p_session_id,p_request_key,p_expected_revision,p_sede_id,p_metadata,p_student_ids,p_gift_card_ids,p_manual_credit_ids);
  end if;
  if existed and s.attendance_policy_version<>2 then raise exception 'Mixed sessions require policy2'; end if;
  if (existed and s.revision<>p_expected_revision) or (not existed and p_expected_revision<>0) then raise exception 'Stale session revision' using errcode='40001'; end if;
  if blocks='[]' or total not between 1 and 100 then raise exception 'Mixed sessions require explicit blocks with total capacity at most 100'; end if;
  if p_metadata ? 'capacity' and proposed.capacity is distinct from total then raise exception 'Parent capacity must equal block capacity sum'; end if;
  proposed.capacity:=total; proposed.session_audience:=coalesce(proposed.session_audience,'membresia');
  if proposed.teacher_id is not null then raise exception 'Mixed parent teacher must be null; supply each block teacher explicitly'; end if;
  perform private.atomic_session_date(proposed.date,proposed.start_time,proposed.end_time);
  perform private.session_madrid_instant(proposed.start_time); perform private.session_madrid_instant(proposed.end_time);
  if exists(select 1 from jsonb_each(p_gift_card_ids||p_manual_credit_ids) c where c.key<>c.key::uuid::text
    or c.key::uuid<>all(roster) or jsonb_typeof(c.value)<>'string') then raise exception 'Funding links must identify roster students with UUID strings'; end if;
  if exists(select 1 from jsonb_object_keys(p_manual_credit_ids) k where p_gift_card_ids ? k) then raise exception 'Ambiguous session funding'; end if;
  if exists(select 1 from jsonb_array_elements(blocks) b where b ? 'id' and not exists(select 1 from public.session_activity_blocks
    where id=(b->>'id')::uuid and session_id=p_session_id and sede_id=p_sede_id)) then raise exception 'Block IDs must belong to this session and sede'; end if;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(blocks)) or (select count(*)<>count(distinct value->>'id')
    from jsonb_array_elements(blocks) where value ? 'id') then raise exception 'Duplicate activity blocks'; end if;
  perform 1 from public.gift_cards where id in(select value::uuid from jsonb_each_text(p_gift_card_ids)
    union select gift_card_id from public.session_students where session_id=p_session_id) order by id for update;
  perform 1 from public.student_manual_credit_entitlements where id in(select value::uuid from jsonb_each_text(p_manual_credit_ids)
    union select manual_credit_id from public.session_students where session_id=p_session_id) order by id for update;
  perform 1 from public.students where id in(select unnest(roster) union select student_id from public.session_students where session_id=p_session_id) order by id for update;
  perform 1 from public.session_students where session_id=p_session_id order by student_id for update;
  perform 1 from public.session_activity_blocks where session_id=p_session_id order by id for update;
  perform 1 from public.session_activity_block_students where session_id=p_session_id order by block_id,student_id for update;
  if not private.session_employee_sede(p_sede_id) then raise exception 'Session not accessible' using errcode='42501'; end if;
  if (select count(*) from public.students where id=any(roster) and sede_id=p_sede_id)<>cardinality(roster) then raise exception 'Roster students must belong to the session sede'; end if;
  select coalesce(array_agg(r.id order by r.id),'{}'::uuid[]) into active_roster from unnest(roster) r(id) where not exists(select 1 from public.session_students e
    where e.session_id=p_session_id and e.student_id=r.id and e.cancelled_at is not null);
  select coalesce(array_agg(st.value::uuid order by st.value::uuid),'{}'::uuid[]) into block_students from jsonb_array_elements(blocks) b
    cross join lateral jsonb_array_elements_text(b->'student_ids') st(value);
  if block_students is distinct from active_roster then raise exception 'Each active roster student must occur in exactly one block; cancellations are excluded'; end if;
  if exists(select 1 from public.session_students where session_id=p_session_id and cancelled_at is null and student_id<>all(roster)) then
    raise exception 'Use cancel_session_reservation to remove an active reservation'; end if;
  if exists(select 1 from public.session_students e join public.sessions other on other.id=e.session_id where e.student_id=any(active_roster)
    and other.id<>p_session_id and e.cancelled_at is null and other.start_time<proposed.end_time and other.end_time>proposed.start_time) then
    raise exception 'Student already reserved in an overlapping session'; end if;
  history:=existed and (s.completed_at is not null or exists(select 1 from public.session_students where session_id=s.id and cancelled_at is not null));
  if history and (proposed.date is distinct from s.date or proposed.start_time is distinct from s.start_time or proposed.end_time is distinct from s.end_time
    or proposed.class_type is distinct from s.class_type or proposed.capacity is distinct from s.capacity) then raise exception 'Mixed history locks interval, capacity and original activity teachers'; end if;
  if history and not exists(select 1 from private.mixed_session_reservations where session_id=s.id) then
    raise exception 'Historical mixed activity provenance cannot be rebound'; end if;
  if exists(select 1 from public.session_students where session_id=p_session_id and cancelled_at is not null
    and ((p_gift_card_ids ? student_id::text and gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid)
      or (p_manual_credit_ids ? student_id::text and manual_credit_id is distinct from (p_manual_credit_ids->>student_id::text)::uuid))) then
    raise exception 'Cancellation and its original funding are immutable'; end if;
  for item in select value from jsonb_array_elements(blocks) loop
    typ:=item->>'activity_type'; teacher:=(item->>'teacher_id')::uuid; cap:=(item->>'capacity')::integer;
    if jsonb_array_length(item->'student_ids')>cap then raise exception 'Activity block capacity exceeded'; end if;
    if teacher is not null and not exists(select 1 from public.teachers where id=teacher and sede_id=p_sede_id) then raise exception 'Block teacher must belong to the session sede'; end if;
    if exists(select 1 from jsonb_array_elements_text(item->'student_ids') st join public.gift_cards g on g.id=(p_gift_card_ids->>st.value)::uuid
      where g.sede_id is distinct from p_sede_id or g.recipient_student_id is distinct from st.value::uuid
        or typ is distinct from case when g.type='torno' then 'torno' when g.type='modelado' then 'mesa' end) then raise exception 'Selected gift must match student, sede and block activity'; end if;
    if exists(select 1 from jsonb_array_elements_text(item->'student_ids') st where p_gift_card_ids ? st.value
      and not exists(select 1 from public.gift_cards where id=(p_gift_card_ids->>st.value)::uuid)) then raise exception 'Explicit gift card is unknown'; end if;
    if exists(select 1 from jsonb_array_elements_text(item->'student_ids') st where p_manual_credit_ids ? st.value and not exists(
      select 1 from public.student_manual_credit_entitlements c where c.id=(p_manual_credit_ids->>st.value)::uuid
        and c.student_id=st.value::uuid and c.sede_id=p_sede_id and c.activity=typ)) then raise exception 'Selected manual credit must match student, sede and block activity'; end if;
  end loop;
  if existed and s.completed_at is not null and (active_roster is distinct from (select coalesce(array_agg(student_id order by student_id),'{}'::uuid[])
    from public.session_students where session_id=s.id and cancelled_at is null) or exists(select 1 from public.session_students where session_id=s.id and cancelled_at is null
      and (gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid or manual_credit_id is distinct from (p_manual_credit_ids->>student_id::text)::uuid))) then
    raise exception 'Finalized roster and original funding are locked'; end if;
  -- No receipt is visible until the parent, sources, activities and independent block capacities all succeed.
  insert into private.mixed_session_writers values(pg_backend_pid(),txid_current(),p_session_id);
  if existed then
    update public.sessions set date=proposed.date,start_time=proposed.start_time,end_time=proposed.end_time,class_type='mixto',capacity=total,
      teacher_id=null,workshop_name=proposed.workshop_name,private_reason=proposed.private_reason,session_audience=proposed.session_audience,
      revision=revision+1 where id=s.id returning * into s;
  else
    insert into public.sessions(id,sede_id,date,start_time,end_time,class_type,capacity,teacher_id,workshop_name,private_reason,session_audience,revision)
      values(p_session_id,p_sede_id,proposed.date,proposed.start_time,proposed.end_time,'mixto',total,null,proposed.workshop_name,proposed.private_reason,proposed.session_audience,1) returning * into s;
  end if;
  if s.completed_at is null then
    update public.session_students set gift_card_id=(p_gift_card_ids->>student_id::text)::uuid,manual_credit_id=(p_manual_credit_ids->>student_id::text)::uuid,
      membership_period_id=case when p_gift_card_ids ? student_id::text or p_manual_credit_ids ? student_id::text then null
        when gift_card_id is not null or manual_credit_id is not null then (select current_membership_period_id from public.students where id=student_id) else membership_period_id end
      where session_id=s.id and student_id=any(active_roster);
    insert into public.session_students(session_id,student_id,student_name,sede_id,attendance,gift_card_id,membership_period_id,manual_credit_id,is_temporary,temp_group_name)
      select s.id,st.id,upper(trim(concat_ws(' ',st.name,st.surname))),s.sede_id,'pending',(p_gift_card_ids->>st.id::text)::uuid,
        case when p_gift_card_ids ? st.id::text or p_manual_credit_ids ? st.id::text then null else st.current_membership_period_id end,
        (p_manual_credit_ids->>st.id::text)::uuid,st.student_category='temporal',case when st.student_category='temporal' then st.group_name end
      from public.students st where st.id=any(active_roster) and not exists(select 1 from public.session_students where session_id=s.id and student_id=st.id);
  end if;
  -- Retain cancelled assignments. Active assignments may move only before finalization.
  if s.completed_at is null then delete from public.session_activity_block_students r using public.session_students e
    where r.session_id=s.id and e.session_id=r.session_id and e.student_id=r.student_id and e.cancelled_at is null; end if;
  ids:='{}';
  for item in select value from jsonb_array_elements(blocks) loop
    bid:=(item->>'id')::uuid;
    if bid is null then
      if history then raise exception 'History requires original block IDs'; end if;
      insert into public.session_activity_blocks(session_id,sede_id,activity_type,teacher_id,capacity)
        values(s.id,s.sede_id,item->>'activity_type',(item->>'teacher_id')::uuid,(item->>'capacity')::integer) returning id into bid;
    elsif exists(select 1 from public.session_activity_blocks where id=bid and (activity_type is distinct from item->>'activity_type'
      or teacher_id is distinct from (item->>'teacher_id')::uuid or capacity is distinct from (item->>'capacity')::integer)) then
      update public.session_activity_blocks set activity_type=item->>'activity_type',teacher_id=(item->>'teacher_id')::uuid,
        capacity=(item->>'capacity')::integer,updated_at=clock_timestamp() where id=bid;
    end if;
    ids:=array_append(ids,bid);
    for sid in select value::uuid from jsonb_array_elements_text(item->'student_ids') loop
      if s.completed_at is not null then
        if not exists(select 1 from public.session_activity_block_students where block_id=bid and session_id=s.id and student_id=sid) then raise exception 'Finalized activity assignment is immutable'; end if;
      else
        update public.session_students set activity_type=item->>'activity_type' where session_id=s.id and student_id=sid;
        insert into public.session_activity_block_students(block_id,session_id,student_id) values(bid,s.id,sid);
      end if;
    end loop;
  end loop;
  delete from public.session_activity_blocks where session_id=s.id and id<>all(ids);
  if exists(select 1 from public.session_students e where session_id=s.id and not exists(select 1 from public.session_activity_block_students
    where session_id=s.id and student_id=e.student_id)) then raise exception 'Mixed roster requires exactly one activity assignment including cancellations'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'activity_type',b.activity_type,'teacher_id',b.teacher_id,'capacity',b.capacity,
    'student_ids',(select coalesce(jsonb_agg(student_id order by student_id),'[]') from public.session_activity_block_students where block_id=b.id)) order by b.id),'[]')
    into saved from public.session_activity_blocks b where session_id=s.id;
  select coalesce(jsonb_agg(jsonb_build_object('student_id',e.student_id,'block_id',r.block_id,'activity_type',e.activity_type,
    'period_id',e.membership_period_id,'gift_card_id',e.gift_card_id,'manual_credit_id',e.manual_credit_id) order by e.student_id),'[]') into bindings
    from public.session_students e join public.session_activity_block_students r on r.session_id=e.session_id and r.student_id=e.student_id where e.session_id=s.id;
  insert into private.mixed_session_reservations(session_id,request_key,sede_id,revision,blocks_snapshot,roster_snapshot,session_snapshot,created_by)
    values(s.id,p_request_key,s.sede_id,s.revision,saved,bindings,to_jsonb(s)-array['id','sede_id','revision','created_at','completed_at','teacher_substitute_id','type','title','max_capacity','instructor_id','workshop_name','private_reason','session_audience'],auth.uid());
  for sid in select student_id from public.session_students where session_id=s.id order by student_id loop perform private.session_business_funding(s.id,sid); end loop;
  result:=jsonb_build_object('session_id',s.id,'request_key',p_request_key,'revision',s.revision,'session',to_jsonb(s),
    'student_ids',(select coalesce(jsonb_agg(student_id order by student_id),'[]') from public.session_students where session_id=s.id),
    'active_student_ids',to_jsonb(active_roster),'activity_blocks',saved,'activity_assignments',bindings,'replayed',false);
  insert into public.session_operation_receipts(session_id,request_key,sede_id,operation,intent,result,created_by)
    values(s.id,p_request_key,s.sede_id,'reservation',intent,result,auth.uid());
  delete from private.mixed_session_writers where backend_pid=pg_backend_pid() and transaction_id=txid_current() and session_id=s.id;
  return result;
end $$;
create function public.save_session_reservation(p_session_id uuid,p_request_key uuid,p_expected_revision bigint,p_sede_id uuid,
  p_metadata jsonb,p_student_ids uuid[],p_gift_card_ids jsonb default '{}',p_manual_credit_ids jsonb default '{}',p_activity_blocks jsonb default '[]')
returns jsonb language sql security invoker set search_path='' as $$
  select private.save_session_reservation(p_session_id,p_request_key,p_expected_revision,p_sede_id,p_metadata,p_student_ids,p_gift_card_ids,p_manual_credit_ids,p_activity_blocks);
$$;

create view public.session_activity_business_state with(security_invoker=true) as
select v.*,case when s.class_type<>'mixto' then s.class_type when private.mixed_activity_verified(e.session_id,e.student_id) then e.activity_type end as funding_activity_type,
  r.block_id as funding_activity_block_id,b.teacher_id as activity_teacher_id,b.capacity as activity_capacity,
  private.mixed_activity_verified(e.session_id,e.student_id) as activity_source_verified
from public.session_business_state v join public.sessions s on s.id=v.session_id
join public.session_students e on e.session_id=v.session_id and e.student_id=v.student_id
left join public.session_activity_block_students r on r.session_id=e.session_id and r.student_id=e.student_id
left join public.session_activity_blocks b on b.id=r.block_id and b.session_id=s.id and b.sede_id=s.sede_id
where private.session_business_read_sede(s.sede_id);
create view public.session_credit_activity_state with(security_invoker=true) as
select m.*,v.funding_activity_type as activity_type,v.funding_activity_block_id as activity_block_id,v.activity_source_verified
from public.session_credit_movements m join public.session_activity_business_state v on v.session_id=m.session_id and v.student_id=m.student_id and v.sede_id=m.sede_id;
revoke all on public.session_activity_business_state,public.session_credit_activity_state from public,anon,authenticated,service_role;
grant select on public.session_activity_business_state,public.session_credit_activity_state to authenticated;
revoke all on function private.guard_atomic_mixed_state(),private.guard_mixed_parent_history(),private.mixed_activity(uuid,uuid),private.mixed_activity_verified(uuid,uuid),
  private.session_business_funding(uuid,uuid),private.session_business_funding_before_atomic_mixed(uuid,uuid),
  private.apply_gift_card_session(uuid,uuid,uuid,boolean,uuid,uuid),private.apply_gift_card_session_before_atomic_mixed(uuid,uuid,uuid,boolean,uuid,uuid),
  private.save_session_reservation_before_atomic_mixed(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb),
  private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb,jsonb),
  public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.mixed_activity_verified(uuid,uuid),private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb,jsonb),
  public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
