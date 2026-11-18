-- JWT assurance is supplied by Auth, never by editable user metadata.
CREATE OR REPLACE FUNCTION public.security_has_aal2()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL AND coalesce((SELECT auth.jwt()->>'aal') = 'aal2', false);
$function$;
REVOKE ALL ON FUNCTION public.security_has_aal2() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.security_has_aal2() TO authenticated, service_role;
CREATE OR REPLACE FUNCTION private.is_super_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
 SELECT (SELECT auth.uid()) IS NOT NULL AND (SELECT public.security_has_aal2())
 AND EXISTS(SELECT 1 FROM public.profiles WHERE id=(SELECT auth.uid()) AND role='super_admin'::public.user_role);
$function$;
REVOKE ALL ON FUNCTION private.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_super_admin() TO authenticated;
-- Protect workshop configuration and team membership even through direct REST.
DO $block$
DECLARE tab text; operation text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['sedes','sede_members'] LOOP
  FOREACH operation IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I','mfa_'||lower(operation),tab);
   IF operation='INSERT' THEN
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK ((SELECT public.security_has_aal2()))','mfa_insert',tab);
   ELSIF operation='DELETE' THEN
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING ((SELECT public.security_has_aal2()))','mfa_delete',tab);
   ELSE
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING ((SELECT public.security_has_aal2())) WITH CHECK ((SELECT public.security_has_aal2()))','mfa_update',tab);
   END IF;
  END LOOP;
 END LOOP;
END;
$block$;
NOTIFY pgrst, 'reload schema';
