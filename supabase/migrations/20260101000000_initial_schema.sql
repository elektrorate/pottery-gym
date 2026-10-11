-- Local reconstruction baseline exported from the linked staging schema on 2026-10-11.
-- It contains schema only (no application data). Do not run `supabase db push`
-- until this baseline has been reconciled with the linked project's migration history.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'Application schema reset for calendario taller clone';



CREATE TYPE "public"."item_status" AS ENUM (
    'active',
    'archived'
);


ALTER TYPE "public"."item_status" OWNER TO "postgres";


CREATE TYPE "public"."movement_type" AS ENUM (
    'in',
    'out',
    'adjust'
);


ALTER TYPE "public"."movement_type" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'super_admin',
    'tallerista',
    'staff'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."can_access_sede"("target_sede_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select (select auth.uid()) is not null
    and (
      (select private.is_super_admin())
      or target_sede_id in (select private.user_sede_ids())
    );
$$;


ALTER FUNCTION "private"."can_access_sede"("target_sede_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."current_sede_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select accessible_sedes.sede_id
  from private.user_sede_ids() as accessible_sedes(sede_id)
  order by accessible_sedes.sede_id
  limit 1;
$$;


ALTER FUNCTION "private"."current_sede_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_super_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles
      where id = (select auth.uid())
        and role = 'super_admin'::public.user_role
    );
$$;


ALTER FUNCTION "private"."is_super_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."user_sede_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select s.id
  from public.sedes as s
  where s.owner_id = (select auth.uid())
    and s.is_active is true
  union
  select sm.sede_id
  from public.sede_members as sm
  join public.sedes as s on s.id = sm.sede_id
  where sm.user_id = (select auth.uid())
    and s.is_active is true;
$$;


ALTER FUNCTION "private"."user_sede_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_sede_id_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.sede_id is null then
    new.sede_id := private.current_sede_id();
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."assign_sede_id_on_insert"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."gift_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"(),
    "buyer" "text",
    "recipient" "text",
    "num_classes" integer,
    "type" "text",
    "scheduled_date" timestamp with time zone,
    "extra_commentary" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expiry_date" "date" DEFAULT ((("now"() AT TIME ZONE 'UTC'::"text"))::"date" + 30) NOT NULL,
    "recipient_student_id" "uuid",
    "code" "text" DEFAULT ('CR-'::"text" || "upper"("substr"("replace"(("gen_random_uuid"())::"text", '-'::"text", ''::"text"), 1, 10))),
    "buyer_phone" "text",
    "buyer_email" "text",
    "recipient_email" "text",
    "validity_months" integer DEFAULT 3,
    "activated_at" "date",
    "price" numeric(10,2),
    "payment_status" "text" DEFAULT 'pending'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "sessions_used" integer DEFAULT 0,
    "delivery_format" "text" DEFAULT 'digital'::"text",
    "dedication" "text",
    "internal_notes" "text",
    "consumed_at" "date",
    "external_reference" "text",
    "external_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "gift_cards_delivery_format_check" CHECK (("delivery_format" = ANY (ARRAY['digital'::"text", 'physical'::"text"]))),
    CONSTRAINT "gift_cards_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'refunded'::"text"]))),
    CONSTRAINT "gift_cards_sessions_used_check" CHECK ((("sessions_used" >= 0) AND ("sessions_used" <= "num_classes"))),
    CONSTRAINT "gift_cards_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'exhausted'::"text", 'consumed'::"text", 'expired'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "gift_cards_validity_months_check" CHECK (("validity_months" = ANY (ARRAY[3, 6, 8])))
);


