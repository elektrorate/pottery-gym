import type { ClassSession, SessionBusinessState } from '../types';

export const attachSessionBusinessState = (session: ClassSession, rows: any[]): ClassSession => {
  if (![1, 2].includes(session.attendancePolicyVersion || 0)) throw new Error('Version de politica de sesion desconocida. Actualiza el backend.');
  const state: Record<string, SessionBusinessState> = {};
  const roster = new Set(session.studentIds || []);
  for (const row of rows) {
    if (row.session_id !== session.id || row.sede_id !== session.sedeId || !roster.has(row.student_id)
      || row.policy_version !== session.attendancePolicyVersion || state[row.student_id]
      || !['reserved', 'cancelled'].includes(row.reservation_state)
      || !['unfinalized', 'charged', 'no_charge', 'incident', 'waived'].includes(row.billing_state)) {
      throw new Error('El estado de negocio no coincide con la sesion y su roster.');
    }
    state[row.student_id] = {
      reservationState: row.reservation_state, cancelledAt: row.cancelled_at ?? undefined,
      cancellationKind: row.cancellation_kind ?? undefined, cancellationReason: row.cancellation_reason ?? undefined,
      cancelledBy: row.cancelled_by ?? undefined, exceptionId: row.exception_id ?? undefined,
      exceptionKind: row.exception_kind ?? undefined, exceptionPeriodId: row.exception_period_id ?? undefined,
      exceptionGiftCardId: row.exception_gift_card_id ?? undefined, exceptionReason: row.exception_reason ?? undefined,
      approvedBy: row.approved_by ?? undefined, approvedAt: row.approved_at ?? undefined,
      billingState: row.billing_state, billingKind: row.billing_kind ?? undefined,
      billingDebitId: row.billing_debit_id ?? undefined, fundingPeriodId: row.funding_period_id ?? undefined,
      fundingGiftCardId: row.funding_gift_card_id ?? undefined, finalizedRevision: row.finalized_revision ?? undefined,
      fundingManualCreditId: row.funding_manual_credit_id ?? undefined,
      exceptionManualCreditId: row.exception_manual_credit_id ?? undefined,
      penaltyManualCreditId: row.penalty_manual_credit_id ?? undefined,
      settlementId: row.settlement_id ?? undefined, settlementDebitId: row.settlement_debit_id ?? undefined,
      settlementReason: row.settlement_reason ?? undefined, settledBy: row.settled_by ?? undefined,
      settledAt: row.settled_at ?? undefined, settlementRevision: row.settlement_revision ?? undefined,
      penaltyId: row.penalty_id ?? undefined, penaltyState: row.penalty_state ?? undefined,
      penaltyReason: row.penalty_reason ?? undefined, waiverReason: row.waiver_reason ?? undefined,
      waivedBy: row.waived_by ?? undefined, waivedAt: row.waived_at ?? undefined
    };
  }
  if (Object.keys(state).length !== roster.size) throw new Error('Falta la proyeccion de negocio de un alumno. Recarga la sesion.');
  return { ...session, businessStateByStudentId: state };
};
