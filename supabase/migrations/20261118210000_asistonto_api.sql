-- Asistonto connection layer (read + draft/approve/commit writes).
-- * Only service_role (the asistonto-read / asistonto-write Edge Functions) can execute
--   the public entry points; anon/authenticated get nothing. Tables live in private.
-- * Reads are scoped to one sede and project PII-minimal fields only
--   (no email, phone, birth date, notes, buyer data or metadata).
-- * Writes are never direct: draft (asistonto) -> approve (RIO, with the reference of
--   Erick's literal OK) -> commit (idempotent, once). Drafts expire after 24 hours.
-- * Session writes reuse the existing atomic reservation / cancellation RPCs. The only
--   change to them is an integration-actor path in private.session_employee_sede that
--   is active solely inside an asistonto commit transaction for a provisioned actor.
begin;

-- 1) Drafts and insert-only audit -------------------------------------------------
create table private.asistonto_drafts (
  id uuid primary key default gen_random_uuid(),
  sede_id uuid not null references public.sedes(id) on delete restrict,
  kind text not null check (kind in ('bono.create', 'student.create', 'session.book', 'session.cancel')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  summary text not null check (length(summary) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'committed', 'discarded')),
  created_by text not null check (created_by = 'asistonto'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  approved_by text check (approved_by = 'rio'),
  approval_ref text check (approval_ref is null or length(approval_ref) between 1 and 200),
  approved_at timestamptz,
  committed_by text check (committed_by in ('asistonto', 'rio')),
  committed_at timestamptz,
  result jsonb,
  constraint asistonto_drafts_expiry check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  constraint asistonto_drafts_state check (
    (status = 'pending' and approved_at is null and committed_at is null)
    or (status = 'approved' and approved_by is not null and approval_ref is not null and approved_at is not null and committed_at is null)
    or (status = 'committed' and approved_at is not null and committed_at is not null and result is not null)
    or (status = 'discarded' and committed_at is null))
);
create index asistonto_drafts_sede_status_idx on private.asistonto_drafts (sede_id, status, created_at desc);

create table private.asistonto_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default clock_timestamp(),
  sede_id uuid not null,
  actor text not null check (actor in ('asistonto', 'rio')),
  operation text not null check (operation in ('draft', 'approve', 'commit', 'discard')),
  draft_id uuid,
  kind text,
  approval_ref text,
  -- Identifiers only (draft/card/student/session ids, codes). Never names or contact data.
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);

create function private.asistonto_audit_insert_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'private.asistonto_audit is insert-only' using errcode = '42501';
end $$;
create trigger asistonto_audit_no_update before update or delete on private.asistonto_audit
  for each row execute function private.asistonto_audit_insert_only();
create trigger asistonto_audit_no_truncate before truncate on private.asistonto_audit
  for each statement execute function private.asistonto_audit_insert_only();

-- 2) Integration actor for session RPCs that require an attributable auth.uid() --------
-- Provisioned manually by the database owner (see docs/asistonto-api.md): a dedicated
-- Auth user that owns no sede, belongs to no sede and is not super_admin.
create table private.asistonto_integration_actor (
  sede_id uuid primary key references public.sedes(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete restrict,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);
-- Transaction-scoped marker written only by asistonto commit (never by any role).
create table private.asistonto_actor_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  sede_id uuid not null,
  user_id uuid not null,
  primary key (backend_pid, transaction_id)
);

alter table private.asistonto_drafts enable row level security;
alter table private.asistonto_audit enable row level security;
alter table private.asistonto_integration_actor enable row level security;
alter table private.asistonto_actor_context enable row level security;
revoke all on private.asistonto_drafts, private.asistonto_audit, private.asistonto_integration_actor,
  private.asistonto_actor_context from public, anon, authenticated, service_role;

create function private.asistonto_actor_active(p_sede_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from private.asistonto_actor_context c
    join private.asistonto_integration_actor a on a.sede_id = c.sede_id and a.user_id = c.user_id and a.enabled
    where c.backend_pid = pg_backend_pid() and c.transaction_id = txid_current()
      and c.sede_id = p_sede_id and c.user_id = auth.uid());
$$;

-- Same body as 20261011230000 plus the transaction-scoped integration path.
create or replace function private.session_employee_sede(p_sede_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.session_business_read_sede(p_sede_id)
    and exists (select 1 from public.sedes t where t.id = p_sede_id and t.is_active is true
      and (t.owner_id = auth.uid() or exists (select 1 from public.sede_members m
        where m.sede_id = t.id and m.user_id = auth.uid() and m.role in ('tallerista', 'staff', 'super_admin')))))
    or private.asistonto_actor_active(p_sede_id);
$$;