ALTER TABLE "public"."gift_cards" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_gift_card"("p_gift_card_id" "uuid") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
begin
  select * into card
  from public.gift_cards
  where id = p_gift_card_id
  for update;

  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if card.status in ('cancelled', 'consumed', 'exhausted') then raise exception 'El bono ya está archivado'; end if;

  update public.gift_cards
  set status = 'cancelled'
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."cancel_gift_card"("p_gift_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_gift_card"("p_gift_card_id" "uuid", "p_consumed_at" "date" DEFAULT (("now"() AT TIME ZONE 'UTC'::"text"))::"date") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
begin
  select * into card from public.gift_cards where id = p_gift_card_id for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if card.status in ('cancelled', 'consumed', 'exhausted') then raise exception 'El bono ya está archivado'; end if;
  if card.expiry_date < ((now() at time zone 'UTC')::date) then
    update public.gift_cards set status = 'expired' where id = card.id;
    raise exception 'El bono temporal está caducado';
  end if;

  update public.gift_cards
  set status = 'consumed', consumed_at = coalesce(p_consumed_at, (now() at time zone 'UTC')::date)
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."consume_gift_card"("p_gift_card_id" "uuid", "p_consumed_at" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_tenant_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select tenant_id
  from public.tenant_members
  where user_id = auth.uid()
$$;


ALTER FUNCTION "public"."current_tenant_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_gift_card_recipient_student_link"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_recipient text;
  v_student_id uuid;
  v_name text;
  v_surname text;
  v_effective_type text;
begin
  v_recipient := btrim(coalesce(new.recipient, ''));

  -- When a student is deleted, FK "ON DELETE SET NULL" updates gift_cards.
  -- Keep that NULL as-is instead of recreating a new temporary student.
  if tg_op = 'UPDATE'
     and old.recipient_student_id is not null
     and new.recipient_student_id is null
     and old.recipient is not distinct from new.recipient
     and old.sede_id is not distinct from new.sede_id
     and old.num_classes is not distinct from new.num_classes
     and old.type is not distinct from new.type
     and old.expiry_date is not distinct from new.expiry_date then
    return new;
  end if;

  if new.sede_id is null or v_recipient = '' then
    return new;
  end if;

  if new.recipient_student_id is not null then
    select s.id
      into v_student_id
    from public.students s
    where s.id = new.recipient_student_id
      and s.sede_id = new.sede_id
      and s.student_category in ('temporal', 'grupo_temporal', 'grupal')
    limit 1;

    if v_student_id is not null then
      new.recipient_student_id := v_student_id;
      return new;
    end if;

    new.recipient_student_id := null;
  end if;

  select s.id
    into v_student_id
  from public.students s
  where s.sede_id = new.sede_id
    and s.student_category in ('temporal', 'grupo_temporal', 'grupal')
    and (
      upper(btrim(s.full_name)) = upper(v_recipient)
      or upper(btrim(s.name)) = upper(v_recipient)
    )
  order by
    case when upper(btrim(s.full_name)) = upper(v_recipient) then 0 else 1 end,
    s.created_at desc nulls last,
    s.id
  limit 1;

  if v_student_id is null then
    v_name := split_part(v_recipient, ' ', 1);
    v_surname := nullif(btrim(substr(v_recipient, length(v_name) + 1)), '');
    v_effective_type := coalesce(new.type, 'modelado');

    insert into public.students (
      sede_id,
      full_name,
      name,
      surname,
      phone,
      classes_remaining,
      status,
      student_category,
      class_type,
      expiry_date,
      notes
    )
    values (
      new.sede_id,
      v_recipient,
      v_name,
      v_surname,
      '',
      coalesce(new.num_classes, 0),
      'new',
      'temporal',
      case when v_effective_type = 'torno' then 'Torno' else 'Modelado' end,
      case when new.expiry_date is not null then (new.expiry_date::timestamp at time zone 'UTC') else null end,
      'Creado automaticamente desde bono regalo'
    )
    returning id into v_student_id;
  end if;

  new.recipient_student_id := v_student_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."ensure_gift_card_recipient_student_link"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."external_cancel_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
begin
  select * into card from public.gift_cards
  where id = p_gift_card_id and sede_id = p_sede_id
  for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if card.status in ('cancelled', 'consumed', 'exhausted') then raise exception 'El bono ya esta archivado'; end if;

  update public.gift_cards set status = 'cancelled' where id = card.id;
  insert into public.gift_card_movements (gift_card_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_sede_id, 'cancel', -1, 'Anulacion desde API externa');

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."external_cancel_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."external_consume_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_consumed_at" "date" DEFAULT (("now"() AT TIME ZONE 'UTC'::"text"))::"date") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
begin
  select * into card from public.gift_cards
  where id = p_gift_card_id and sede_id = p_sede_id
  for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if card.status in ('cancelled', 'consumed', 'exhausted') then raise exception 'El bono ya esta archivado'; end if;
  if card.expiry_date < ((now() at time zone 'UTC')::date) then
    update public.gift_cards set status = 'expired' where id = card.id;
    raise exception 'El bono temporal esta caducado';
  end if;

  update public.gift_cards
  set status = 'consumed', consumed_at = coalesce(p_consumed_at, (now() at time zone 'UTC')::date)
  where id = card.id;

  insert into public.gift_card_movements (gift_card_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_sede_id, 'manual', greatest(1, card.num_classes - coalesce(card.sessions_used, 0)), 'Consumo manual desde API externa');

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."external_consume_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_consumed_at" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."external_redeem_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
  inserted_id uuid;
  today date := (now() at time zone 'UTC')::date;
begin
  select * into card
  from public.gift_cards
  where id = p_gift_card_id and sede_id = p_sede_id
  for update;

  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if card.payment_status <> 'paid' then raise exception 'El bono no esta pagado'; end if;
  if card.status in ('cancelled', 'exhausted', 'consumed', 'expired') then raise exception 'El bono no tiene sesiones disponibles'; end if;
  if p_student_id is null or not exists (
    select 1 from public.session_students
    where session_id = p_session_id and student_id = p_student_id and sede_id = p_sede_id
  ) then
    raise exception 'La sesion no esta vinculada al alumno del bono';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = p_sede_id) then
    raise exception 'La sesion no pertenece al taller del bono';
  end if;
  if card.expiry_date < today then
    update public.gift_cards set status = 'expired' where id = card.id;
    raise exception 'El bono temporal esta caducado';
  end if;
  if coalesce(card.sessions_used, 0) >= card.num_classes then raise exception 'El bono no tiene sesiones disponibles'; end if;

  insert into public.gift_card_movements (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_session_id, p_student_id, p_sede_id, 'redeem', 1, 'Consumo desde API externa')
  on conflict (gift_card_id, session_id, student_id) where movement_type = 'redeem' do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    update public.gift_cards
    set sessions_used = coalesce(sessions_used, 0) + 1,
        status = case when coalesce(sessions_used, 0) + 1 >= num_classes then 'consumed' else 'active' end,
        consumed_at = case when coalesce(sessions_used, 0) + 1 >= num_classes then today else null end
    where id = card.id;
  end if;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."external_redeem_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."external_reverse_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
begin
  select * into card from public.gift_cards
  where id = p_gift_card_id and sede_id = p_sede_id
  for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not exists (
    select 1 from public.session_students
    where session_id = p_session_id and student_id = p_student_id and sede_id = p_sede_id
  ) then
    raise exception 'La sesion no esta vinculada al alumno del bono';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = p_sede_id) then
    raise exception 'La sesion no pertenece al taller del bono';
  end if;

  if exists (
    select 1 from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id = p_student_id and movement_type = 'reverse'
  ) then
    return card;
  end if;

  if not exists (
    select 1 from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id = p_student_id and movement_type = 'redeem'
  ) then
    return card;
  end if;

  insert into public.gift_card_movements (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_session_id, p_student_id, p_sede_id, 'reverse', -1, 'Reversion desde API externa');

  update public.gift_cards
  set sessions_used = greatest(0, coalesce(sessions_used, 0) - 1),
      status = case when expiry_date < (now() at time zone 'UTC')::date then 'expired' else 'active' end,
      consumed_at = null
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."external_reverse_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_owned_sede_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select accessible_sedes.sede_id
  from private.user_sede_ids() as accessible_sedes(sede_id)
  order by accessible_sedes.sede_id
  limit 1;
