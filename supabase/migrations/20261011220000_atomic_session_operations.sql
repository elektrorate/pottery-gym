-- ROLLOUT GATE: ship only with ID-roster, revision-aware session clients.
-- Legacy present attendance has no provable funding attribution: fail closed.
begin;

alter table public.sessions add column revision bigint not null default 0 check (revision >= 0);
alter table public.session_students add column membership_period_id uuid;
alter table public.session_students add constraint session_membership_owner_fk
  foreign key (student_id, membership_period_id)
  references public.student_membership_periods(student_id, id) on delete restrict;
alter table public.session_students
  add constraint session_roster_session_sede_fk foreign key (session_id, sede_id)
    references public.sessions(id, sede_id) on delete restrict not valid,
  add constraint session_roster_student_sede_fk foreign key (student_id, sede_id)
    references public.students(id, sede_id) on delete restrict not valid;

-- FK actions execute as the child owner, bypassing the projection owner guard.
-- Replace the original single-column cascade too, not just composite FKs.
do $$
declare original record;
begin
  for original in select conname from pg_constraint where conrelid = 'public.session_students'::regclass
    and confrelid = 'public.students'::regclass and contype = 'f'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'public.session_students'::regclass
      and attname = 'student_id')]::smallint[] loop
    execute format('alter table public.session_students drop constraint %I', original.conname);
  end loop;
end $$;
alter table public.session_students add constraint session_students_student_id_fkey
  foreign key (student_id) references public.students(id) on delete restrict not valid;
alter table public.sessions
  drop constraint sessions_teacher_id_fkey,
  drop constraint sessions_teacher_substitute_id_fkey,
  add constraint sessions_teacher_id_fkey foreign key (teacher_id) references public.teachers(id) on delete restrict not valid,
  add constraint sessions_teacher_substitute_id_fkey foreign key (teacher_substitute_id) references public.teachers(id) on delete restrict not valid;

-- Atomic rollout disables every standalone per-session debit/refund entry point.
-- The private helper remains available only inside the atomic definer boundary.
-- Manual consume/cancel remain card-level observations, never session rewrites.
revoke all on function public.redeem_gift_card_session(uuid,uuid,uuid),
  public.reverse_gift_card_session(uuid,uuid,uuid),
  public.redeem_gift_card_session_once(uuid,uuid,uuid,uuid),
  public.reverse_gift_card_session_once(uuid,uuid,uuid,uuid),
  public.external_redeem_gift_card_session(uuid,uuid,uuid,uuid),
  public.external_reverse_gift_card_session(uuid,uuid,uuid,uuid),
  public.external_redeem_gift_card_session_once(uuid,uuid,uuid,uuid,uuid),
  public.external_reverse_gift_card_session_once(uuid,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create table public.session_operation_receipts (
  session_id uuid not null references public.sessions(id) on delete restrict,
  request_key uuid not null,
  sede_id uuid not null,
  operation text not null check (operation in ('attendance', 'reservation')),
  intent jsonb not null,
  result jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id, request_key),
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict
);

-- Reversals are new entries, never updates to a debit or an outgoing snapshot.
create table public.session_credit_movements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  student_id uuid not null references public.students(id) on delete restrict,
  sede_id uuid not null,
  revision bigint not null,
  period_id uuid,
  gift_card_id uuid references public.gift_cards(id) on delete restrict,
  delta integer not null check (delta in (-1, 1)),
  reverses_id uuid unique references public.session_credit_movements(id) on delete restrict,
  adjustment_id uuid references public.student_membership_class_adjustments(id) on delete restrict,
  disposition text not null check (disposition in ('current_period', 'original_period_credit', 'gift_card')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (student_id, period_id) references public.student_membership_periods(student_id, id) on delete restrict,
  foreign key (session_id, sede_id) references public.sessions(id, sede_id) on delete restrict,
  foreign key (student_id, sede_id) references public.students(id, sede_id) on delete restrict,
  check ((period_id is null) <> (gift_card_id is null)),
  check ((delta = 1) = (reverses_id is not null)),
  check (disposition <> 'original_period_credit' or (period_id is not null and delta = 1 and adjustment_id is null))
);
create index session_credit_roster_idx on public.session_credit_movements(session_id, student_id);
alter table public.session_operation_receipts enable row level security;
alter table public.session_credit_movements enable row level security;
create policy session_receipts_read on public.session_operation_receipts for select to authenticated
  using (auth.uid() is not null and private.can_access_sede(sede_id));