-- Same body as 20261011220000 plus the same transaction-scoped integration path
-- (used by cancel_session_reservation). can_access_sede itself is NOT changed, so
-- row-level security for application users is untouched.
create or replace function private.lock_atomic_session(p_session_id uuid) returns public.sessions
language plpgsql security definer set search_path = '' as $$
declare s public.sessions;
begin
  select * into s from public.sessions where id = p_session_id for update;
  if not found or auth.uid() is null
    or not (private.can_access_sede(s.sede_id) or private.asistonto_actor_active(s.sede_id))
    or not exists (select 1 from public.sedes where id = s.sede_id and is_active is true) then
    raise exception 'Session not accessible' using errcode = '42501';
  end if;
  return s;
end $$;

-- 3) Helpers ----------------------------------------------------------------------
create function private.asistonto_text(p jsonb, k text, max_len integer, required boolean default false)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if p ? k and jsonb_typeof(p->k) not in ('string', 'null') then
    raise exception '% must be a string', k using errcode = 'AS400';
  end if;
  v := nullif(btrim(coalesce(p->>k, '')), '');
  if v is null and required then raise exception '% is required', k using errcode = 'AS400'; end if;
  if v is not null and length(v) > max_len then raise exception '% is too long', k using errcode = 'AS400'; end if;
  return v;
end $$;

create function private.asistonto_uuid(p jsonb, k text, required boolean default true)
returns uuid language plpgsql immutable set search_path = '' as $$
declare v text := private.asistonto_text(p, k, 36, required);
begin
  if v is null then return null; end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception '% must be a UUID', k using errcode = 'AS400';
  end if;
  return v::uuid;
end $$;

create function private.asistonto_only_keys(p jsonb, allowed text[]) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'payload must be an object' using errcode = 'AS400'; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all(allowed)) then
    raise exception 'Unsupported field: %', (select min(k) from jsonb_object_keys(p) k where k <> all(allowed)) using errcode = 'AS400';
  end if;
end $$;

create function private.asistonto_session_label(s public.sessions) returns text
language sql stable set search_path = '' as $$
  select coalesce(s.class_type, 'sesión') || ' ' || to_char(s.start_time at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI');
$$;

-- 4) Reads (PII-minimal, one sede) -------------------------------------------------
create function private.asistonto_bono_json(g public.gift_cards) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'code', g.code, 'recipient', g.recipient,
    'recipientStudentId', g.recipient_student_id, 'numClasses', g.num_classes,
    'sessionsUsed', coalesce(g.sessions_used, 0),
    'sessionsRemaining', greatest(0, coalesce(g.num_classes, 0) - coalesce(g.sessions_used, 0)),
    'type', g.type, 'status', g.status, 'paymentStatus', g.payment_status,
    'validityMonths', g.validity_months, 'activatedAt', g.activated_at, 'expiryDate', g.expiry_date,
    'deliveryFormat', g.delivery_format, 'createdAt', g.created_at);
$$;

create function private.asistonto_read_bonos(p_sede_id uuid, p_params jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := upper(private.asistonto_text(p_params, 'code', 40));
  v_status text := private.asistonto_text(p_params, 'status', 20);
  v_limit integer := 50;
  v_rows jsonb;
begin
  perform private.asistonto_only_keys(p_params, array['code', 'status', 'limit']);
  if p_params ? 'limit' then
    if (p_params->>'limit') !~ '^[0-9]{1,3}$' then raise exception 'limit must be 1-100' using errcode = 'AS400'; end if;
    v_limit := (p_params->>'limit')::integer;
    if v_limit not between 1 and 100 then raise exception 'limit must be 1-100' using errcode = 'AS400'; end if;
  end if;
  if v_status is not null and v_status not in ('pending', 'active', 'exhausted', 'consumed', 'expired', 'cancelled') then
    raise exception 'Unknown status' using errcode = 'AS400';
  end if;
  select coalesce(jsonb_agg(private.asistonto_bono_json(g) order by g.created_at desc), '[]'::jsonb) into v_rows
  from (select * from public.gift_cards g
        where g.sede_id = p_sede_id
          and (v_code is null or g.code = v_code)
          and (case when v_status is null then g.status is distinct from 'cancelled' else g.status = v_status end)
        order by g.created_at desc limit v_limit) g;
  if v_code is not null and jsonb_array_length(v_rows) = 0 then raise exception 'Bono not found' using errcode = 'AS404'; end if;
  return jsonb_build_object('data', case when v_code is not null then v_rows->0 else v_rows end, 'count', jsonb_array_length(v_rows));
end $$;

create function private.asistonto_read_calendario(p_sede_id uuid, p_params jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date; v_to date; v_rows jsonb;
begin
  perform private.asistonto_only_keys(p_params, array['from', 'to']);
  begin
    v_from := private.asistonto_text(p_params, 'from', 10, true)::date;
    v_to := coalesce(private.asistonto_text(p_params, 'to', 10)::date, v_from);
  exception when others then
    if sqlstate = 'AS400' then raise; end if;
    raise exception 'from/to must be YYYY-MM-DD' using errcode = 'AS400';
  end;
  if v_to < v_from or v_to - v_from > 31 then raise exception 'Range must be 0-31 days' using errcode = 'AS400'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'date', to_char(s.start_time at time zone 'Europe/Madrid', 'YYYY-MM-DD'),
      'start', to_char(s.start_time at time zone 'Europe/Madrid', 'HH24:MI'),
      'end', to_char(s.end_time at time zone 'Europe/Madrid', 'HH24:MI'),
      'classType', s.class_type, 'audience', s.session_audience, 'workshopName', s.workshop_name,
      'capacity', s.capacity,
      'reserved', (select count(*) from public.session_students e where e.session_id = s.id and e.cancelled_at is null),
      'available', greatest(0, s.capacity - (select count(*) from public.session_students e where e.session_id = s.id and e.cancelled_at is null)),
      'teacher', (select nullif(btrim(concat_ws(' ', t.name, t.surname)), '') from public.teachers t where t.id = s.teacher_id),
      'completed', s.completed_at is not null,
      'blocks', (select coalesce(jsonb_agg(jsonb_build_object('activityType', b.activity_type, 'capacity', b.capacity,
          'reserved', (select count(*) from public.session_activity_block_students r join public.session_students e
             on e.session_id = r.session_id and e.student_id = r.student_id where r.block_id = b.id and e.cancelled_at is null))
          order by b.activity_type), '[]'::jsonb) from public.session_activity_blocks b where b.session_id = s.id)
    ) order by s.start_time), '[]'::jsonb) into v_rows
  from public.sessions s
  where s.sede_id = p_sede_id
    and s.start_time >= (v_from::timestamp at time zone 'Europe/Madrid')
    and s.start_time < ((v_to + 1)::timestamp at time zone 'Europe/Madrid');
  return jsonb_build_object('data', v_rows, 'count', jsonb_array_length(v_rows), 'from', v_from, 'to', v_to);