$$;


ALTER FUNCTION "public"."get_owned_sede_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_owner_sede_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN (SELECT id FROM sedes WHERE owner_id = auth.uid());
END;
$$;


ALTER FUNCTION "public"."get_owner_sede_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'tallerista'::public.user_role
  );
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_super_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select private.is_super_admin();
$$;


ALTER FUNCTION "public"."is_super_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_super_admins"() RETURNS TABLE("user_id" "uuid", "email" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select u.id, u.email
  from auth.users u
  where u.is_super_admin = true
  and public.is_super_admin(); -- solo superadmins pueden listar
$$;


ALTER FUNCTION "public"."list_super_admins"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
  inserted_id uuid;
  today date := (now() at time zone 'UTC')::date;
begin
  select * into card
  from public.gift_cards
  where id = p_gift_card_id
  for update;

  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if card.payment_status <> 'paid' then raise exception 'El bono no está pagado'; end if;
  if card.status in ('cancelled', 'exhausted', 'consumed', 'expired') then raise exception 'El bono no tiene sesiones disponibles'; end if;
  if p_student_id is null or not exists (
    select 1
    from public.session_students
    where session_id = p_session_id
      and student_id = p_student_id
      and sede_id = card.sede_id
  ) then
    raise exception 'La sesión no está vinculada al alumno del bono';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = card.sede_id) then
    raise exception 'La sesión no pertenece al taller del bono';
  end if;
  if card.expiry_date < today then
    update public.gift_cards set status = 'expired' where id = card.id;
    raise exception 'El bono temporal está caducado';
  end if;
  if coalesce(card.sessions_used, 0) >= card.num_classes then raise exception 'El bono no tiene sesiones disponibles'; end if;

  insert into public.gift_card_movements (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_session_id, p_student_id, card.sede_id, 'redeem', 1, 'Asistencia validada')
  on conflict (gift_card_id, session_id, student_id) where movement_type = 'redeem' do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    update public.gift_cards
    set sessions_used = coalesce(sessions_used, 0) + 1,
        status = case when coalesce(sessions_used, 0) + 1 >= num_classes then 'consumed' else 'active' end,
        consumed_at = case when coalesce(sessions_used, 0) + 1 >= num_classes then today else null end
    where id = card.id;
  end if;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."redeem_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reverse_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."gift_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  card public.gift_cards;
begin
  select * into card from public.gift_cards where id = p_gift_card_id for update;
  if card.id is null then raise exception 'Bono temporal no encontrado'; end if;
  if not private.can_access_sede(card.sede_id) then raise exception 'No autorizado para este bono'; end if;
  if p_student_id is null or not exists (
    select 1
    from public.session_students
    where session_id = p_session_id
      and student_id = p_student_id
      and sede_id = card.sede_id
  ) then
    raise exception 'La sesión no está vinculada al alumno del bono';
  end if;
  if not exists (select 1 from public.sessions where id = p_session_id and sede_id = card.sede_id) then
    raise exception 'La sesión no pertenece al taller del bono';
  end if;

  if exists (
    select 1 from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id is not distinct from p_student_id and movement_type = 'reverse'
  ) then
    return card;
  end if;

  if not exists (
    select 1 from public.gift_card_movements
    where gift_card_id = card.id and session_id = p_session_id and student_id is not distinct from p_student_id and movement_type = 'redeem'
  ) then
    return card;
  end if;

  insert into public.gift_card_movements (gift_card_id, session_id, student_id, sede_id, movement_type, sessions_delta, note)
  values (card.id, p_session_id, p_student_id, card.sede_id, 'reverse', -1, 'Corrección de asistencia');

  update public.gift_cards
  set sessions_used = greatest(0, coalesce(sessions_used, 0) - 1),
      status = case when expiry_date < (now() at time zone 'UTC')::date then 'expired' else 'active' end,
      consumed_at = null
  where id = card.id;

  select * into card from public.gift_cards where id = card.id;
  return card;
end;
$$;


ALTER FUNCTION "public"."reverse_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."student_lifecycle"("category" "text", "payment" "text", "legacy_status" "text", "due_date" "date", "manual_archive" "date", "as_of" "date") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select case
    when manual_archive is not null then 'archived'
    when category = 'temporal' then 'temporary'
    when due_date is not null and as_of - due_date >= 6 then 'archived'
    when due_date is null or due_date < as_of then 'pending'
    when coalesce(payment, case when legacy_status in ('membresia', 'active') then 'paid' else 'pending' end) <> 'paid' then 'pending'
    else 'active'
  end;
$$;


ALTER FUNCTION "public"."student_lifecycle"("category" "text", "payment" "text", "legacy_status" "text", "due_date" "date", "manual_archive" "date", "as_of" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_session_capacity_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  enrolled_count integer;
begin
  select count(*)::integer
    into enrolled_count
    from public.session_students
   where session_id = new.id;

  if new.capacity < enrolled_count then
    raise exception 'La capacidad no puede ser menor que los alumnos inscritos (%).', enrolled_count
      using errcode = '23514';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."validate_session_capacity_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_session_student_capacity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  max_capacity integer;
  enrolled_count integer;
  previous_student_id uuid;
begin
  select capacity
    into max_capacity
    from public.sessions
   where id = new.session_id;

  if max_capacity is null then
    return new;
  end if;

  previous_student_id := null;
  if tg_op = 'UPDATE' then
    previous_student_id := old.student_id;
  end if;

  select count(*)::integer
    into enrolled_count
    from public.session_students
   where session_id = new.session_id
     and student_id is distinct from previous_student_id;

  if enrolled_count >= max_capacity then
    raise exception 'La sesión ya ha alcanzado su capacidad máxima de % alumnos.', max_capacity
      using errcode = '23514';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."validate_session_student_capacity"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gift_card_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gift_card_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "student_id" "uuid",
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "movement_type" "text" NOT NULL,
    "sessions_delta" integer NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "gift_card_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['redeem'::"text", 'reverse'::"text", 'manual'::"text", 'cancel'::"text"]))),
    CONSTRAINT "gift_card_movements_sessions_delta_check" CHECK (("sessions_delta" <> 0))
);


