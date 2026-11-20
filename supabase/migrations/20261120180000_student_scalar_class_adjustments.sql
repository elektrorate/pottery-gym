-- Manual +/- adjustments of a temporal / grupal / grupo_temporal class balance.
-- NOT APPLIED to any remote database by this change.
-- Attendance and absence debits keep using session_credit_movements and are not modified.
-- Membership balances stay on the attendance path; this function rejects them.
-- If this migration is not applied, the profile still saves the balance through the
-- existing student update and skips the reason row instead of failing.

create table if not exists public.student_scalar_class_adjustments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  sede_id uuid not null,
  expected_balance integer not null check (expected_balance >= 0),
  delta integer not null check (delta <> 0),
  resulting_balance integer not null check (resulting_balance >= 0),
  reason text not null check (reason ~ '[^[:space:]]' and length(reason) <= 200),
  adjusted_by uuid not null,
  adjusted_at timestamptz not null default now()
);

alter table public.student_scalar_class_adjustments enable row level security;

drop policy if exists scalar_class_adjustment_read on public.student_scalar_class_adjustments;
create policy scalar_class_adjustment_read on public.student_scalar_class_adjustments
  for select to authenticated
  using (auth.uid() is not null and private.can_access_sede(sede_id));

revoke all on public.student_scalar_class_adjustments from public, anon, authenticated;
grant select on public.student_scalar_class_adjustments to authenticated;

create or replace function private.adjust_student_scalar_classes(
  p_student_id uuid, p_expected integer, p_delta integer, p_reason text
) returns public.student_scalar_class_adjustments
language plpgsql security definer set search_path = '' as $$
declare
  st public.students;
  new_balance integer;
  receipt public.student_scalar_class_adjustments;
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select * into st from public.students where id = p_student_id for update;
  if st.id is null or st.sede_id is null or not private.can_access_sede(st.sede_id) then
    raise exception 'Student not accessible' using errcode = '42501';
  end if;
  if coalesce(st.student_category, 'membresia') not in ('temporal', 'grupal', 'grupo_temporal')
     or st.current_membership_period_id is not null then
    raise exception 'Membership balances are not adjusted here';
  end if;
  if p_delta is null or p_delta = 0 or p_expected is null or p_expected < 0
     or clean_reason !~ '[^[:space:]]' or length(clean_reason) > 200 then
    raise exception 'Expected balance, nonzero delta and a short reason are required';
  end if;
  if st.classes_remaining is distinct from p_expected then
    raise exception 'Stale class balance' using errcode = '40001';
  end if;
  new_balance := p_expected + p_delta;
  if new_balance < 0 or (st.bonos_asignados is not null and new_balance > st.bonos_asignados) then
    raise exception 'Class balance must remain between zero and the assigned pack';
  end if;
  update public.students set classes_remaining = new_balance where id = st.id;
  insert into public.student_scalar_class_adjustments(
    student_id, sede_id, expected_balance, delta, resulting_balance, reason, adjusted_by
  ) values (
    st.id, st.sede_id, p_expected, p_delta, new_balance, clean_reason, (select auth.uid())
  ) returning * into receipt;
  return receipt;
end $$;

create or replace function public.adjust_student_scalar_classes(
  p_student_id uuid, p_expected integer, p_delta integer, p_reason text
) returns public.student_scalar_class_adjustments
language sql security invoker set search_path = '' as $$
  select private.adjust_student_scalar_classes(p_student_id, p_expected, p_delta, p_reason);
$$;

revoke all on function private.adjust_student_scalar_classes(uuid, integer, integer, text),
  public.adjust_student_scalar_classes(uuid, integer, integer, text) from public, anon;
grant execute on function private.adjust_student_scalar_classes(uuid, integer, integer, text),
  public.adjust_student_scalar_classes(uuid, integer, integer, text) to authenticated;