end $$;

create function private.asistonto_read_clases(p_sede_id uuid, p_params jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.asistonto_only_keys(p_params, array[]::text[]);
  return jsonb_build_object('data', jsonb_build_object(
    'activityTypes', jsonb_build_array('mesa', 'torno', 'coworking', 'workshop', 'privada'),
    'weeklySchedule', (select coalesce(jsonb_agg(jsonb_build_object('dayOfWeek', w.day_of_week, 'slot', w.slot_index,
        'isOpen', w.is_open, 'opensAt', to_char(w.opens_at, 'HH24:MI'), 'closesAt', to_char(w.closes_at, 'HH24:MI'))
        order by w.day_of_week, w.slot_index), '[]'::jsonb) from public.workshop_schedules w where w.sede_id = p_sede_id),
    'exceptions', (select coalesce(jsonb_agg(jsonb_build_object('date', x.exception_date, 'slot', x.slot_index,
        'isOpen', x.is_open, 'opensAt', to_char(x.opens_at, 'HH24:MI'), 'closesAt', to_char(x.closes_at, 'HH24:MI'))
        order by x.exception_date, x.slot_index), '[]'::jsonb) from public.workshop_schedule_exceptions x
        where x.sede_id = p_sede_id and x.exception_date between (now() at time zone 'Europe/Madrid')::date
          and (now() at time zone 'Europe/Madrid')::date + 90),
    'capacityDefaults', (select coalesce(jsonb_object_agg(c.class_type, c.capacity), '{}'::jsonb)
        from public.workshop_capacity_defaults c where c.sede_id = p_sede_id)));
end $$;

create function private.asistonto_student_json(st public.students) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', st.id, 'name', coalesce(nullif(btrim(st.full_name), ''), concat_ws(' ', st.name, st.surname)),
    'category', coalesce(st.student_category, 'membresia'), 'status', st.status, 'archived', st.archived_at is not null,
    'membershipTier', st.membership_tier, 'paymentStatus', st.payment_status, 'classesRemaining', st.classes_remaining);
$$;