ALTER TABLE "public"."gift_card_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "code" "text",
    "current_quantity" numeric DEFAULT 0,
    "unit" "text" DEFAULT 'units'::"text",
    "min_quantity" numeric DEFAULT 0,
    "status" "public"."item_status" DEFAULT 'active'::"public"."item_status",
    "location" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "supplier_code" "text",
    "temperature" "text",
    "color" "text",
    "color_family" "text",
    "finish" "text",
    "recipe" "jsonb",
    "notes" "text"
);


ALTER TABLE "public"."inventory_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "type" "public"."movement_type" NOT NULL,
    "quantity" numeric NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "uuid",
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"(),
    "item_id" "uuid",
    "new_quantity" numeric,
    "unit" "text",
    "date" "text",
    "notes" "text"
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "total_classes" integer NOT NULL,
    "remaining_classes" integer NOT NULL,
    "expires_at" timestamp with time zone,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."packages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "student_id" "uuid",
    "amount" numeric(10,2) NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text",
    "payment_method" "text",
    "status" "text" DEFAULT 'completed'::"text",
    "concept" "text",
    "payment_date" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "payments_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash'::"text", 'card'::"text", 'transfer'::"text", 'bizum'::"text", 'other'::"text"]))),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'completed'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pieces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "student_id" "uuid",
    "owner_name" "text",
    "description" "text",
    "status" "text" DEFAULT 'en_proceso'::"text",
    "photo_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "glaze_type" "text",
    "delivery_date" timestamp with time zone,
    "notes" "text",
    "extra_commentary" "text"
);


ALTER TABLE "public"."pieces" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "role" "public"."user_role" DEFAULT 'tallerista'::"public"."user_role",
    "avatar_url" "text",
    "phone" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sede_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."user_role" DEFAULT 'staff'::"public"."user_role",
    "joined_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sede_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sedes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "address" "text",
    "city" "text",
    "country" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "owner_id" "uuid",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sedes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."session_students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'confirmed'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "student_name" "text",
    "attendance" "text",
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"(),
    "temp_group_name" "text",
    "is_temporary" boolean DEFAULT false,
    "gift_card_id" "uuid"
);


ALTER TABLE "public"."session_students" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "title" "text",
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "instructor_id" "uuid",
    "max_capacity" integer DEFAULT 10,
    "type" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "teacher_id" "uuid",
    "teacher_substitute_id" "uuid",
    "completed_at" timestamp with time zone,
    "workshop_name" "text",
    "private_reason" "text",
    "class_type" "text",
    "date" "text",
    "session_audience" "text" DEFAULT 'membresia'::"text",
    "capacity" integer DEFAULT 8 NOT NULL,
    CONSTRAINT "sessions_capacity_positive" CHECK ((("capacity" >= 1) AND ("capacity" <= 100))),
    CONSTRAINT "sessions_session_audience_check" CHECK ((("session_audience" IS NULL) OR ("session_audience" = ANY (ARRAY['membresia'::"text", 'temporal'::"text", 'ambos'::"text"]))))
);


ALTER TABLE "public"."sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."student_assigned_classes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid",
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"(),
    "date" "text",
    "start_time" "text",
    "end_time" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."student_assigned_classes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "status" "text" DEFAULT 'active'::"text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "name" "text",
    "surname" "text",
    "phone_country" "text",
    "birth_day" integer,
    "birth_month" integer,
    "birth_year" integer,
    "classes_remaining" integer DEFAULT 0,
    "payment_method" "text",
    "observations" "text",
    "price" numeric,
    "class_type" "text",
    "expiry_date" timestamp with time zone,
    "student_category" "text" DEFAULT 'membresia'::"text",
    "group_name" "text",
    "bonos_asignados" integer DEFAULT 4,
    "repetir_mensualmente" boolean DEFAULT false,
    "membership_tier" "text",
    "membership_activated_at" "date",
    "archived_at" "date",
    "payment_status" "text",
    CONSTRAINT "students_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['paid'::"text", 'pending'::"text"]))),
    CONSTRAINT "students_student_category_check" CHECK (("student_category" = ANY (ARRAY['membresia'::"text", 'iniciacion'::"text", 'grupal'::"text", 'temporal'::"text", 'grupo_temporal'::"text"])))
);


ALTER TABLE "public"."students" OWNER TO "postgres";


COMMENT ON COLUMN "public"."students"."payment_status" IS 'Explicit payment confirmation; NULL means legacy payment not yet reviewed.';



CREATE OR REPLACE VIEW "public"."students_with_lifecycle" WITH ("security_invoker"='true') AS
 SELECT "id",
    "sede_id",
    "full_name",
    "email",
    "phone",
    "status",
    "notes",
    "created_at",
    "name",
    "surname",
    "phone_country",
    "birth_day",
    "birth_month",
    "birth_year",
    "classes_remaining",
    "payment_method",
    "observations",
    "price",
    "class_type",
    "expiry_date",
    "student_category",
    "group_name",
    "bonos_asignados",
    "repetir_mensualmente",
    "membership_tier",
    "membership_activated_at",
    "archived_at",
    "payment_status",
    "public"."student_lifecycle"("student_category", "payment_status", "status", (("expiry_date" AT TIME ZONE 'UTC'::"text"))::"date", "archived_at", (("now"() AT TIME ZONE 'Europe/Madrid'::"text"))::"date") AS "lifecycle_status"
   FROM "public"."students" "s";


