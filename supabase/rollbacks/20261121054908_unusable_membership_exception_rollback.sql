-- Rollback for 20261121054908_unusable_membership_exception.sql
-- Restores the previous funding and approval functions. Does not change rows,
-- balances, periods, or attendance. Run only on a database that has applied
-- the forward migration, as the function owner (the migration role).
-- Not applied by the migration runner.

begin;

alter function private.session_business_action(uuid, uuid, uuid, bigint, text, text, text)
  rename to session_business_action_unusable_wrapper;
alter function private.session_business_action_before_unusable_exception(uuid, uuid, uuid, bigint, text, text, text)
  rename to session_business_action;

create or replace function public.approve_session_exception(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint, p_kind text, p_reason text
) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'approve_session_exception', p_kind, p_reason);
$$;
create or replace function public.cancel_session_reservation(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint, p_reason text
) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'cancel_session_reservation', null, p_reason);
$$;
create or replace function public.waive_session_penalty(
  p_session_id uuid, p_student_id uuid, p_request_key uuid, p_expected_revision bigint, p_reason text
) returns jsonb
language sql security definer set search_path = '' as $$
  select private.session_business_action(p_session_id, p_student_id, p_request_key, p_expected_revision, 'waive_session_penalty', null, p_reason);
$$;

drop function private.session_business_action_unusable_wrapper(uuid, uuid, uuid, bigint, text, text, text);

alter function private.session_business_funding(uuid, uuid)
  rename to session_business_funding_unusable_wrapper;
alter function private.session_business_funding_before_unusable_exception(uuid, uuid)
  rename to session_business_funding;
drop function private.session_business_funding_unusable_wrapper(uuid, uuid);

revoke all on function private.session_business_funding(uuid, uuid),
  private.session_business_action(uuid, uuid, uuid, bigint, text, text, text)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
