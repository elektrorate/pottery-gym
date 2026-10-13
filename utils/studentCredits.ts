import type { ClassSession, GiftCard, ManualCreditEntitlement, PendingStudentPenalty, Student } from '../types';
import { getWorkshopDate } from './studentLifecycle';
import { getSessionFundingActivity } from './sessionBusiness';

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const nullableIdentifier = (value: unknown) => value === null || identifier(value);
const integer = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};
const dateKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !dateKey(value.slice(0, 10))) return false;
  return /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
};
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= limit;
const covers = (start: unknown, end: unknown, today: string, incidentDate: string) =>
  dateKey(start) && dateKey(end) && start <= today && start <= incidentDate && end >= today && end >= incidentDate;
const mismatch = () => new Error('La proyeccion de creditos no coincide con el alumno, la sede o la sesion. Recarga los datos.');

export const attachStudentCreditProfiles = (
  students: Student[], rows: any[], sessions: ClassSession[], giftCards: GiftCard[], today = getWorkshopDate()
): Student[] => {
  if (!dateKey(today) || !Array.isArray(students) || !Array.isArray(rows)
    || !Array.isArray(sessions) || !Array.isArray(giftCards) || rows.length !== students.length) throw mismatch();
  const loaded = new Map<string, Student>();
  for (const student of students) {
    if (!record(student) || !identifier(student.id) || !identifier(student.sedeId) || loaded.has(student.id)
      || !(student.legacyManualBalance === null
        || (typeof student.legacyManualBalance === 'number' && Number.isSafeInteger(student.legacyManualBalance)))) throw mismatch();
    loaded.set(student.id, student);
  }
  const profiles = new Map<string, any>();
  for (const row of rows) {
    if (!record(row)) throw mismatch();
    const student = loaded.get(row.student_id);
    const raw = row.legacy_raw_state;
    const balance = row.legacy_observed_balance === null ? null : integer(row.legacy_observed_balance);
    if (!student || row.sede_id !== student.sedeId || profiles.has(row.student_id)
      || !record(raw) || raw.id !== student.id || raw.sede_id !== student.sedeId
      || balance === undefined || balance !== student.legacyManualBalance
      || (raw.classes_remaining === null ? null : integer(raw.classes_remaining)) !== balance
      || !nullableIdentifier(raw.current_membership_period_id)
      || !Array.isArray(row.manual_credits) || !Array.isArray(row.penalty_incidents)
      || typeof row.can_reconcile_legacy !== 'boolean' || typeof row.can_approve_manual_credit !== 'boolean') throw mismatch();
    profiles.set(student.id, row);
  }
  const creditIds = new Set<string>();
  const penaltyIds = new Set<string>();
  const incidentKeys = new Set<string>();
  return students.map(student => {
    const profile = profiles.get(student.id);
    const raw = profile.legacy_raw_state;
    const manualCredits: ManualCreditEntitlement[] = profile.manual_credits.map((credit: any) => {
      if (!record(credit)) throw mismatch();
      const quantity = integer(credit.quantity);
      const remaining = integer(credit.remaining_classes);
      if (!identifier(credit.entitlement_id) || creditIds.has(credit.entitlement_id)
        || credit.student_id !== student.id || credit.sede_id !== student.sedeId
        || !['reconcile_legacy', 'new_manual'].includes(credit.mode)
        || !['mesa', 'torno', 'coworking', 'workshop', 'privada'].includes(credit.activity)
        || quantity === undefined || quantity <= 0 || remaining === undefined || remaining < 0 || remaining > quantity
        || !dateKey(credit.starts_on) || !dateKey(credit.ends_on) || credit.ends_on < credit.starts_on
        || !text(credit.reason, 2000) || !text(credit.evidence, 10000)
        || !identifier(credit.approved_by) || !timestamp(credit.approved_at)) throw mismatch();
      creditIds.add(credit.entitlement_id);
      return { id: credit.entitlement_id, studentId: credit.student_id, sedeId: credit.sede_id,
        mode: credit.mode, activity: credit.activity, allocatedClasses: quantity, remainingClasses: remaining,
        startsOn: credit.starts_on, endsOn: credit.ends_on, reason: credit.reason, evidence: credit.evidence,
        approvedBy: credit.approved_by, approvedAt: credit.approved_at };
    });
    if (manualCredits.filter(credit => credit.mode === 'reconcile_legacy').length > 1
      || (profile.can_reconcile_legacy && (student.legacyManualBalance === null || student.legacyManualBalance! <= 0
        || (raw.student_category ?? 'membresia') === 'membresia' || raw.current_membership_period_id !== null
        || student.effectivePeriodId || student.materializedPeriodId || student.membershipPeriods?.length
        || manualCredits.some(credit => credit.mode === 'reconcile_legacy')))) throw mismatch();

    const pendingPenalties: PendingStudentPenalty[] = profile.penalty_incidents.map((incident: any) => {
      if (!record(incident)) throw mismatch();
      const revision = integer(incident.expected_revision);
      const incidentRevision = integer(incident.incident_revision);
      const matches = sessions.filter(session => session.id === incident.session_id);
      const session = matches[0];
      const key = JSON.stringify([student.id, incident.session_id]);
      if (!identifier(incident.penalty_id) || penaltyIds.has(incident.penalty_id) || incidentKeys.has(key)
        || incident.student_id !== student.id || incident.sede_id !== student.sedeId
        || !identifier(incident.session_id) || matches.length !== 1 || session.sedeId !== student.sedeId
        || !Array.isArray(session.studentIds) || session.studentIds.filter(id => id === student.id).length !== 1
        || !dateKey(session.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(session.startTime)
        || typeof session.revision !== 'number' || !Number.isSafeInteger(session.revision)
        || revision === undefined || revision < 0 || revision !== session.revision
        || incidentRevision === undefined || incidentRevision < 0 || incidentRevision > revision
        || !['no_show', 'late_cancellation'].includes(incident.kind)
        || !['pending', 'charged', 'waived'].includes(incident.penalty_state)
        || typeof incident.is_pending !== 'boolean' || incident.is_pending !== (incident.penalty_state === 'pending')
        || typeof incident.is_waived !== 'boolean' || incident.is_waived !== (incident.penalty_state === 'waived')
        || !nullableIdentifier(incident.original_period_id) || !nullableIdentifier(incident.original_gift_card_id)
        || !nullableIdentifier(incident.original_manual_credit_id) || !text(incident.incident_reason, 2000)
        || (incident.original_penalty_state !== undefined && !['pending', 'charged'].includes(incident.original_penalty_state))
        || (incident.billing_state !== undefined && incident.billing_state !==
          ({ pending: 'incident', charged: 'charged', waived: 'waived' }[incident.penalty_state]))) throw mismatch();
      penaltyIds.add(incident.penalty_id);
      incidentKeys.add(key);

      const settlementRevision = incident.settlement_revision == null ? undefined : integer(incident.settlement_revision);
      const hasSettlement = incident.settlement_id != null;
      if (hasSettlement ? (!identifier(incident.settlement_id) || incident.is_pending
        || !text(incident.settlement_reason, 2000) || !identifier(incident.settled_by) || !timestamp(incident.settled_at)
        || settlementRevision === undefined || settlementRevision <= incidentRevision || settlementRevision > revision)
        : [incident.settlement_reason, incident.settled_by, incident.settled_at, incident.settlement_revision]
          .some(value => value != null)) throw mismatch();

      const business = session.businessStateByStudentId?.[student.id];
      if (session.businessStateByStudentId !== undefined && (!record(business)
        || business.penaltyId !== incident.penalty_id || business.penaltyState !== incident.penalty_state
        || business.billingState !== ({ pending: 'incident', charged: 'charged', waived: 'waived' }[incident.penalty_state])
        || business.billingKind !== incident.kind
        || (business.finalizedRevision !== undefined && (integer(business.finalizedRevision) === undefined
          || business.finalizedRevision < 0 || business.finalizedRevision > incidentRevision))
        || (business.settlementId ?? null) !== (incident.settlement_id ?? null)
        || (business.settlementReason ?? null) !== (incident.settlement_reason ?? null)
        || (business.settledBy ?? null) !== (incident.settled_by ?? null)
        || (business.settledAt ?? null) !== (incident.settled_at ?? null)
        || (business.settlementRevision == null ? undefined : integer(business.settlementRevision)) !== settlementRevision)) throw mismatch();

      const periodId = incident.original_period_id ?? undefined;
      const giftId = incident.original_gift_card_id ?? undefined;
      const manualId = incident.original_manual_credit_id ?? undefined;
      const sources = [periodId, giftId, manualId].filter(Boolean);
      const activity = getSessionFundingActivity(session, student.id, student.sedeId);
      // Availability is only a local UI hint. The owner RPC rechecks identity, ledgers and revision.
      let canSettle = incident.is_pending && session.attendancePolicyVersion === 2 && timestamp(session.completedAt)
        && !student.archivedAt && raw.archived_at == null && sources.length === 1 && !!business
        && (business.fundingPeriodId ?? undefined) === periodId
        && (business.fundingGiftCardId ?? undefined) === giftId
        && (business.fundingManualCreditId ?? undefined) === manualId
        && (session.giftCardIdByStudentId?.[student.id] ?? undefined) === giftId
        && (session.manualCreditIdByStudentId?.[student.id] ?? undefined) === manualId
        && !business.billingDebitId && !business.settlementDebitId
        && (session.classType !== 'mixto' || activity !== undefined);
      if (canSettle && periodId) {
        const periods = student.membershipPeriods || [];
        const originals = periods.filter(period => period.id === periodId);
        const period = originals[0];
        const allocation = period && integer(period.allocatedClasses);
        // The raw materialized budget belongs to this period, not a due projected successor.
        canSettle = originals.length === 1 && period.studentId === student.id
          && (raw.student_category ?? 'membresia') === 'membresia'
          && raw.current_membership_period_id === periodId && student.materializedPeriodId === periodId
          && student.effectivePeriodId === periodId && period.paymentStatus === 'paid'
          && student.legacyManualBalance !== null && student.legacyManualBalance! > 0
          && allocation !== undefined && allocation > 0 && student.legacyManualBalance! <= allocation
          && covers(period.startsOn, period.endsOn, today, session.date)
          && !periods.some(candidate => candidate.predecessorId === periodId
            && (!dateKey(candidate.startsOn) || candidate.startsOn <= today));
      } else if (canSettle && giftId) {
        const originals = giftCards.filter(card => card.id === giftId);
        const card = originals[0];
        const cardSede = (card as (GiftCard & { sedeId?: string }) | undefined)?.sedeId;
        const allocation = card && integer(card.numClasses);
        const used = card && integer(card.sessionsUsed);
        const remaining = card && integer(card.sessionsRemaining);
        canSettle = originals.length === 1 && card.recipientStudentId === student.id
          && (session.classType === 'mixto' ? cardSede === student.sedeId : cardSede === undefined || cardSede === student.sedeId)
          && card.paymentStatus === 'paid'
          && ['active', 'pending'].includes(card.status || '')
          && (card.type === 'torno' ? 'torno' : card.type === 'modelado' ? 'mesa' : undefined) === activity
          && allocation !== undefined && allocation > 0 && used !== undefined && used >= 0 && used < allocation
          && remaining !== undefined && remaining > 0 && remaining === allocation - used
          && covers(card.activatedAt, card.expiryDate, today, session.date);
      } else if (canSettle && manualId) {
        const credit = manualCredits.find(candidate => candidate.id === manualId);
        canSettle = !!credit && credit.remainingClasses > 0 && credit.activity === activity
          && covers(credit.startsOn, credit.endsOn, today, session.date);
      }
      return { id: incident.penalty_id, studentId: student.id, sedeId: student.sedeId!, sessionId: session.id,
        sessionDate: session.date, sessionStart: session.startTime, sessionRevision: session.revision,
        kind: incident.kind, state: incident.penalty_state, originalPeriodId: periodId, originalGiftCardId: giftId,
        originalManualCreditId: manualId, reason: incident.incident_reason, canSettle,
        blockedReason: canSettle ? undefined : incident.penalty_state === 'pending'
          ? 'El derecho original no es utilizable. No se permite sustituirlo por otro credito o periodo.'
          : 'La incidencia ya esta resuelta; no se puede descontar de nuevo.',
        settlementId: incident.settlement_id ?? undefined, settlementReason: incident.settlement_reason ?? undefined,
        settledBy: incident.settled_by ?? undefined, settledAt: incident.settled_at ?? undefined };
    });
    return { ...student, manualCredits, pendingPenalties, canReconcileLegacy: profile.can_reconcile_legacy };
  });
};