ALTER VIEW "public"."students_with_lifecycle" OWNER TO "postgres";


COMMENT ON VIEW "public"."students_with_lifecycle" IS 'Current lifecycle in Europe/Madrid: active through payment due date, pending days 1-5, archived from day 6. Temporary students excluded from memberships; no balance-based archival.';



CREATE TABLE IF NOT EXISTS "public"."teachers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"(),
    "name" "text" NOT NULL,
    "surname" "text",
    "email" "text",
    "phone" "text",
    "specialty" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."teachers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workshop_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" DEFAULT "private"."current_sede_id"() NOT NULL,
    "day_of_week" smallint NOT NULL,
    "is_open" boolean DEFAULT false NOT NULL,
    "opens_at" time without time zone,
    "closes_at" time without time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slot_index" smallint DEFAULT 0 NOT NULL,
    CONSTRAINT "workshop_schedules_day_of_week_check" CHECK ((("day_of_week" >= 0) AND ("day_of_week" <= 6))),
    CONSTRAINT "workshop_schedules_hours_valid" CHECK ((((NOT "is_open") AND ("opens_at" IS NULL) AND ("closes_at" IS NULL)) OR ("is_open" AND ("opens_at" IS NOT NULL) AND ("closes_at" IS NOT NULL) AND ("opens_at" < "closes_at")))),
    CONSTRAINT "workshop_schedules_slot_index_valid" CHECK ((("slot_index" >= 0) AND ("slot_index" <= 20)))
);


ALTER TABLE "public"."workshop_schedules" OWNER TO "postgres";


ALTER TABLE ONLY "public"."pieces"
    ADD CONSTRAINT "ceramic_pieces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gift_card_movements"
    ADD CONSTRAINT "gift_card_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gift_cards"
    ADD CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sede_members"
    ADD CONSTRAINT "sede_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sede_members"
    ADD CONSTRAINT "sede_members_sede_id_user_id_key" UNIQUE ("sede_id", "user_id");



ALTER TABLE ONLY "public"."sedes"
    ADD CONSTRAINT "sedes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sedes"
    ADD CONSTRAINT "sedes_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."session_students"
    ADD CONSTRAINT "session_bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_students"
    ADD CONSTRAINT "session_bookings_session_id_student_id_key" UNIQUE ("session_id", "student_id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_assigned_classes"
    ADD CONSTRAINT "student_assigned_classes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."teachers"
    ADD CONSTRAINT "teachers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workshop_schedules"
    ADD CONSTRAINT "workshop_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workshop_schedules"
    ADD CONSTRAINT "workshop_schedules_sede_day_slot_unique" UNIQUE ("sede_id", "day_of_week", "slot_index");



CREATE INDEX "gift_card_movements_card_idx" ON "public"."gift_card_movements" USING "btree" ("gift_card_id", "created_at" DESC);



CREATE UNIQUE INDEX "gift_card_movements_redeem_unique_idx" ON "public"."gift_card_movements" USING "btree" ("gift_card_id", "session_id", "student_id") WHERE ("movement_type" = 'redeem'::"text");



CREATE UNIQUE INDEX "gift_cards_code_unique_idx" ON "public"."gift_cards" USING "btree" ("code");



CREATE INDEX "gift_cards_consumed_at_idx" ON "public"."gift_cards" USING "btree" ("consumed_at");



CREATE INDEX "gift_cards_expiry_date_idx" ON "public"."gift_cards" USING "btree" ("expiry_date");



CREATE INDEX "gift_cards_external_reference_idx" ON "public"."gift_cards" USING "btree" ("sede_id", "external_reference");



CREATE INDEX "gift_cards_status_idx" ON "public"."gift_cards" USING "btree" ("status");



CREATE INDEX "idx_gift_cards_sede_id" ON "public"."gift_cards" USING "btree" ("sede_id");



CREATE INDEX "idx_inventory_items_sede_id" ON "public"."inventory_items" USING "btree" ("sede_id");



CREATE INDEX "idx_inventory_movements_sede_id" ON "public"."inventory_movements" USING "btree" ("sede_id");



CREATE INDEX "idx_inventory_movements_user_id" ON "public"."inventory_movements" USING "btree" ("user_id");



CREATE INDEX "idx_packages_student_id" ON "public"."packages" USING "btree" ("student_id");



CREATE INDEX "idx_payments_created_by" ON "public"."payments" USING "btree" ("created_by");



CREATE INDEX "idx_payments_sede_id" ON "public"."payments" USING "btree" ("sede_id");



CREATE INDEX "idx_payments_student_id" ON "public"."payments" USING "btree" ("student_id");



CREATE INDEX "idx_pieces_sede_id" ON "public"."pieces" USING "btree" ("sede_id");



CREATE INDEX "idx_pieces_student_id" ON "public"."pieces" USING "btree" ("student_id");



CREATE INDEX "idx_sede_members_user_id" ON "public"."sede_members" USING "btree" ("user_id");



CREATE INDEX "idx_session_students_sede_id" ON "public"."session_students" USING "btree" ("sede_id");



CREATE INDEX "idx_session_students_student_id" ON "public"."session_students" USING "btree" ("student_id");



CREATE INDEX "idx_sessions_sede_id" ON "public"."sessions" USING "btree" ("sede_id");



CREATE INDEX "idx_student_assigned_classes_student_id" ON "public"."student_assigned_classes" USING "btree" ("student_id");



CREATE INDEX "idx_students_sede_id" ON "public"."students" USING "btree" ("sede_id");



CREATE INDEX "session_students_gift_card_idx" ON "public"."session_students" USING "btree" ("gift_card_id");



CREATE INDEX "students_archived_at_idx" ON "public"."students" USING "btree" ("archived_at");



CREATE INDEX "students_membership_tier_idx" ON "public"."students" USING "btree" ("membership_tier");



CREATE OR REPLACE TRIGGER "on_profiles_updated" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "on_sedes_updated" BEFORE UPDATE ON "public"."sedes" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "session_students_validate_capacity" BEFORE INSERT OR UPDATE OF "session_id", "student_id" ON "public"."session_students" FOR EACH ROW EXECUTE FUNCTION "public"."validate_session_student_capacity"();



CREATE OR REPLACE TRIGGER "sessions_validate_capacity_update" BEFORE UPDATE OF "capacity" ON "public"."sessions" FOR EACH ROW EXECUTE FUNCTION "public"."validate_session_capacity_update"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_assigned_classes" BEFORE INSERT ON "public"."student_assigned_classes" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_gift_cards" BEFORE INSERT ON "public"."gift_cards" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_inventory_items" BEFORE INSERT ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_inventory_movements" BEFORE INSERT ON "public"."inventory_movements" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_pieces" BEFORE INSERT ON "public"."pieces" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_session_students" BEFORE INSERT ON "public"."session_students" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_sessions" BEFORE INSERT ON "public"."sessions" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_students" BEFORE INSERT ON "public"."students" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_assign_sede_teachers" BEFORE INSERT ON "public"."teachers" FOR EACH ROW EXECUTE FUNCTION "public"."assign_sede_id_on_insert"();



CREATE OR REPLACE TRIGGER "trg_ensure_gift_card_recipient_student_link" BEFORE INSERT OR UPDATE OF "recipient", "recipient_student_id", "num_classes", "type", "expiry_date", "sede_id" ON "public"."gift_cards" FOR EACH ROW EXECUTE FUNCTION "public"."ensure_gift_card_recipient_student_link"();



ALTER TABLE ONLY "public"."pieces"
    ADD CONSTRAINT "ceramic_pieces_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."pieces"
    ADD CONSTRAINT "ceramic_pieces_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gift_card_movements"
    ADD CONSTRAINT "gift_card_movements_gift_card_id_fkey" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gift_card_movements"
    ADD CONSTRAINT "gift_card_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."gift_card_movements"
    ADD CONSTRAINT "gift_card_movements_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."gift_cards"
    ADD CONSTRAINT "gift_cards_recipient_student_id_fkey" FOREIGN KEY ("recipient_student_id") REFERENCES "public"."students"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."gift_cards"
    ADD CONSTRAINT "gift_cards_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sede_members"
    ADD CONSTRAINT "sede_members_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sede_members"
    ADD CONSTRAINT "sede_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sedes"
    ADD CONSTRAINT "sedes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."session_students"
    ADD CONSTRAINT "session_bookings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."session_students"
    ADD CONSTRAINT "session_bookings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."session_students"
    ADD CONSTRAINT "session_students_gift_card_id_fkey" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."session_students"
    ADD CONSTRAINT "session_students_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_instructor_id_fkey" FOREIGN KEY ("instructor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_teacher_substitute_id_fkey" FOREIGN KEY ("teacher_substitute_id") REFERENCES "public"."teachers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."student_assigned_classes"
    ADD CONSTRAINT "student_assigned_classes_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."student_assigned_classes"
    ADD CONSTRAINT "student_assigned_classes_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."teachers"
    ADD CONSTRAINT "teachers_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id");



ALTER TABLE ONLY "public"."workshop_schedules"
    ADD CONSTRAINT "workshop_schedules_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."sedes"("id") ON DELETE CASCADE;



ALTER TABLE "public"."gift_card_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gift_card_movements_delete_authorized" ON "public"."gift_card_movements" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("gift_card_movements"."sede_id") AS "can_access_sede"));



