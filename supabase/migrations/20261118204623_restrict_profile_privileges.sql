-- Remove table-wide AND stale column grants; RLS still controls visible rows.
REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
DO $block$
DECLARE col record;
BEGIN
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%I) ON TABLE public.profiles FROM PUBLIC, anon, authenticated', col.attname);
  END LOOP;
END;
$block$;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (full_name, phone, avatar_url) ON TABLE public.profiles TO authenticated;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Defense in depth if a later migration accidentally restores broad UPDATE.
CREATE OR REPLACE FUNCTION private.guard_profile_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF current_user IN ('anon','authenticated') AND
     (to_jsonb(NEW) - ARRAY['full_name','phone','avatar_url','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['full_name','phone','avatar_url','updated_at']) THEN
    RAISE EXCEPTION 'Protected profile fields cannot be changed by the client' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.guard_profile_fields() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_profile_fields ON public.profiles;
CREATE TRIGGER guard_profile_fields BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.guard_profile_fields();
NOTIFY pgrst, 'reload schema';
