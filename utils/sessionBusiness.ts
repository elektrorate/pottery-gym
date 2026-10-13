import type { CapacityActivity, ClassSession, SessionBusinessState } from '../types';

const activities = ['mesa', 'torno', 'coworking', 'workshop', 'privada'];

// A mixed parent is never a funding activity. Use only the verified, ID-bound source.
export const getSessionFundingActivity = (session: ClassSession, studentId: string, studentSedeId?: string): CapacityActivity | undefined => {
  if (session.classType !== 'mixto') return activities.includes(session.classType) ? session.classType as CapacityActivity : undefined;
  const business = session.businessStateByStudentId?.[studentId];
  const blocks = session.activityBlocks || [];
  const assigned = blocks.filter(block => block.studentIds.includes(studentId));
  const block = assigned[0];
  if (!session.sedeId || studentSedeId !== session.sedeId || !session.studentIds?.includes(studentId)
    || business?.activitySourceVerified !== true || !business.fundingActivityBlockId
    || !activities.includes(business.fundingActivityType || '') || assigned.length !== 1
    || !block?.id || block.id !== business.fundingActivityBlockId || block.activityType !== business.fundingActivityType
    || blocks.filter(candidate => candidate.id === block.id).length !== 1
    || block.studentIds.filter(id => id === studentId).length !== 1
    || (block.teacherId ?? undefined) !== business.activityTeacherId
    || !Number.isSafeInteger(block.capacity) || block.capacity < 1 || block.capacity > 100
    || block.capacity !== business.activityCapacity) return undefined;
  return business.fundingActivityType;
};

export const attachSessionBusinessState = (session: ClassSession, rows: any[]): ClassSession => {
  if (![1, 2].includes(session.attendancePolicyVersion || 0)) throw new Error('Version de politica de sesion desconocida. Actualiza el backend.');
  const state: Record<string, SessionBusinessState> = {};
  const roster = new Set(session.studentIds || []);
  for (const row of rows) {
    if (row.session_id !== session.id || row.sede_id !== session.sedeId || !roster.has(row.student_id)
      || row.policy_version !== session.attendancePolicyVersion || state[row.student_id]
      || !['reserved', 'cancelled'].includes(row.reservation_state)
      || !['unfinalized', 'charged', 'no_charge', 'incident', 'waived'].includes(row.billing_state)
      || (row.funding_activity_type != null && !activities.includes(row.funding_activity_type))
      || (row.activity_source_verified !== undefined && typeof row.activity_source_verified !== 'boolean')
      || (row.funding_activity_block_id != null && (typeof row.funding_activity_block_id !== 'string' || !row.funding_activity_block_id))
      || (row.activity_teacher_id != null && (typeof row.activity_teacher_id !== 'string' || !row.activity_teacher_id))
      || (row.activity_capacity != null && (!Number.isSafeInteger(row.activity_capacity) || row.activity_capacity < 1 || row.activity_capacity > 100))) {
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
      fundingActivityType: row.funding_activity_type ?? undefined,
      fundingActivityBlockId: row.funding_activity_block_id ?? undefined,
      activityTeacherId: row.activity_teacher_id ?? undefined,
      activityCapacity: row.activity_capacity ?? undefined,
      activitySourceVerified: row.activity_source_verified,
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