CREATE POLICY "gift_card_movements_insert_authorized" ON "public"."gift_card_movements" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("gift_card_movements"."sede_id") AS "can_access_sede"));



CREATE POLICY "gift_card_movements_select_authorized" ON "public"."gift_card_movements" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("gift_card_movements"."sede_id") AS "can_access_sede"));



CREATE POLICY "gift_card_movements_update_authorized" ON "public"."gift_card_movements" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("gift_card_movements"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("gift_card_movements"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."gift_cards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gift_cards_delete_authorized" ON "public"."gift_cards" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("gift_cards"."sede_id") AS "can_access_sede"));



CREATE POLICY "gift_cards_insert_authorized" ON "public"."gift_cards" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("gift_cards"."sede_id") AS "can_access_sede"));



CREATE POLICY "gift_cards_select_authorized" ON "public"."gift_cards" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("gift_cards"."sede_id") AS "can_access_sede"));



CREATE POLICY "gift_cards_update_authorized" ON "public"."gift_cards" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("gift_cards"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("gift_cards"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_items_delete_authorized" ON "public"."inventory_items" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("inventory_items"."sede_id") AS "can_access_sede"));



CREATE POLICY "inventory_items_insert_authorized" ON "public"."inventory_items" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("inventory_items"."sede_id") AS "can_access_sede"));



CREATE POLICY "inventory_items_select_authorized" ON "public"."inventory_items" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("inventory_items"."sede_id") AS "can_access_sede"));



CREATE POLICY "inventory_items_update_authorized" ON "public"."inventory_items" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("inventory_items"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("inventory_items"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_delete_authorized" ON "public"."inventory_movements" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("inventory_movements"."sede_id") AS "can_access_sede"));



CREATE POLICY "inventory_movements_insert_authorized" ON "public"."inventory_movements" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("inventory_movements"."sede_id") AS "can_access_sede"));



CREATE POLICY "inventory_movements_select_authorized" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("inventory_movements"."sede_id") AS "can_access_sede"));



CREATE POLICY "inventory_movements_update_authorized" ON "public"."inventory_movements" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("inventory_movements"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("inventory_movements"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "packages_delete_authorized" ON "public"."packages" FOR DELETE TO "authenticated" USING ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = "packages"."student_id") AND ( SELECT "private"."can_access_sede"("s"."sede_id") AS "can_access_sede"))))));