create policy session_credit_read on public.session_credit_movements for select to authenticated
  using (auth.uid() is not null and private.can_access_sede(sede_id));
revoke all on public.session_operation_receipts, public.session_credit_movements from public, anon, authenticated, service_role;
grant select on public.session_operation_receipts, public.session_credit_movements to authenticated;

create function private.guard_session_history() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user <> pg_get_userbyid((select relowner from pg_class where oid = tg_relid)) then
    raise exception 'Session history is server-managed' using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then raise exception 'Session history is append-only' using errcode = '42501'; end if;
  return new;
end $$;
create trigger guard_session_receipts before insert or update or delete on public.session_operation_receipts
  for each row execute function private.guard_session_history();
create trigger guard_session_credits before insert or update or delete on public.session_credit_movements
  for each row execute function private.guard_session_history();

create function private.guard_session_projection() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare target uuid;
begin
  if current_user <> pg_get_userbyid((select relowner from pg_class where oid = tg_relid)) then
    raise exception 'Protected session projection; use atomic session RPCs' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if tg_table_name = 'sessions' then target := old.id; else target := old.session_id; end if;
    if exists (select 1 from public.session_operation_receipts where session_id = target and operation = 'attendance')
      or exists (select 1 from public.session_credit_movements where session_id = target)
      or exists (select 1 from public.gift_card_movements where session_id = target)
      or exists (select 1 from public.sessions where id = target and completed_at is not null)
      or exists (select 1 from public.session_students where session_id = target and attendance = 'present') then
      raise exception 'Session attendance history cannot be deleted; correct attendance instead';
    end if;
    return old;
  end if;
  return new;
end $$;
create trigger guard_session_projection before insert or update or delete on public.sessions
  for each row execute function private.guard_session_projection();
create trigger guard_session_roster before insert or update or delete on public.session_students
  for each row execute function private.guard_session_projection();
revoke insert, update, delete, truncate on public.sessions, public.session_students from public, anon, authenticated, service_role;
revoke all on function private.guard_session_history(), private.guard_session_projection() from public, anon, authenticated, service_role;

create function private.lock_atomic_session(p_session_id uuid) returns public.sessions
language plpgsql security definer set search_path = '' as $$
declare s public.sessions;
begin
  select * into s from public.sessions where id = p_session_id for update;
  if not found or auth.uid() is null or not private.can_access_sede(s.sede_id)
    or not exists (select 1 from public.sedes where id = s.sede_id and is_active is true) then
    raise exception 'Session not accessible' using errcode = '42501';
  end if;
  return s;
end $$;

create function private.atomic_session_date(p_date text, p_start timestamptz, p_end timestamptz) returns date
language plpgsql security invoker set search_path = '' as $$
declare session_date date;
begin
  if p_date is null or p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Session date must be a real finite ISO date';
  end if;
  begin
    session_date := p_date::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Session date must be a real finite ISO date';
  end;
  if not isfinite(session_date) then raise exception 'Session date must be a real finite ISO date'; end if;
  -- The date is a wall-clock label encoded in UTC, not Madrid's instant date.
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_start >= p_end
    or (p_start at time zone 'UTC')::date <> session_date or (p_end at time zone 'UTC')::date <> session_date then
    raise exception 'Session interval must be finite and stay within its declared UTC date';
  end if;
  return session_date;
end $$;
revoke all on function private.atomic_session_date(text,timestamptz,timestamptz) from public, anon, authenticated, service_role;

