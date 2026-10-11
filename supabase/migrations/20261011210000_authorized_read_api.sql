-- Unapplied read-only pilot. Provisioning belongs to the database/backend owner,
-- not to app roles. No implicit grants, student self-service or autonomous writes.
create table private.domain_read_principals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  kind text not null check (kind in ('staff', 'integration')),
  enabled boolean not null default false,
  expires_at timestamptz not null check (isfinite(expires_at)),
  revoked_at timestamptz
);

create table private.domain_read_grants (
  user_id uuid not null references private.domain_read_principals(user_id) on delete cascade,
  sede_id uuid not null references public.sedes(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  operation text not null check (operation in ('student.summary.get', 'membership.status.get')),
  enabled boolean not null default false,
  expires_at timestamptz not null check (isfinite(expires_at)),
  revoked_at timestamptz,
  primary key (user_id, sede_id, student_id, operation)
);

alter table private.domain_read_principals enable row level security;
alter table private.domain_read_grants enable row level security;
revoke all on private.domain_read_principals, private.domain_read_grants
  from public, anon, authenticated, service_role;

-- A single stable statement snapshot checks the identity, tenant, resource and
-- capability before projecting allowlisted fields. Never reconcile on a read.
create function public.domain_read_v1(p_request jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  target_sede uuid;
  target_student uuid;
  requested_operation text;
  principal_kind text;
  student_category text;
  result_data jsonb;
  membership public.students_effective_membership;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;
  if p_request is null or jsonb_typeof(p_request) is distinct from 'object'
    or octet_length(p_request::text) > 4096 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  if not (p_request ?& array['version', 'operation', 'sedeId', 'studentId'])
    or (select count(*) from jsonb_object_keys(p_request)) <> 4
    or p_request->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_request->'operation') is distinct from 'string'
    or jsonb_typeof(p_request->'sedeId') is distinct from 'string'
    or jsonb_typeof(p_request->'studentId') is distinct from 'string' then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  requested_operation := p_request->>'operation';
  if requested_operation not in ('student.summary.get', 'membership.status.get')
    or p_request->>'sedeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_request->>'studentId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  target_sede := (p_request->>'sedeId')::uuid;
  target_student := (p_request->>'studentId')::uuid;

  select p.kind into principal_kind
  from private.domain_read_principals p
  join private.domain_read_grants g on g.user_id = p.user_id
  join public.sedes t on t.id = g.sede_id and t.is_active is true
  join public.students s on s.id = g.student_id and s.sede_id = g.sede_id
  where p.user_id = auth.uid() and p.enabled and p.revoked_at is null and p.expires_at > now()
    and g.enabled and g.revoked_at is null and g.expires_at > now()
    and g.sede_id = target_sede and g.student_id = target_student
    and g.operation = requested_operation;
  if not found then
    -- Missing resources and missing grants are indistinguishable to callers.
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  if principal_kind = 'staff' then
    if not exists (select 1 from public.profiles p where p.id = auth.uid()
      and p.role in ('super_admin', 'tallerista', 'staff'))
      or not private.can_access_sede(target_sede) then
      raise exception 'Forbidden' using errcode = '42501';
    end if;
  else
    -- Dedicated integration users must not also have broad application access.
    -- The sign-up trigger may create an unlinked tallerista profile; that alone
    -- is not an authorization grant. Metadata/JWT role claims are not app roles.
    if exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
      or exists (select 1 from public.sedes t where t.owner_id = auth.uid())
      or exists (select 1 from public.sede_members m where m.user_id = auth.uid()) then
      raise exception 'Forbidden' using errcode = '42501';
    end if;
  end if;

  select s.student_category into student_category from public.students s
    where s.id = target_student and s.sede_id = target_sede;
  if requested_operation = 'student.summary.get' then
    select jsonb_build_object('studentId', s.id, 'sedeId', s.sede_id,
      'category', s.student_category, 'archived', s.archived_at is not null)
    into result_data from public.students s
    where s.id = target_student and s.sede_id = target_sede;
  elsif coalesce(student_category, 'membresia') <> 'membresia' then
    result_data := 'null'::jsonb;
  else
    select e.* into membership from public.students_effective_membership e
      where e.student_id = target_student and e.sede_id = target_sede;
    if not found then raise exception 'Projection unavailable' using errcode = '55000'; end if;
    -- The existing view is an invoker view; inside this definer, validate both
    -- period links explicitly rather than inheriting the owner's RLS bypass.
    if (membership.materialized_period_id is not null and not exists (
        select 1 from public.student_membership_periods p
        where p.id = membership.materialized_period_id and p.student_id = target_student and p.sede_id = target_sede))
      or (membership.effective_period_id is not null and not exists (
        select 1 from public.student_membership_periods p
        where p.id = membership.effective_period_id and p.student_id = target_student and p.sede_id = target_sede)) then
      raise exception 'Forbidden' using errcode = '42501';
    end if;
    result_data := jsonb_build_object('studentId', target_student, 'sedeId', target_sede,
      'effectivePeriodId', membership.effective_period_id, 'tier', membership.membership_tier,
      'allocatedClasses', membership.allocated_classes, 'classesRemaining', membership.classes_remaining,
      'startsOn', membership.starts_on, 'endsOn', membership.ends_on,
      'paymentStatus', membership.payment_status);
  end if;
  return jsonb_build_object('version', 1, 'operation', requested_operation, 'data', result_data);
end $$;

revoke all on function public.domain_read_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.domain_read_v1(jsonb) to authenticated;
notify pgrst, 'reload schema';
