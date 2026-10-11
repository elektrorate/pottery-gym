-- Keep legacy payments unknown: do not manufacture payment records or change balances.
alter table public.students add column if not exists payment_status text
  check (payment_status in ('paid', 'pending'));

-- Date-derived lifecycle stays current even when nobody opens the application.
-- archived_at is reserved for an explicit archive; automatic expiry is reversible
-- by confirming payment and moving expiry_date forward.
create or replace function public.student_lifecycle(
  category text, payment text, legacy_status text, due_date date,
  manual_archive date, as_of date
) returns text
language sql immutable security invoker set search_path = ''
as $$
  select case
    when manual_archive is not null then 'archived'
    when category = 'temporal' then 'temporary'
    when due_date is not null and as_of - due_date >= 6 then 'archived'
    when due_date is null or due_date < as_of then 'pending'
    when coalesce(payment, case when legacy_status in ('membresia', 'active') then 'paid' else 'pending' end) <> 'paid' then 'pending'
    else 'active'
  end;
$$;

revoke all on function public.student_lifecycle(text,text,text,date,date,date) from public, anon;
grant execute on function public.student_lifecycle(text,text,text,date,date,date) to authenticated, service_role;

create or replace view public.students_with_lifecycle
with (security_invoker = true) as
select s.*, public.student_lifecycle(
  s.student_category, s.payment_status, s.status,
  (s.expiry_date at time zone 'UTC')::date, s.archived_at,
  (now() at time zone 'Europe/Madrid')::date
) as lifecycle_status
from public.students s;

revoke all on public.students_with_lifecycle from public, anon, authenticated;
grant select on public.students_with_lifecycle to authenticated, service_role;

comment on column public.students.payment_status is
  'Explicit payment confirmation; NULL means legacy payment not yet reviewed.';
comment on view public.students_with_lifecycle is
  'Current lifecycle in Europe/Madrid: active through payment due date, pending days 1-5, archived from day 6. Temporary students excluded from memberships; no balance-based archival.';
notify pgrst, 'reload schema';
