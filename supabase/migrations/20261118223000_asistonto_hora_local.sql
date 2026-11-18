-- pottery-gym guarda la hora de las sesiones como "hora de pared" con sufijo UTC
-- (buildSessionPayload envía `${date}T${HH:MM}:00` y la app la muestra con extractTime sin convertir).
-- La API de asistonto convertía a Europe/Madrid y mostraba una hora de más (dos en verano).
-- Solo cambian funciones de lectura/etiqueta; no se toca ningún dato.
create or replace function private.asistonto_session_label(s public.sessions) returns text
language sql stable set search_path = '' as $$
  select coalesce(s.class_type, 'sesión') || ' ' || to_char(s.start_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI');
$$;

create or replace function private.asistonto_read_calendario(p_sede_id uuid, p_params jsonb) returns jsonb
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
      'date', to_char(s.start_time at time zone 'UTC', 'YYYY-MM-DD'),
      'start', to_char(s.start_time at time zone 'UTC', 'HH24:MI'),
      'end', to_char(s.end_time at time zone 'UTC', 'HH24:MI'),
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
    and s.start_time >= (v_from::timestamp at time zone 'UTC')
    and s.start_time < ((v_to + 1)::timestamp at time zone 'UTC');
  return jsonb_build_object('data', v_rows, 'count', jsonb_array_length(v_rows), 'from', v_from, 'to', v_to);
end $$;

create or replace function private.asistonto_read_alumno(p_sede_id uuid, p_params jsonb) returns jsonb
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
          'date', to_char(s.start_time at time zone 'UTC', 'YYYY-MM-DD'),
          'start', to_char(s.start_time at time zone 'UTC', 'HH24:MI'), 'classType', s.class_type) j
        from public.session_students e join public.sessions s on s.id = e.session_id
        where e.student_id = st.id and s.sede_id = p_sede_id and e.cancelled_at is null and s.end_time >= ((now() at time zone 'Europe/Madrid') at time zone 'UTC')
        order by s.start_time limit 10) x),
    'bonos', (select coalesce(jsonb_agg(jsonb_build_object('code', g.code, 'status', g.status,
        'sessionsRemaining', greatest(0, coalesce(g.num_classes, 0) - coalesce(g.sessions_used, 0)), 'expiryDate', g.expiry_date)
        order by g.created_at desc), '[]'::jsonb)
      from public.gift_cards g where g.recipient_student_id = st.id and g.sede_id = p_sede_id and g.status in ('pending', 'active'))));
end $$;
