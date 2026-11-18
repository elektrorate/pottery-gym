-- Casa Rosier bonos designer inside pottery-gym (/giftcards -> «Diseñar bono»).
-- Logged-in users of a sede create a bono + a NEW temporal student atomically.
-- Thin, authenticated wrapper around external_create_gift_card_with_temporal_student
-- (20261118120000, service_role only): it adds the caller's sede access check and
-- never lets the caller choose consumption, status or expiry (the card guard and the
-- wrapped function keep doing that). Requires 20261118120000.
begin;

create or replace function public.designer_create_gift_card_with_temporal_student(
  p_sede_id uuid,
  p_card jsonb,
  p_student jsonb
) returns public.gift_cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card jsonb;
begin
  if (select auth.uid()) is null or not (select private.can_access_sede(p_sede_id)) then
    raise exception 'No autorizado: sin acceso a la sede' using errcode = '42501';
  end if;
  if p_card is null or jsonb_typeof(p_card) <> 'object' then
    raise exception 'Datos del bono no validos';
  end if;
  -- Only the fields the designer sends; nothing server-managed.
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_card
  from jsonb_each(p_card)
  where key in ('code', 'buyer', 'recipient', 'buyer_phone', 'buyer_email', 'recipient_email', 'dedication',
    'validity_months', 'activated_at', 'price', 'delivery_format', 'num_classes', 'type', 'payment_status',
    'extra_commentary', 'internal_notes', 'external_reference', 'external_metadata');
  if coalesce(v_card->>'payment_status', 'pending') not in ('pending', 'paid') then
    raise exception 'New gift cards require pending or paid payment status';
  end if;
  return public.external_create_gift_card_with_temporal_student(
    p_sede_id,
    v_card,
    jsonb_build_object(
      'full_name', p_student->>'full_name',
      'phone', p_student->>'phone',
      'notes', p_student->>'notes'
    )
  );
end $$;

revoke all on function public.designer_create_gift_card_with_temporal_student(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.designer_create_gift_card_with_temporal_student(uuid, jsonb, jsonb)
  to authenticated;

notify pgrst, 'reload schema';
commit;
