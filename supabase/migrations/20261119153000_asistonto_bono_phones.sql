-- W1 bono.create: accept buyerPhone and recipientPhone (same validation as student.create).
-- buyerPhone maps to gift_cards.buyer_phone; recipientPhone maps to the new temporal student's phone.
begin;

create or replace function private.asistonto_prepare(p_sede_id uuid, p_kind text, p_payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  s public.sessions; st public.students; e public.session_students; g public.gift_cards;
  v_num integer; v_validity integer; v_type text; v_code text; v_reserved integer; v_pay text; v_fmt text; v_price numeric;
  v_recipient text; v_activated date;
begin
  if p_kind = 'bono.create' then
    perform private.asistonto_only_keys(p, array['recipient', 'numClasses', 'type', 'validityMonths', 'paymentStatus',
      'price', 'deliveryFormat', 'code', 'buyer', 'buyerEmail', 'buyerPhone', 'recipientEmail', 'recipientPhone', 'dedication', 'activatedAt']);
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
    if private.asistonto_text(p, 'buyerPhone', 40) !~ '^\+?[0-9 ]{6,20}$'
      or private.asistonto_text(p, 'recipientPhone', 40) !~ '^\+?[0-9 ]{6,20}$' then
      raise exception 'phone is not valid' using errcode = 'AS400';
    end if;
    return jsonb_build_object('payload', jsonb_strip_nulls(jsonb_build_object('recipient', v_recipient, 'numClasses', v_num,
        'type', v_type, 'validityMonths', v_validity, 'paymentStatus', v_pay, 'deliveryFormat', v_fmt, 'price', v_price,
        'code', v_code, 'buyer', private.asistonto_text(p, 'buyer', 120),
        'buyerEmail', lower(private.asistonto_text(p, 'buyerEmail', 200)),
        'buyerPhone', private.asistonto_text(p, 'buyerPhone', 40),
        'recipientEmail', lower(private.asistonto_text(p, 'recipientEmail', 200)),
        'recipientPhone', private.asistonto_text(p, 'recipientPhone', 40),
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

create or replace function private.asistonto_execute(d private.asistonto_drafts) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := d.payload;
  v_card public.gift_cards; v_student uuid; s public.sessions; v_prev text; v_res jsonb;
  v_roster uuid[]; v_gifts jsonb; v_manual jsonb; v_gift uuid;
begin
  if d.kind = 'bono.create' then
    v_card := public.external_create_gift_card_with_temporal_student(d.sede_id,
      jsonb_strip_nulls(jsonb_build_object('code', p->>'code', 'recipient', p->>'recipient', 'buyer', p->>'buyer',
        'buyer_phone', p->>'buyerPhone', 'buyer_email', p->>'buyerEmail', 'recipient_email', p->>'recipientEmail',
        'dedication', p->>'dedication',
        'validity_months', p->'validityMonths', 'activated_at', p->>'activatedAt', 'price', p->'price',
        'delivery_format', p->>'deliveryFormat', 'num_classes', p->'numClasses', 'type', p->>'type',
        'payment_status', p->>'paymentStatus', 'external_reference', 'asistonto:' || d.id::text,
        'external_metadata', jsonb_build_object('source', 'asistonto', 'draft_id', d.id, 'approval_ref', d.approval_ref))),
      jsonb_strip_nulls(jsonb_build_object('full_name', p->>'recipient', 'phone', p->>'recipientPhone')));
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

revoke all on function private.asistonto_prepare(uuid, text, jsonb), private.asistonto_execute(private.asistonto_drafts)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