create function private.save_session_attendance(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_attendance jsonb, p_finalize boolean, p_teacher_substitute_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.sessions; student public.students; enrollment public.session_students;
  prior public.session_operation_receipts; debit public.session_credit_movements;
  adjustment public.student_membership_class_adjustments; period public.student_membership_periods;
  attendance jsonb; intent jsonb; result jsonb; item record; target_status text;
  current_period uuid; disposition text; adjustment_id uuid; active_count integer; ledger_net bigint; session_date date;
begin
  s := private.lock_atomic_session(p_session_id);
  if p_request_key is null or p_expected_revision is null or p_expected_revision < 0 or p_finalize is null
    or p_attendance is null or jsonb_typeof(p_attendance) <> 'array' then
    raise exception 'Request key, revision, attendance array and finalize flag required';
  end if;
  if exists (select 1 from jsonb_array_elements(p_attendance) a where jsonb_typeof(a) <> 'object'
    or not (a ? 'student_id' and a ? 'status') or a->>'student_id' is null
    or coalesce(a->>'status', '') not in ('present', 'absent', 'pending')
    or (a - 'student_id' - 'status') <> '{}'::jsonb) then
    raise exception 'Attendance requires exact student_id/status objects';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('student_id', student_id, 'status', status) order by student_id), '[]')
    into attendance from jsonb_to_recordset(p_attendance) as a(student_id uuid, status text);
  if (select count(*) <> count(distinct student_id) from jsonb_to_recordset(attendance) as a(student_id uuid, status text)) then
    raise exception 'Duplicate attendance student IDs';
  end if;
  intent := jsonb_build_object('expected_revision', p_expected_revision, 'attendance', attendance,
    'finalize', p_finalize, 'teacher_substitute_id', p_teacher_substitute_id);
  select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
  if found then
    if prior.operation <> 'attendance' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
    return prior.result || jsonb_build_object('replayed', true);
  end if;
  if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  session_date := private.atomic_session_date(s.date, s.start_time, s.end_time);
  if exists (
    (select student_id from public.session_students where session_id = s.id
      except select student_id from jsonb_to_recordset(attendance) as a(student_id uuid, status text))
    union all
    (select student_id from jsonb_to_recordset(attendance) as a(student_id uuid, status text)
      except select student_id from public.session_students where session_id = s.id)
  ) then raise exception 'Attendance must match the exact persisted ID roster'; end if;
  if p_finalize and exists (select 1 from jsonb_to_recordset(attendance) as a(student_id uuid, status text) where status = 'pending') then
    raise exception 'Finalized attendance cannot contain pending students';
  end if;
  if s.class_type = 'feriado' and jsonb_array_length(attendance) > 0 then raise exception 'Holiday sessions cannot have attendance'; end if;
  if p_teacher_substitute_id is not null and not exists (select 1 from public.teachers
    where id = p_teacher_substitute_id and sede_id = s.sede_id) then raise exception 'Substitute must belong to the session sede'; end if;
  -- Parent -> cards -> deterministic students -> roster, including implicit FK locks.
  perform 1 from public.gift_cards where id in (select gift_card_id from public.session_students where session_id = s.id)
    order by id for update;
  perform 1 from public.students where id in (select student_id from public.session_students where session_id = s.id)
    order by id for update;
  if exists (select 1 from public.session_students e left join public.students st on st.id = e.student_id
    where e.session_id = s.id and (e.sede_id is distinct from s.sede_id or st.sede_id is distinct from s.sede_id)) then
    raise exception 'Legacy cross-sede roster requires reconciliation';
  end if;
  perform 1 from public.session_students where session_id = s.id order by student_id for update;
  for item in select * from jsonb_to_recordset(attendance) as a(student_id uuid, status text) order by student_id loop
    select * into enrollment from public.session_students where session_id = s.id and student_id = item.student_id;
    select * into student from public.students where id = item.student_id;
    select count(*) into active_count from public.session_credit_movements m where m.session_id = s.id
      and m.student_id = item.student_id and m.delta = -1
      and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id);
    if active_count > 1 then raise exception 'Session funding requires reconciliation'; end if;
    select * into debit from public.session_credit_movements m where m.session_id = s.id
      and m.student_id = item.student_id and m.delta = -1
      and not exists (select 1 from public.session_credit_movements r where r.reverses_id = m.id);
    if coalesce(enrollment.attendance, 'pending') = 'present' and active_count = 0 then
      raise exception 'Historical attendance funding is unknown; explicit reconciliation required';
    end if;
    if (active_count = 1) <> (coalesce(enrollment.attendance, 'pending') = 'present') then
      raise exception 'Attendance and funding receipt disagree; reconciliation required';
    end if;
    select coalesce(sum(sessions_delta), 0) into ledger_net from public.gift_card_movements
      where session_id = s.id and student_id = item.student_id and movement_type in ('redeem', 'reverse');
    if ledger_net <> (case when active_count = 1 and debit.gift_card_id is not null then 1 else 0 end) then
      raise exception 'Gift card ledger and attendance receipt disagree; reconciliation required';
    end if;
    if exists (select 1 from public.gift_card_movements where session_id = s.id and student_id = item.student_id
      and movement_type in ('redeem', 'reverse') group by gift_card_id
      having sum(sessions_delta) <> (case when active_count = 1 and gift_card_id = debit.gift_card_id then 1 else 0 end)) then
      raise exception 'Original gift card ledger attribution disagrees; reconciliation required';
    end if;
    target_status := item.status;
    if target_status = 'present' and active_count = 0 then
      if enrollment.gift_card_id is not null then
        if enrollment.membership_period_id is not null then raise exception 'Ambiguous session funding'; end if;
        perform private.apply_gift_card_session(enrollment.gift_card_id, s.id, student.id, false, gen_random_uuid());
        insert into public.session_credit_movements(session_id, student_id, sede_id, revision, gift_card_id, delta, disposition, created_by)
          values (s.id, student.id, s.sede_id, s.revision + 1, enrollment.gift_card_id, -1, 'gift_card', auth.uid());
      else
        if coalesce(student.student_category, 'membresia') <> 'membresia' or student.current_membership_period_id is null then
          raise exception 'Explicit gift card or initialized membership funding required';
        end if;
        current_period := private.reconcile_student_membership(student.id);
        if enrollment.membership_period_id is not null and enrollment.membership_period_id <> current_period then
          raise exception 'Original funding period is no longer current; explicit reconciliation required';
        end if;
        select * into period from public.student_membership_periods where id = current_period;
        select * into student from public.students where id = student.id;
        if period.sede_id is distinct from s.sede_id or period.payment_status is distinct from 'paid'
          or student.archived_at is not null or period.starts_on is null or period.ends_on is null
          or session_date not between period.starts_on and period.ends_on then
          raise exception 'Membership funding must be paid, unarchived and cover the session date';
        end if;
        adjustment := private.adjust_student_membership_classes(student.id, current_period, gen_random_uuid(), student.classes_remaining, -1);
        update public.session_students set membership_period_id = current_period where id = enrollment.id;
        insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, delta, adjustment_id, disposition, created_by)
          values (s.id, student.id, s.sede_id, s.revision + 1, current_period, -1, adjustment.id, 'current_period', auth.uid());
      end if;
    elsif target_status <> 'present' and active_count = 1 then
      adjustment_id := null;
      if debit.gift_card_id is not null then
        if enrollment.gift_card_id is distinct from debit.gift_card_id then raise exception 'Original gift card link changed; reconciliation required'; end if;
        perform private.apply_gift_card_session(debit.gift_card_id, s.id, student.id, true, gen_random_uuid());
        disposition := 'gift_card';
      else
        if enrollment.membership_period_id is distinct from debit.period_id then raise exception 'Original membership link changed; reconciliation required'; end if;
        current_period := private.reconcile_student_membership(student.id);
        disposition := 'original_period_credit';
        if current_period = debit.period_id then
          select * into student from public.students where id = student.id;
          adjustment := private.adjust_student_membership_classes(student.id, debit.period_id, gen_random_uuid(), student.classes_remaining, 1);
          adjustment_id := adjustment.id;
          disposition := 'current_period';
        end if;
      end if;
      insert into public.session_credit_movements(session_id, student_id, sede_id, revision, period_id, gift_card_id,
        delta, reverses_id, adjustment_id, disposition, created_by)
        values (s.id, student.id, s.sede_id, s.revision + 1, debit.period_id, debit.gift_card_id,
          1, debit.id, adjustment_id, disposition, auth.uid());
    end if;
    update public.session_students set attendance = target_status where id = enrollment.id;
  end loop;
  update public.sessions set revision = revision + 1,
    completed_at = case when p_finalize then coalesce(completed_at, now()) else null end,
    teacher_substitute_id = p_teacher_substitute_id where id = s.id returning * into s;
  result := jsonb_build_object('session_id', s.id, 'request_key', p_request_key, 'revision', s.revision,
    'attendance', attendance, 'completed_at', s.completed_at, 'teacher_substitute_id', s.teacher_substitute_id,
    'credit_movements', coalesce((select jsonb_agg(to_jsonb(m) order by student_id) from public.session_credit_movements m
      where session_id = s.id and revision = s.revision), '[]'), 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'attendance', intent, result, auth.uid());
  return result;