CREATE POLICY "packages_insert_authorized" ON "public"."packages" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = "packages"."student_id") AND ( SELECT "private"."can_access_sede"("s"."sede_id") AS "can_access_sede"))))));



CREATE POLICY "packages_select_authorized" ON "public"."packages" FOR SELECT TO "authenticated" USING ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = "packages"."student_id") AND ( SELECT "private"."can_access_sede"("s"."sede_id") AS "can_access_sede"))))));



CREATE POLICY "packages_update_authorized" ON "public"."packages" FOR UPDATE TO "authenticated" USING ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = "packages"."student_id") AND ( SELECT "private"."can_access_sede"("s"."sede_id") AS "can_access_sede")))))) WITH CHECK ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = "packages"."student_id") AND ( SELECT "private"."can_access_sede"("s"."sede_id") AS "can_access_sede"))))));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_delete_authorized" ON "public"."payments" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("payments"."sede_id") AS "can_access_sede"));



CREATE POLICY "payments_insert_authorized" ON "public"."payments" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("payments"."sede_id") AS "can_access_sede"));



CREATE POLICY "payments_select_authorized" ON "public"."payments" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("payments"."sede_id") AS "can_access_sede"));



CREATE POLICY "payments_update_authorized" ON "public"."payments" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("payments"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("payments"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."pieces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pieces_delete_authorized" ON "public"."pieces" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("pieces"."sede_id") AS "can_access_sede"));



CREATE POLICY "pieces_insert_authorized" ON "public"."pieces" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("pieces"."sede_id") AS "can_access_sede"));



CREATE POLICY "pieces_select_authorized" ON "public"."pieces" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("pieces"."sede_id") AS "can_access_sede"));



CREATE POLICY "pieces_update_authorized" ON "public"."pieces" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("pieces"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("pieces"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_authorized" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "private"."is_super_admin"() AS "is_super_admin")));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."sede_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sede_members_delete_owner_or_super_admin" ON "public"."sede_members" FOR DELETE TO "authenticated" USING ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."sedes" "s"
  WHERE (("s"."id" = "sede_members"."sede_id") AND ("s"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "sede_members_insert_owner_or_super_admin" ON "public"."sede_members" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."sedes" "s"
  WHERE (("s"."id" = "sede_members"."sede_id") AND ("s"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "sede_members_select_authorized" ON "public"."sede_members" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."sedes" "s"
  WHERE (("s"."id" = "sede_members"."sede_id") AND ("s"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "sede_members_update_owner_or_super_admin" ON "public"."sede_members" FOR UPDATE TO "authenticated" USING ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."sedes" "s"
  WHERE (("s"."id" = "sede_members"."sede_id") AND ("s"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))))) WITH CHECK ((( SELECT "private"."is_super_admin"() AS "is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."sedes" "s"
  WHERE (("s"."id" = "sede_members"."sede_id") AND ("s"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."sedes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sedes_delete_super_admin" ON "public"."sedes" FOR DELETE TO "authenticated" USING (( SELECT "private"."is_super_admin"() AS "is_super_admin"));



CREATE POLICY "sedes_insert_super_admin" ON "public"."sedes" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."is_super_admin"() AS "is_super_admin"));



CREATE POLICY "sedes_select_authorized" ON "public"."sedes" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("sedes"."id") AS "can_access_sede"));



CREATE POLICY "sedes_update_owner_or_super_admin" ON "public"."sedes" FOR UPDATE TO "authenticated" USING ((("owner_id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "private"."is_super_admin"() AS "is_super_admin"))) WITH CHECK ((("owner_id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "private"."is_super_admin"() AS "is_super_admin")));



ALTER TABLE "public"."session_students" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "session_students_delete_authorized" ON "public"."session_students" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("session_students"."sede_id") AS "can_access_sede"));



CREATE POLICY "session_students_insert_authorized" ON "public"."session_students" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("session_students"."sede_id") AS "can_access_sede"));



CREATE POLICY "session_students_select_authorized" ON "public"."session_students" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("session_students"."sede_id") AS "can_access_sede"));



CREATE POLICY "session_students_update_authorized" ON "public"."session_students" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("session_students"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("session_students"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sessions_delete_authorized" ON "public"."sessions" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("sessions"."sede_id") AS "can_access_sede"));



CREATE POLICY "sessions_insert_authorized" ON "public"."sessions" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("sessions"."sede_id") AS "can_access_sede"));



CREATE POLICY "sessions_select_authorized" ON "public"."sessions" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("sessions"."sede_id") AS "can_access_sede"));



CREATE POLICY "sessions_update_authorized" ON "public"."sessions" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("sessions"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("sessions"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."student_assigned_classes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "student_assigned_classes_delete_authorized" ON "public"."student_assigned_classes" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("student_assigned_classes"."sede_id") AS "can_access_sede"));



CREATE POLICY "student_assigned_classes_insert_authorized" ON "public"."student_assigned_classes" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("student_assigned_classes"."sede_id") AS "can_access_sede"));



CREATE POLICY "student_assigned_classes_select_authorized" ON "public"."student_assigned_classes" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("student_assigned_classes"."sede_id") AS "can_access_sede"));



CREATE POLICY "student_assigned_classes_update_authorized" ON "public"."student_assigned_classes" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("student_assigned_classes"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("student_assigned_classes"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."students" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "students_delete_authorized" ON "public"."students" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("students"."sede_id") AS "can_access_sede"));



CREATE POLICY "students_insert_authorized" ON "public"."students" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("students"."sede_id") AS "can_access_sede"));



CREATE POLICY "students_select_authorized" ON "public"."students" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("students"."sede_id") AS "can_access_sede"));



CREATE POLICY "students_update_authorized" ON "public"."students" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("students"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("students"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."teachers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "teachers_delete_authorized" ON "public"."teachers" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("teachers"."sede_id") AS "can_access_sede"));



CREATE POLICY "teachers_insert_authorized" ON "public"."teachers" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("teachers"."sede_id") AS "can_access_sede"));



