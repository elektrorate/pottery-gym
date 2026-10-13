-- Evaluate the JWT identity once per statement instead of once per row.
-- This preserves the policy predicates while removing the auth_rls_initplan
-- bottleneck from the historical receipt/credit and membership projections.
drop policy if exists gift_card_receipts_read on public.gift_card_operation_receipts;
create policy gift_card_receipts_read on public.gift_card_operation_receipts
  for select to authenticated
  using ((select auth.uid()) is not null and private.can_access_sede(sede_id));

drop policy if exists session_receipts_read on public.session_operation_receipts;
create policy session_receipts_read on public.session_operation_receipts
  for select to authenticated
  using ((select auth.uid()) is not null and private.can_access_sede(sede_id));

drop policy if exists session_credit_read on public.session_credit_movements;
create policy session_credit_read on public.session_credit_movements
  for select to authenticated
  using ((select auth.uid()) is not null and private.can_access_sede(sede_id));

drop policy if exists membership_period_read on public.student_membership_periods;
create policy membership_period_read on public.student_membership_periods
  for select to authenticated
  using ((select auth.uid()) is not null and private.can_access_sede(sede_id));

drop policy if exists membership_adjustment_read on public.student_membership_class_adjustments;
create policy membership_adjustment_read on public.student_membership_class_adjustments
  for select to authenticated
  using ((select auth.uid()) is not null and private.can_access_sede(sede_id));
