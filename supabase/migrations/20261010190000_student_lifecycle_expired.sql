-- Separate membership expiry from explicit administrative archival.
-- No student rows, payment records or historical migrations are changed.
create or replace function public.student_lifecycle(
  category text, payment text, legacy_status text, due_date date,
  manual_archive date, as_of date
) returns text
language sql immutable security invoker set search_path = ''
as $$
  select case
    when manual_archive is not null then 'archived'
    when category = 'temporal' then 'temporary'
    when due_date is not null and as_of - due_date >= 6 then 'expired'
    when due_date is null or due_date < as_of then 'pending'
    when coalesce(payment, case when legacy_status in ('membresia', 'active') then 'paid' else 'pending' end) <> 'paid' then 'pending'
    else 'active'
  end;
$$;

-- The existing security-invoker view calls this function dynamically.
-- Preserve its columns and grants; no replacement or data rewrite is needed.
comment on function public.student_lifecycle(text,text,text,date,date,date) is
  'Independent membership/payment/archive lifecycle: only manual_archive archives a person. Renewal does not confirm payment or clear archive.';
comment on view public.students_with_lifecycle is
  'Current lifecycle in Europe/Madrid: paid memberships active through expiry, pending days 1-5, expired from day 6. Only archived_at means archived; temporary students remain temporary unless explicitly archived.';
comment on column public.students.archived_at is
  'Explicit administrative archive date; cleared only by manual reactivation, independently of membership renewal and payment confirmation.';
notify pgrst, 'reload schema';