CREATE POLICY "teachers_select_authorized" ON "public"."teachers" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("teachers"."sede_id") AS "can_access_sede"));



CREATE POLICY "teachers_update_authorized" ON "public"."teachers" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("teachers"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("teachers"."sede_id") AS "can_access_sede"));



ALTER TABLE "public"."workshop_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workshop_schedules_delete_authorized" ON "public"."workshop_schedules" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_access_sede"("workshop_schedules"."sede_id") AS "can_access_sede"));



CREATE POLICY "workshop_schedules_insert_authorized" ON "public"."workshop_schedules" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_access_sede"("workshop_schedules"."sede_id") AS "can_access_sede"));



CREATE POLICY "workshop_schedules_select_authorized" ON "public"."workshop_schedules" FOR SELECT TO "authenticated" USING (( SELECT "private"."can_access_sede"("workshop_schedules"."sede_id") AS "can_access_sede"));



CREATE POLICY "workshop_schedules_update_authorized" ON "public"."workshop_schedules" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_access_sede"("workshop_schedules"."sede_id") AS "can_access_sede")) WITH CHECK (( SELECT "private"."can_access_sede"("workshop_schedules"."sede_id") AS "can_access_sede"));



GRANT USAGE ON SCHEMA "private" TO "authenticated";
GRANT USAGE ON SCHEMA "private" TO "service_role";



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "private"."can_access_sede"("target_sede_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "private"."can_access_sede"("target_sede_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "private"."current_sede_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."current_sede_id"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."current_sede_id"() TO "service_role";



GRANT ALL ON FUNCTION "private"."is_super_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."is_super_admin"() TO "service_role";



GRANT ALL ON FUNCTION "private"."user_sede_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."user_sede_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."assign_sede_id_on_insert"() FROM PUBLIC;



GRANT ALL ON TABLE "public"."gift_cards" TO "anon";
GRANT ALL ON TABLE "public"."gift_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."gift_cards" TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_gift_card"("p_gift_card_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_gift_card"("p_gift_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_gift_card"("p_gift_card_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_gift_card"("p_gift_card_id" "uuid", "p_consumed_at" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_gift_card"("p_gift_card_id" "uuid", "p_consumed_at" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."consume_gift_card"("p_gift_card_id" "uuid", "p_consumed_at" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_tenant_ids"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."ensure_gift_card_recipient_student_link"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."external_cancel_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."external_cancel_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."external_consume_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_consumed_at" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."external_consume_gift_card"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_consumed_at" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."external_redeem_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."external_redeem_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."external_reverse_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."external_reverse_gift_card_session"("p_sede_id" "uuid", "p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_owned_sede_id"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."get_owner_sede_id"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_super_admin"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."list_super_admins"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."redeem_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."redeem_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reverse_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reverse_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reverse_gift_card_session"("p_gift_card_id" "uuid", "p_session_id" "uuid", "p_student_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."student_lifecycle"("category" "text", "payment" "text", "legacy_status" "text", "due_date" "date", "manual_archive" "date", "as_of" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."student_lifecycle"("category" "text", "payment" "text", "legacy_status" "text", "due_date" "date", "manual_archive" "date", "as_of" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."student_lifecycle"("category" "text", "payment" "text", "legacy_status" "text", "due_date" "date", "manual_archive" "date", "as_of" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_session_capacity_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_session_capacity_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_session_capacity_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_session_student_capacity"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_session_student_capacity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_session_student_capacity"() TO "service_role";



GRANT ALL ON TABLE "public"."gift_card_movements" TO "anon";
GRANT ALL ON TABLE "public"."gift_card_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."gift_card_movements" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_items" TO "anon";
GRANT ALL ON TABLE "public"."inventory_items" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_items" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."packages" TO "anon";
GRANT ALL ON TABLE "public"."packages" TO "authenticated";
GRANT ALL ON TABLE "public"."packages" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."pieces" TO "anon";
GRANT ALL ON TABLE "public"."pieces" TO "authenticated";
GRANT ALL ON TABLE "public"."pieces" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."sede_members" TO "anon";
GRANT ALL ON TABLE "public"."sede_members" TO "authenticated";
GRANT ALL ON TABLE "public"."sede_members" TO "service_role";



GRANT ALL ON TABLE "public"."sedes" TO "anon";
GRANT ALL ON TABLE "public"."sedes" TO "authenticated";
GRANT ALL ON TABLE "public"."sedes" TO "service_role";



GRANT ALL ON TABLE "public"."session_students" TO "anon";
GRANT ALL ON TABLE "public"."session_students" TO "authenticated";
GRANT ALL ON TABLE "public"."session_students" TO "service_role";



GRANT ALL ON TABLE "public"."sessions" TO "anon";
GRANT ALL ON TABLE "public"."sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."sessions" TO "service_role";



GRANT ALL ON TABLE "public"."student_assigned_classes" TO "anon";
GRANT ALL ON TABLE "public"."student_assigned_classes" TO "authenticated";
GRANT ALL ON TABLE "public"."student_assigned_classes" TO "service_role";



GRANT ALL ON TABLE "public"."students" TO "anon";
GRANT ALL ON TABLE "public"."students" TO "authenticated";
GRANT ALL ON TABLE "public"."students" TO "service_role";



GRANT ALL ON TABLE "public"."students_with_lifecycle" TO "service_role";
GRANT SELECT ON TABLE "public"."students_with_lifecycle" TO "authenticated";



GRANT ALL ON TABLE "public"."teachers" TO "anon";
GRANT ALL ON TABLE "public"."teachers" TO "authenticated";
GRANT ALL ON TABLE "public"."teachers" TO "service_role";



GRANT ALL ON TABLE "public"."workshop_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."workshop_schedules" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