end $$;

create function public.save_session_attendance(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint,
  p_attendance jsonb, p_finalize boolean, p_teacher_substitute_id uuid
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.save_session_attendance(p_session_id, p_request_key, p_expected_revision,
    p_attendance, p_finalize, p_teacher_substitute_id);
$$;

create function private.save_session_reservation(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint, p_sede_id uuid,
  p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare s public.sessions; proposed public.sessions; prior public.session_operation_receipts;
  intent jsonb; result jsonb; roster uuid[]; existed boolean; has_history boolean;
begin
  if auth.uid() is null or not private.can_access_sede(p_sede_id)
    or not exists (select 1 from public.sedes where id = p_sede_id and is_active is true) then
    raise exception 'Session not accessible' using errcode = '42501';
  end if;
  if p_session_id is null or p_request_key is null or p_expected_revision is null or p_expected_revision < 0
    or p_student_ids is null or array_position(p_student_ids, null) is not null
    or p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
    or p_gift_card_ids is null or jsonb_typeof(p_gift_card_ids) <> 'object' then
    raise exception 'Explicit session, request key, revision, metadata and ID roster required';
  end if;
  if (p_metadata - array['date', 'start_time', 'end_time', 'class_type', 'capacity', 'teacher_id',
    'workshop_name', 'private_reason', 'session_audience']) <> '{}'::jsonb then
    raise exception 'Unsupported reservation metadata; attendance uses its own RPC';
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into roster from unnest(p_student_ids) id;
  if cardinality(roster) <> (select count(distinct id) from unnest(roster) id) then raise exception 'Duplicate roster student IDs'; end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c where c.key <> c.key::uuid::text) then
    raise exception 'Gift card map keys must be canonical lowercase hyphenated UUIDs';
  end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c where c.key::uuid <> all(roster) or c.value is null) then
    raise exception 'Gift card links must identify roster students';
  end if;
  intent := jsonb_build_object('expected_revision', p_expected_revision, 'metadata', p_metadata,
    'student_ids', to_jsonb(roster), 'gift_card_ids', p_gift_card_ids, 'sede_id', p_sede_id);
  -- The advisory lock also serializes creation retries before a parent exists.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into s from public.sessions where id = p_session_id for update;
  existed := found;
  if existed then
    s := private.lock_atomic_session(p_session_id);
    if s.sede_id <> p_sede_id then raise exception 'Session not accessible' using errcode = '42501'; end if;
    select * into prior from public.session_operation_receipts where session_id = s.id and request_key = p_request_key;
    if found then
      if prior.operation <> 'reservation' or prior.intent <> intent then raise exception 'Idempotency key conflicts with original session intent'; end if;
      return prior.result || jsonb_build_object('replayed', true);
    end if;
    if s.revision <> p_expected_revision then raise exception 'Stale session revision' using errcode = '40001'; end if;
  elsif p_expected_revision <> 0 then raise exception 'Stale session revision' using errcode = '40001';
  end if;
  proposed := jsonb_populate_record(null::public.sessions, coalesce(to_jsonb(s), '{}'::jsonb) || p_metadata);
  proposed.capacity := coalesce(proposed.capacity, 8);
  proposed.session_audience := coalesce(proposed.session_audience, 'membresia');
  perform private.atomic_session_date(proposed.date, proposed.start_time, proposed.end_time);
  if proposed.class_type is null or proposed.class_type not in ('mesa', 'torno', 'coworking', 'workshop', 'privada', 'feriado')
    or proposed.capacity not between 1 and 100 then raise exception 'Valid session interval, date, class type and capacity required'; end if;
  if cardinality(roster) > proposed.capacity then raise exception 'Session capacity exceeded'; end if;
  if proposed.class_type = 'feriado' and cardinality(roster) > 0 then raise exception 'Holiday sessions cannot have a roster'; end if;
  if proposed.teacher_id is not null and not exists (select 1 from public.teachers
    where id = proposed.teacher_id and sede_id = p_sede_id) then raise exception 'Teacher must belong to the session sede'; end if;
  perform 1 from public.gift_cards where id in (
    select value::uuid from jsonb_each_text(p_gift_card_ids)
    union select gift_card_id from public.session_students where session_id = p_session_id
  ) order by id for update;
  perform 1 from public.students where id in (select unnest(roster) union select student_id from public.session_students where session_id = p_session_id)
    order by id for update;
  if (select count(*) from public.students where id = any(roster) and sede_id = p_sede_id) <> cardinality(roster) then
    raise exception 'Roster students must belong to the session sede';
  end if;
  if exists (select 1 from public.session_students e left join public.students st on st.id = e.student_id
    where e.session_id = p_session_id and (e.sede_id is distinct from p_sede_id or st.sede_id is distinct from p_sede_id)) then
    raise exception 'Legacy cross-sede roster requires reconciliation';
  end if;
  if exists (select 1 from public.session_students e join public.sessions other on other.id = e.session_id
    where e.student_id = any(roster) and other.id <> p_session_id
      and other.start_time < proposed.end_time and other.end_time > proposed.start_time) then
    raise exception 'Student already reserved in an overlapping session';
  end if;
  has_history := existed and (s.completed_at is not null
    or exists (select 1 from public.session_operation_receipts where session_id = s.id and operation = 'attendance')
    or exists (select 1 from public.session_credit_movements where session_id = s.id)
    or exists (select 1 from public.gift_card_movements where session_id = s.id)
    or exists (select 1 from public.session_students where session_id = s.id and attendance = 'present'));
  if has_history and (proposed.date is distinct from s.date or proposed.start_time is distinct from s.start_time
    or proposed.end_time is distinct from s.end_time or proposed.class_type is distinct from s.class_type
    or roster is distinct from (select coalesce(array_agg(student_id order by student_id), '{}'::uuid[]) from public.session_students where session_id = s.id)
    or exists (select 1 from public.session_students where session_id = s.id
      and gift_card_id is distinct from (p_gift_card_ids->>student_id::text)::uuid)) then
    raise exception 'Session history locks roster, interval and original funding; correct attendance instead';
  end if;
  if exists (select 1 from jsonb_each_text(p_gift_card_ids) c left join public.gift_cards g on g.id = c.value::uuid
    where g.id is null or g.sede_id is distinct from p_sede_id or g.recipient_student_id is distinct from c.key::uuid) then
    raise exception 'Explicit gift card must belong to its roster student and session sede';
  end if;
  if existed then
    -- Capacity triggers must see the reduced roster before a lower capacity.
    if not has_history then
      delete from public.session_students where session_id = s.id and student_id <> all(roster);
    end if;
    update public.sessions set date = proposed.date, start_time = proposed.start_time, end_time = proposed.end_time,
      class_type = proposed.class_type, capacity = proposed.capacity, teacher_id = proposed.teacher_id,
      workshop_name = proposed.workshop_name, private_reason = proposed.private_reason,
      session_audience = proposed.session_audience, revision = revision + 1 where id = s.id returning * into s;
  else
    insert into public.sessions(id, sede_id, date, start_time, end_time, class_type, capacity, teacher_id,
      workshop_name, private_reason, session_audience, revision)
      values (p_session_id, p_sede_id, proposed.date, proposed.start_time, proposed.end_time, proposed.class_type,
        proposed.capacity, proposed.teacher_id, proposed.workshop_name, proposed.private_reason, proposed.session_audience, 1)
      returning * into s;
  end if;
  -- BEFORE INSERT capacity checks run even on ON CONFLICT. Retained students
  -- must never pass through an insert trigger that counts their existing seat.
  update public.session_students set gift_card_id = (p_gift_card_ids->>student_id::text)::uuid
    where session_id = s.id and student_id = any(roster);
  insert into public.session_students(session_id, student_id, student_name, sede_id, attendance, gift_card_id, is_temporary, temp_group_name)
    select s.id, st.id, upper(trim(concat_ws(' ', st.name, st.surname))), s.sede_id, 'pending',
      (p_gift_card_ids->>st.id::text)::uuid, st.student_category = 'temporal',
      case when st.student_category = 'temporal' then st.group_name else null end
    from public.students st where st.id = any(roster)
      and not exists (select 1 from public.session_students e where e.session_id = s.id and e.student_id = st.id);
  result := jsonb_build_object('session_id', s.id, 'request_key', p_request_key, 'revision', s.revision,
    'session', to_jsonb(s), 'student_ids', to_jsonb(roster), 'replayed', false);
  insert into public.session_operation_receipts(session_id, request_key, sede_id, operation, intent, result, created_by)
    values (s.id, p_request_key, s.sede_id, 'reservation', intent, result, auth.uid());
  return result;
end $$;

create function public.save_session_reservation(
  p_session_id uuid, p_request_key uuid, p_expected_revision bigint, p_sede_id uuid,
  p_metadata jsonb, p_student_ids uuid[], p_gift_card_ids jsonb default '{}'
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.save_session_reservation(p_session_id, p_request_key, p_expected_revision,
    p_sede_id, p_metadata, p_student_ids, p_gift_card_ids);
$$;

-- Reservation receipts preserve creation history too. Deletion is deliberately
-- not offered: a session with durable receipts must remain addressable on retry.
revoke all on function private.lock_atomic_session(uuid),
  private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb),
  public.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb) from public, anon, authenticated, service_role;
grant execute on function private.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  private.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb),
  public.save_session_attendance(uuid,uuid,bigint,jsonb,boolean,uuid),
  public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
