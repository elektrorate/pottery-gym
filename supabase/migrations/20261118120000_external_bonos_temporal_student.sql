-- Casa Rosier bonos (bono-gift-card) -> pottery-gym.
-- 1) Allow 12-month validity (Casa Rosier default) next to 3/6/8.
-- 2) Atomic external create: a NEW temporal student + its gift card in one
--    transaction. Names are never matched to existing students; the person is
--    always created explicitly and linked by id, so "names are not identities"
--    still holds (ensure_gift_card_recipient_student_link is unchanged).
begin;

-- 1a) Table constraint.
alter table public.gift_cards drop constraint if exists gift_cards_validity_months_check;
alter table public.gift_cards add constraint gift_cards_validity_months_check
  check (validity_months in (3, 6, 8, 12));

-- 1b) Projection guard: patch only the validity list of the *installed*
--     definition, so any other live difference in the function is preserved.
do $patch$
declare
  definition text := pg_get_functiondef('private.guard_gift_card_projection()'::regprocedure);
  patched text;
begin
  if position('not in (3, 6, 8, 12)' in definition) > 0 then
    return; -- already applied
  end if;
  if (length(definition) - length(replace(definition, 'not in (3, 6, 8)', ''))) / length('not in (3, 6, 8)') <> 1 then
    raise exception 'guard_gift_card_projection: expected exactly one "not in (3, 6, 8)" validity check';
  end if;
  patched := replace(definition, 'not in (3, 6, 8)', 'not in (3, 6, 8, 12)');
  execute patched;
end
$patch$;
revoke all on function private.guard_gift_card_projection() from public, anon, authenticated, service_role;

-- 2) Atomic create with a new temporal student (service_role only).
create or replace function public.external_create_gift_card_with_temporal_student(
  p_sede_id uuid,
  p_card jsonb,
  p_student jsonb
) returns public.gift_cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := nullif(upper(btrim(coalesce(p_card->>'code', ''))), '');
  v_recipient text := nullif(btrim(coalesce(p_card->>'recipient', '')), '');
  v_full_name text := nullif(btrim(coalesce(p_student->>'full_name', '')), '');
  v_phone text := nullif(btrim(coalesce(p_student->>'phone', '')), '');
  v_note text := nullif(btrim(coalesce(p_student->>'notes', '')), '');
  v_student_id uuid;
  v_card public.gift_cards;
begin
  if p_sede_id is null or not exists (select 1 from public.sedes s where s.id = p_sede_id and s.is_active) then
    raise exception 'No autorizado: sede no disponible';
  end if;
  if p_card is null or jsonb_typeof(p_card) <> 'object' then
    raise exception 'Datos del bono no validos';
  end if;
  if v_recipient is null then raise exception 'recipient is required'; end if;
  v_full_name := coalesce(v_full_name, v_recipient);
  -- Same format as the column default when the caller sends no code.
  v_code := coalesce(v_code, 'CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));

  -- Serialize creates of the same code and fail BEFORE creating any person.
  perform pg_advisory_xact_lock(hashtext('external_gift_card_code:' || v_code));
  if exists (select 1 from public.gift_cards c where c.code = v_code) then
    raise exception 'duplicate key value violates unique constraint "gift_cards_code_unique_idx"'
      using errcode = '23505', detail = 'Key (code)=(' || v_code || ') already exists.';
  end if;

  insert into public.students (sede_id, full_name, name, phone, notes, student_category,
    bonos_asignados, classes_remaining, status)
  values (p_sede_id, v_full_name, v_full_name, v_phone, v_note, 'temporal', 0, 0, 'active')
  returning id into v_student_id;

  insert into public.gift_cards (sede_id, recipient_student_id, code, buyer, recipient, buyer_phone,
    buyer_email, recipient_email, dedication, validity_months, activated_at, price, delivery_format,
    num_classes, type, payment_status, extra_commentary, internal_notes, external_reference, external_metadata)
  values (p_sede_id, v_student_id, v_code, p_card->>'buyer', v_recipient,
    p_card->>'buyer_phone', p_card->>'buyer_email', p_card->>'recipient_email', p_card->>'dedication',
    (p_card->>'validity_months')::integer, (p_card->>'activated_at')::date, (p_card->>'price')::numeric,
    coalesce(p_card->>'delivery_format', 'digital'), (p_card->>'num_classes')::integer,
    coalesce(p_card->>'type', 'modelado'), coalesce(p_card->>'payment_status', 'pending'),
    p_card->>'extra_commentary', p_card->>'internal_notes', p_card->>'external_reference',
    coalesce(p_card->'external_metadata', '{}'::jsonb))
  returning * into v_card;
  -- Any failure above raises and rolls back the student too (single transaction).
  return v_card;
end $$;

revoke all on function public.external_create_gift_card_with_temporal_student(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.external_create_gift_card_with_temporal_student(uuid, jsonb, jsonb)
  to service_role;

notify pgrst, 'reload schema';
commit;