create function private.asistonto_read_alumnos(p_sede_id uuid, p_params jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := private.asistonto_text(p_params, 'q', 80, true);
  v_pattern text; v_rows jsonb;
begin
  perform private.asistonto_only_keys(p_params, array['q']);
  if length(v_q) < 3 then raise exception 'q needs at least 3 characters' using errcode = 'AS400'; end if;
  v_pattern := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select coalesce(jsonb_agg(private.asistonto_student_json(st) order by st.full_name, st.id), '[]'::jsonb) into v_rows
  from (select * from public.students st where st.sede_id = p_sede_id
        and (lower(coalesce(st.full_name, '')) like v_pattern
          or lower(concat_ws(' ', st.name, st.surname)) like v_pattern)
        order by st.full_name, st.id limit 20) st;
  return jsonb_build_object('data', v_rows, 'count', jsonb_array_length(v_rows));
end $$;

create function private.asistonto_read_alumno(p_sede_id uuid, p_params jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid := private.asistonto_uuid(p_params, 'id');
  st public.students;
begin
  perform private.asistonto_only_keys(p_params, array['id']);
  select * into st from public.students where id = v_id and sede_id = p_sede_id;
  if not found then raise exception 'Student not found' using errcode = 'AS404'; end if;
  return jsonb_build_object('data', private.asistonto_student_json(st) || jsonb_build_object(
    'upcomingSessions', (select coalesce(jsonb_agg(x.j order by x.t), '[]'::jsonb) from (
        select s.start_time t, jsonb_build_object('sessionId', s.id,
          'date', to_char(s.start_time at time zone 'Europe/Madrid', 'YYYY-MM-DD'),
          'start', to_char(s.start_time at time zone 'Europe/Madrid', 'HH24:MI'), 'classType', s.class_type) j
        from public.session_students e join public.sessions s on s.id = e.session_id
        where e.student_id = st.id and s.sede_id = p_sede_id and e.cancelled_at is null and s.end_time >= now()
        order by s.start_time limit 10) x),
    'bonos', (select coalesce(jsonb_agg(jsonb_build_object('code', g.code, 'status', g.status,
        'sessionsRemaining', greatest(0, coalesce(g.num_classes, 0) - coalesce(g.sessions_used, 0)), 'expiryDate', g.expiry_date)
        order by g.created_at desc), '[]'::jsonb)
      from public.gift_cards g where g.recipient_student_id = st.id and g.sede_id = p_sede_id and g.status in ('pending', 'active'))));
end $$;

create function public.asistonto_read(p_sede_id uuid, p_op text, p_params jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_params jsonb := coalesce(p_params, '{}'::jsonb);
begin
  if jsonb_typeof(v_params) <> 'object' or octet_length(v_params::text) > 2048 then
    raise exception 'Invalid params' using errcode = 'AS400';
  end if;
  if p_sede_id is null or not exists (select 1 from public.sedes where id = p_sede_id and is_active) then
    raise exception 'Sede not available' using errcode = 'AS403';
  end if;
  return case p_op
    when 'bonos' then private.asistonto_read_bonos(p_sede_id, v_params)
    when 'calendario' then private.asistonto_read_calendario(p_sede_id, v_params)
    when 'clases' then private.asistonto_read_clases(p_sede_id, v_params)
    when 'alumnos' then private.asistonto_read_alumnos(p_sede_id, v_params)
    when 'alumno' then private.asistonto_read_alumno(p_sede_id, v_params)
    else private.asistonto_raise_unknown_op(p_op) end;
end $$;

create function private.asistonto_raise_unknown_op(p_op text) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  raise exception 'Unknown op' using errcode = 'AS400';
end $$;

-- 5) Writes ----------------------------------------------------------------------
create function private.asistonto_create_student(p_sede_id uuid, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.asistonto_text(p_payload, 'name', 120, true);
  v_surname text := private.asistonto_text(p_payload, 'surname', 120);
  v_email text := lower(private.asistonto_text(p_payload, 'email', 200));
  v_phone text := private.asistonto_text(p_payload, 'phone', 40);
  v_id uuid;
begin
  perform private.asistonto_only_keys(p_payload, array['name', 'surname', 'email', 'phone']);
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email is not valid' using errcode = 'AS400';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ]{6,20}$' then raise exception 'phone is not valid' using errcode = 'AS400'; end if;
  if not exists (select 1 from public.sedes where id = p_sede_id and is_active) then
    raise exception 'Sede not available' using errcode = 'AS403';
  end if;
  -- v1 creates temporary students only (memberships carry pricing/payment and stay in the app).
  insert into public.students (sede_id, full_name, name, surname, email, phone, student_category,
    bonos_asignados, classes_remaining, status)
  values (p_sede_id, btrim(concat_ws(' ', v_name, v_surname)), v_name, v_surname, v_email, v_phone, 'temporal', 0, 0, 'active')
  returning id into v_id;
  return v_id;
end $$;

-- Validates a payload without writing; returns the normalized payload and summary.
create function private.asistonto_prepare(p_sede_id uuid, p_kind text, p_payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  s public.sessions; st public.students; e public.session_students; g public.gift_cards;
  v_num integer; v_validity integer; v_type text; v_code text; v_reserved integer; v_pay text; v_fmt text; v_price numeric;
  v_recipient text; v_activated date;
begin
  if p_kind = 'bono.create' then
    perform private.asistonto_only_keys(p, array['recipient', 'numClasses', 'type', 'validityMonths', 'paymentStatus',
      'price', 'deliveryFormat', 'code', 'buyer', 'buyerEmail', 'recipientEmail', 'dedication', 'activatedAt']);
    v_recipient := private.asistonto_text(p, 'recipient', 120, true);
    if coalesce(p->>'numClasses', '') !~ '^[1-9][0-9]?$' then raise exception 'numClasses must be 1-20' using errcode = 'AS400'; end if;
    v_num := (p->>'numClasses')::integer;
    if v_num > 20 then raise exception 'numClasses must be 1-20' using errcode = 'AS400'; end if;
    v_type := coalesce(private.asistonto_text(p, 'type', 20), 'modelado');
    if v_type not in ('modelado', 'torno') then raise exception 'type must be modelado or torno' using errcode = 'AS400'; end if;
    v_validity := coalesce(nullif(p->>'validityMonths', '')::integer, 12);
    if v_validity not in (3, 6, 8, 12) then raise exception 'validityMonths must be 3, 6, 8 or 12' using errcode = 'AS400'; end if;
    v_pay := coalesce(private.asistonto_text(p, 'paymentStatus', 10), 'pending');
    if v_pay not in ('pending', 'paid') then raise exception 'paymentStatus must be pending or paid' using errcode = 'AS400'; end if;
    v_fmt := coalesce(private.asistonto_text(p, 'deliveryFormat', 10), 'digital');
    if v_fmt not in ('digital', 'physical') then raise exception 'deliveryFormat must be digital or physical' using errcode = 'AS400'; end if;
    if p ? 'price' and p->>'price' is not null then
      if (p->>'price') !~ '^[0-9]{1,5}(\.[0-9]{1,2})?$' then raise exception 'price must be a non-negative amount' using errcode = 'AS400'; end if;
      v_price := (p->>'price')::numeric;
    end if;
    v_code := upper(private.asistonto_text(p, 'code', 40));
    if v_code is not null then
      if v_code !~ '^[A-Z0-9][A-Z0-9-]{3,39}$' then raise exception 'code format is not valid' using errcode = 'AS400'; end if;
      if exists (select 1 from public.gift_cards where code = v_code) then raise exception 'Bono code already exists' using errcode = 'AS409'; end if;
    end if;
    begin
      v_activated := private.asistonto_text(p, 'activatedAt', 10)::date;
    exception when others then
      if sqlstate = 'AS400' then raise; end if;
      raise exception 'activatedAt must be YYYY-MM-DD' using errcode = 'AS400';
    end;
    if private.asistonto_text(p, 'buyerEmail', 200) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      or private.asistonto_text(p, 'recipientEmail', 200) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'email is not valid' using errcode = 'AS400';
    end if;
    perform private.asistonto_text(p, 'buyer', 120); perform private.asistonto_text(p, 'dedication', 500);
    return jsonb_build_object('payload', jsonb_strip_nulls(jsonb_build_object('recipient', v_recipient, 'numClasses', v_num,
        'type', v_type, 'validityMonths', v_validity, 'paymentStatus', v_pay, 'deliveryFormat', v_fmt, 'price', v_price,
        'code', v_code, 'buyer', private.asistonto_text(p, 'buyer', 120),
        'buyerEmail', lower(private.asistonto_text(p, 'buyerEmail', 200)),
        'recipientEmail', lower(private.asistonto_text(p, 'recipientEmail', 200)),
        'dedication', private.asistonto_text(p, 'dedication', 500), 'activatedAt', v_activated)),
      'summary', format('Crear bono %s de %s clase(s) para «%s», validez %s meses, pago %s, formato %s%s.',
        v_type, v_num, v_recipient, v_validity, v_pay, v_fmt, coalesce(', código ' || v_code, '')));
  elsif p_kind = 'student.create' then
    perform private.asistonto_only_keys(p, array['name', 'surname', 'email', 'phone']);
    perform private.asistonto_text(p, 'name', 120, true);
    if private.asistonto_text(p, 'email', 200) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'email is not valid' using errcode = 'AS400';
    end if;
    if private.asistonto_text(p, 'phone', 40) !~ '^\+?[0-9 ]{6,20}$' then raise exception 'phone is not valid' using errcode = 'AS400'; end if;
    return jsonb_build_object('payload', jsonb_strip_nulls(jsonb_build_object('name', private.asistonto_text(p, 'name', 120),
        'surname', private.asistonto_text(p, 'surname', 120), 'email', lower(private.asistonto_text(p, 'email', 200)),
        'phone', private.asistonto_text(p, 'phone', 40))),
      'summary', format('Crear alumno temporal «%s».', btrim(concat_ws(' ', private.asistonto_text(p, 'name', 120), private.asistonto_text(p, 'surname', 120)))));
  elsif p_kind in ('session.book', 'session.cancel') then
    perform private.asistonto_only_keys(p, case when p_kind = 'session.book'
      then array['sessionId', 'studentId', 'giftCardCode'] else array['sessionId', 'studentId', 'reason'] end);
    select * into s from public.sessions where id = private.asistonto_uuid(p, 'sessionId') and sede_id = p_sede_id;
    if not found then raise exception 'Session not found' using errcode = 'AS404'; end if;
    select * into st from public.students where id = private.asistonto_uuid(p, 'studentId') and sede_id = p_sede_id;
    if not found then raise exception 'Student not found' using errcode = 'AS404'; end if;
    if s.completed_at is not null then raise exception 'Session is already finalized' using errcode = 'AS409'; end if;
    if s.class_type = 'mixto' then raise exception 'Mixed sessions must be edited in the app' using errcode = 'AS409'; end if;
    select * into e from public.session_students where session_id = s.id and student_id = st.id;
    if p_kind = 'session.book' then
      if e.id is not null then raise exception 'Student already has an enrollment in this session' using errcode = 'AS409'; end if;
      select count(*) into v_reserved from public.session_students where session_id = s.id and cancelled_at is null;
      if v_reserved >= s.capacity then raise exception 'Session is full' using errcode = 'AS409'; end if;
      v_code := upper(private.asistonto_text(p, 'giftCardCode', 40));
      if v_code is not null then
        select * into g from public.gift_cards where code = v_code and sede_id = p_sede_id and recipient_student_id = st.id
          and status in ('pending', 'active');
        if not found then raise exception 'Bono not usable for this student' using errcode = 'AS409'; end if;
      end if;
      return jsonb_build_object('payload', jsonb_strip_nulls(jsonb_build_object('sessionId', s.id, 'studentId', st.id, 'giftCardCode', v_code)),
        'summary', format('Reservar a «%s» en %s (plazas ocupadas %s/%s)%s.', st.full_name, private.asistonto_session_label(s),
          v_reserved, s.capacity, coalesce(', con bono ' || v_code, '')));
    else
      if e.id is null or e.cancelled_at is not null then raise exception 'No active reservation to cancel' using errcode = 'AS409'; end if;
      if s.attendance_policy_version <> 2 then raise exception 'Legacy sessions must be edited in the app' using errcode = 'AS409'; end if;
      return jsonb_build_object('payload', jsonb_strip_nulls(jsonb_build_object('sessionId', s.id, 'studentId', st.id,
          'reason', private.asistonto_text(p, 'reason', 300))),
        'summary', format('Anular la reserva de «%s» en %s.', st.full_name, private.asistonto_session_label(s)));
    end if;
  end if;
  raise exception 'Unknown kind' using errcode = 'AS400';
end $$;

create function private.asistonto_with_actor(p_sede_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  select a.user_id into v_actor from private.asistonto_integration_actor a where a.sede_id = p_sede_id and a.enabled;
  if v_actor is null then raise exception 'Integration actor not provisioned for this sede' using errcode = 'AS409'; end if;
  -- The actor must never be an application user with broad access.
  if exists (select 1 from public.profiles where id = v_actor and role = 'super_admin')
    or exists (select 1 from public.sedes where owner_id = v_actor)
    or exists (select 1 from public.sede_members where user_id = v_actor) then
    raise exception 'Integration actor must not be an application user' using errcode = 'AS403';
  end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  insert into private.asistonto_actor_context (backend_pid, transaction_id, sede_id, user_id)
    values (pg_backend_pid(), txid_current(), p_sede_id, v_actor);
  return v_actor;
end $$;

create function private.asistonto_end_actor(p_previous_sub text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.asistonto_actor_context where backend_pid = pg_backend_pid() and transaction_id = txid_current();
  perform set_config('request.jwt.claim.sub', coalesce(p_previous_sub, ''), true);
end $$;

create function private.asistonto_execute(d private.asistonto_drafts) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := d.payload;
  v_card public.gift_cards; v_student uuid; s public.sessions; v_prev text; v_res jsonb;
  v_roster uuid[]; v_gifts jsonb; v_manual jsonb; v_gift uuid;
begin
  if d.kind = 'bono.create' then
    v_card := public.external_create_gift_card_with_temporal_student(d.sede_id,
      jsonb_strip_nulls(jsonb_build_object('code', p->>'code', 'recipient', p->>'recipient', 'buyer', p->>'buyer',
        'buyer_email', p->>'buyerEmail', 'recipient_email', p->>'recipientEmail', 'dedication', p->>'dedication',
        'validity_months', p->'validityMonths', 'activated_at', p->>'activatedAt', 'price', p->'price',
        'delivery_format', p->>'deliveryFormat', 'num_classes', p->'numClasses', 'type', p->>'type',
        'payment_status', p->>'paymentStatus', 'external_reference', 'asistonto:' || d.id::text,
        'external_metadata', jsonb_build_object('source', 'asistonto', 'draft_id', d.id, 'approval_ref', d.approval_ref))),
      jsonb_build_object('full_name', p->>'recipient'));
    return jsonb_build_object('bono', private.asistonto_bono_json(v_card));
  elsif d.kind = 'student.create' then
    v_student := private.asistonto_create_student(d.sede_id, p);
    return jsonb_build_object('studentId', v_student);
  end if;

  -- Session writes: reuse the existing atomic RPCs under the integration actor.
  v_prev := current_setting('request.jwt.claim.sub', true);
  perform private.asistonto_with_actor(d.sede_id);
  select * into s from public.sessions where id = (p->>'sessionId')::uuid and sede_id = d.sede_id;
  if not found then raise exception 'Session not found' using errcode = 'AS404'; end if;
  if d.kind = 'session.book' then
    if s.class_type = 'mixto' then raise exception 'Mixed sessions must be edited in the app' using errcode = 'AS409'; end if;
    select coalesce(array_agg(student_id order by student_id), '{}'::uuid[]),
           coalesce(jsonb_object_agg(student_id::text, gift_card_id) filter (where gift_card_id is not null), '{}'::jsonb),
           coalesce(jsonb_object_agg(student_id::text, manual_credit_id) filter (where manual_credit_id is not null), '{}'::jsonb)
      into v_roster, v_gifts, v_manual
      from public.session_students where session_id = s.id;
    if p ? 'giftCardCode' then
      select id into v_gift from public.gift_cards where code = p->>'giftCardCode' and sede_id = d.sede_id
        and recipient_student_id = (p->>'studentId')::uuid;
      if v_gift is null then raise exception 'Bono not usable for this student' using errcode = 'AS409'; end if;
      v_gifts := v_gifts || jsonb_build_object(p->>'studentId', v_gift);
    end if;
    v_res := private.save_session_reservation(s.id, d.id, s.revision, d.sede_id, '{}'::jsonb,
      v_roster || (p->>'studentId')::uuid, v_gifts, v_manual, '[]'::jsonb);
  else
    v_res := private.session_business_action(s.id, (p->>'studentId')::uuid, d.id, s.revision, 'cancel_session_reservation', null,
      left(coalesce(p->>'reason', 'Anulada por asistonto') || ' (OK: ' || d.approval_ref || ')', 2000));
  end if;
  perform private.asistonto_end_actor(v_prev);
  return jsonb_build_object('sessionId', s.id, 'studentId', (p->>'studentId')::uuid, 'revision', v_res->'revision',
    'reserved', (select count(*) from public.session_students where session_id = s.id and cancelled_at is null),
    'capacity', (select capacity from public.sessions where id = s.id));
end $$;

create function private.asistonto_draft_json(d private.asistonto_drafts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('draftId', d.id, 'kind', d.kind, 'status', d.status, 'summary', d.summary,
    'expiresAt', d.expires_at, 'approvalRef', d.approval_ref, 'approvedAt', d.approved_at,
    'committedAt', d.committed_at, 'result', d.result);
$$;

create function public.asistonto_write(p_sede_id uuid, p_actor text, p_op text, p_params jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_prepared jsonb; d private.asistonto_drafts; v_ref text; v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if jsonb_typeof(v_params) <> 'object' or octet_length(v_params::text) > 8192 then
    raise exception 'Invalid params' using errcode = 'AS400';
  end if;
  if p_actor is null or p_actor not in ('asistonto', 'rio') then raise exception 'Unknown actor' using errcode = 'AS403'; end if;
  if p_sede_id is null or not exists (select 1 from public.sedes where id = p_sede_id and is_active) then
    raise exception 'Sede not available' using errcode = 'AS403';
  end if;

  if p_op = 'draft' then
    if p_actor <> 'asistonto' then raise exception 'Only asistonto creates drafts' using errcode = 'AS403'; end if;
    perform private.asistonto_only_keys(v_params, array['kind', 'payload']);
    v_prepared := private.asistonto_prepare(p_sede_id, v_params->>'kind', v_params->'payload');
    insert into private.asistonto_drafts (sede_id, kind, payload, summary, created_by, created_at, expires_at)
      values (p_sede_id, v_params->>'kind', v_prepared->'payload', v_prepared->>'summary', 'asistonto',
        v_now, v_now + interval '24 hours')
      returning * into d;
    insert into private.asistonto_audit (sede_id, actor, operation, draft_id, kind)
      values (p_sede_id, p_actor, 'draft', d.id, d.kind);
    return jsonb_build_object('data', private.asistonto_draft_json(d));
  elsif p_op = 'list' then
    perform private.asistonto_only_keys(v_params, array['status']);
    return jsonb_build_object('data', (select coalesce(jsonb_agg(private.asistonto_draft_json(x) order by x.created_at desc), '[]'::jsonb)
      from (select * from private.asistonto_drafts x where x.sede_id = p_sede_id
        and x.status = coalesce(v_params->>'status', 'pending') order by x.created_at desc limit 50) x));
  elsif p_op not in ('approve', 'commit', 'discard') then
    raise exception 'Unknown op' using errcode = 'AS400';
  end if;

  perform private.asistonto_only_keys(v_params, array['draftId', 'approvalRef']);
  select * into d from private.asistonto_drafts where id = private.asistonto_uuid(v_params, 'draftId') and sede_id = p_sede_id for update;
  if not found then raise exception 'Draft not found' using errcode = 'AS404'; end if;

  if p_op = 'approve' then
    if p_actor <> 'rio' then raise exception 'Only RIO approves drafts' using errcode = 'AS403'; end if;
    v_ref := private.asistonto_text(v_params, 'approvalRef', 200, true);
    if d.status = 'approved' and d.approval_ref = v_ref then return jsonb_build_object('data', private.asistonto_draft_json(d), 'replayed', true); end if;
    if d.status <> 'pending' then raise exception 'Draft is %', d.status using errcode = 'AS409'; end if;
    if d.expires_at <= clock_timestamp() then raise exception 'Draft expired' using errcode = 'AS410'; end if;
    update private.asistonto_drafts set status = 'approved', approved_by = 'rio', approval_ref = v_ref, approved_at = clock_timestamp()
      where id = d.id returning * into d;
    insert into private.asistonto_audit (sede_id, actor, operation, draft_id, kind, approval_ref)
      values (p_sede_id, p_actor, 'approve', d.id, d.kind, v_ref);
  elsif p_op = 'discard' then
    if d.status in ('committed', 'discarded') then raise exception 'Draft is %', d.status using errcode = 'AS409'; end if;
    update private.asistonto_drafts set status = 'discarded' where id = d.id returning * into d;
    insert into private.asistonto_audit (sede_id, actor, operation, draft_id, kind)
      values (p_sede_id, p_actor, 'discard', d.id, d.kind);
  else -- commit
    if d.status = 'committed' then
      return jsonb_build_object('data', private.asistonto_draft_json(d), 'replayed', true);
    end if;
    if d.status <> 'approved' then raise exception 'Draft is not approved' using errcode = 'AS403'; end if;
    if d.expires_at <= clock_timestamp() then raise exception 'Draft expired' using errcode = 'AS410'; end if;
    v_result := private.asistonto_execute(d);
    update private.asistonto_drafts set status = 'committed', committed_by = p_actor, committed_at = clock_timestamp(), result = v_result
      where id = d.id returning * into d;
    insert into private.asistonto_audit (sede_id, actor, operation, draft_id, kind, approval_ref, detail)
      values (p_sede_id, p_actor, 'commit', d.id, d.kind, d.approval_ref, jsonb_strip_nulls(jsonb_build_object(
        'giftCardId', v_result#>>'{bono,id}', 'code', v_result#>>'{bono,code}', 'studentId', v_result->>'studentId',
        'sessionId', v_result->>'sessionId')));
  end if;
  return jsonb_build_object('data', private.asistonto_draft_json(d), 'replayed', false);
end $$;

-- 6) Grants: nothing for anon/authenticated; entry points for service_role only ----
revoke all on function
  private.asistonto_audit_insert_only(), private.asistonto_actor_active(uuid),
  private.asistonto_text(jsonb, text, integer, boolean), private.asistonto_uuid(jsonb, text, boolean),
  private.asistonto_only_keys(jsonb, text[]), private.asistonto_session_label(public.sessions),
  private.asistonto_bono_json(public.gift_cards), private.asistonto_student_json(public.students),
  private.asistonto_read_bonos(uuid, jsonb), private.asistonto_read_calendario(uuid, jsonb),
  private.asistonto_read_clases(uuid, jsonb), private.asistonto_read_alumnos(uuid, jsonb),
  private.asistonto_read_alumno(uuid, jsonb), private.asistonto_raise_unknown_op(text),
  private.asistonto_create_student(uuid, jsonb), private.asistonto_prepare(uuid, text, jsonb),
  private.asistonto_with_actor(uuid), private.asistonto_end_actor(text),
  private.asistonto_execute(private.asistonto_drafts), private.asistonto_draft_json(private.asistonto_drafts),
  public.asistonto_read(uuid, text, jsonb), public.asistonto_write(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  private.asistonto_read_bonos(uuid, jsonb), private.asistonto_read_calendario(uuid, jsonb),
  private.asistonto_read_clases(uuid, jsonb), private.asistonto_read_alumnos(uuid, jsonb),
  private.asistonto_read_alumno(uuid, jsonb), private.asistonto_create_student(uuid, jsonb),
  public.asistonto_read(uuid, text, jsonb), public.asistonto_write(uuid, text, text, jsonb)
  to service_role;
-- session_employee_sede keeps its original grants (create or replace preserves the ACL);
-- it is security definer, so the helper it calls needs no grant of its own.

notify pgrst, 'reload schema';
commit;
