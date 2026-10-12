import { expect, test } from '@playwright/test';
import type { ClassSession, GiftCard, Student } from '../../types';
import { attachStudentCreditProfiles } from '../../utils/studentCredits';
import { getWorkshopDate, joinStudentMemberships, mapStudentRowToModel } from '../../utils/studentLifecycle';

const today = '2026-10-12';
const rawStudent = { id: 'student', sede_id: 'sede', name: 'Alex', phone: '111', student_category: 'temporal',
  classes_remaining: 7, payment_status: null, current_membership_period_id: null, archived_at: null,
  status: 'new', price: 90, expiry_date: '2026-10-31', bonos_asignados: 4, notes: 'Raw history' };
const manual = { entitlement_id: 'manual', student_id: 'student', sede_id: 'sede', mode: 'new_manual',
  quantity: 4, remaining_classes: '3', activity: 'mesa', starts_on: '2026-10-01', ends_on: '2026-10-31',
  reason: 'Explicit approval', evidence: 'Original evidence', approved_by: 'owner', approved_at: '2026-10-01T12:00:00+00:00' };
const incident = { penalty_id: 'penalty', student_id: 'student', sede_id: 'sede', session_id: 'session',
  expected_revision: '7', incident_revision: '5', kind: 'no_show', penalty_state: 'pending',
  original_penalty_state: 'pending', billing_state: 'incident', original_period_id: null,
  original_gift_card_id: null, original_manual_credit_id: 'manual', incident_reason: 'Original incident reason',
  is_pending: true, is_waived: false, settlement_id: null, settlement_reason: null, settled_by: null,
  settled_at: null, settlement_revision: null };
const session: ClassSession = { id: 'session', sedeId: 'sede', revision: 7, attendancePolicyVersion: 2,
  date: '2026-10-11', startTime: '18:00', endTime: '20:00', classType: 'mesa', students: ['Alex'],
  studentIds: ['student'], completedAt: '2026-10-11T20:00:00Z', manualCreditIdByStudentId: { student: 'manual' },
  businessStateByStudentId: { student: { reservationState: 'reserved', billingState: 'incident',
    billingKind: 'no_show', penaltyId: 'penalty', penaltyState: 'pending', fundingManualCreditId: 'manual', finalizedRevision: 5 } } };
const gift: GiftCard = { id: 'gift', buyer: 'Buyer', recipient: 'Alex', recipientStudentId: 'student',
  numClasses: 4, sessionsUsed: 1, sessionsRemaining: 3, type: 'modelado', paymentStatus: 'paid', status: 'active',
  activatedAt: '2026-10-01', expiryDate: '2026-10-31', createdAt: '2026-10-01T12:00:00Z' };
const fixture = () => {
  const students = [mapStudentRowToModel(structuredClone(rawStudent))];
  const rows = [{ student_id: 'student', sede_id: 'sede', legacy_observed_balance: 7,
    legacy_raw_state: structuredClone(rawStudent), manual_credits: [structuredClone(manual)],
    penalty_incidents: [structuredClone(incident)], can_approve_manual_credit: true, can_reconcile_legacy: true }];
  return { students, rows, sessions: [structuredClone(session)], giftCards: [] as GiftCard[] };
};
type Fixture = ReturnType<typeof fixture>;
const project = (data: Fixture, date = today) => attachStudentCreditProfiles(data.students, data.rows, data.sessions, data.giftCards, date);
const asGift = (data = fixture()) => {
  data.rows[0].penalty_incidents[0].original_manual_credit_id = null;
  data.rows[0].penalty_incidents[0].original_gift_card_id = gift.id;
  data.sessions[0].manualCreditIdByStudentId = {};
  data.sessions[0].giftCardIdByStudentId = { student: gift.id };
  const business = data.sessions[0].businessStateByStudentId!.student;
  delete business.fundingManualCreditId;
  business.fundingGiftCardId = gift.id;
  data.giftCards = [structuredClone(gift)];
  return data;
};
const asMembership = () => {
  const data = fixture();
  const raw = { ...rawStudent, student_category: 'membresia', current_membership_period_id: 'period', classes_remaining: 2 };
  const period = { id: 'period', student_id: 'student', sede_id: 'sede', allocated_classes: 4,
    starts_on: '2026-10-01', ends_on: '2026-10-31', payment_status: 'paid' };
  data.students = joinStudentMemberships([raw], [{ student_id: 'student', sede_id: 'sede',
    materialized_period_id: 'period', effective_period_id: 'period', allocated_classes: 4, classes_remaining: 99,
    payment_status: 'paid', starts_on: '2026-10-01', ends_on: '2026-10-31' }], [period]);
  Object.assign(data.rows[0], { legacy_raw_state: raw, legacy_observed_balance: 2, can_reconcile_legacy: false });
  Object.assign(data.rows[0].penalty_incidents[0], { original_manual_credit_id: null, original_period_id: 'period' });
  data.sessions[0].manualCreditIdByStudentId = {};
  const business = data.sessions[0].businessStateByStudentId!.student;
  delete business.fundingManualCreditId;
  business.fundingPeriodId = 'period';
  return data;
};
const blocked = (data: Fixture) => {
  const penalty = project(data)[0].pendingPenalties![0];
  expect(penalty.canSettle).toBe(false);
  expect(penalty.blockedReason).toContain('No se permite sustituirlo');
};

test('attaches immutable manual rights and exact incident session identity without changing the student budget or payment', () => {
  const data = fixture();
  const snapshot = structuredClone(data);
  const [result] = project(data);
  expect(data).toEqual(snapshot);
  expect(result).not.toBe(data.students[0]);
  const { manualCredits, pendingPenalties, canReconcileLegacy, ...unchanged } = result;
  expect(unchanged).toEqual(data.students[0]);
  expect(canReconcileLegacy).toBe(true);
  expect(manualCredits).toEqual([{ id: 'manual', studentId: 'student', sedeId: 'sede', mode: 'new_manual', activity: 'mesa',
    allocatedClasses: 4, remainingClasses: 3, startsOn: '2026-10-01', endsOn: '2026-10-31', reason: manual.reason,
    evidence: manual.evidence, approvedBy: manual.approved_by, approvedAt: manual.approved_at }]);
  expect(pendingPenalties![0]).toMatchObject({ id: 'penalty', studentId: 'student', sedeId: 'sede', sessionId: 'session',
    sessionDate: '2026-10-11', sessionStart: '18:00', sessionRevision: 7, kind: 'no_show', state: 'pending',
    originalManualCreditId: 'manual', reason: incident.incident_reason, canSettle: true });
  expect(result).not.toHaveProperty('canApproveManualCredit');
});

test('NULL raw observations remain unknown while a separately approved manual right is usable', () => {
  const data = fixture();
  data.students = [mapStudentRowToModel({ ...rawStudent, classes_remaining: null })];
  Object.assign(data.rows[0], { legacy_observed_balance: null, can_reconcile_legacy: false });
  data.rows[0].legacy_raw_state.classes_remaining = null;
  const [result] = project(data);
  expect(result).toMatchObject({ classesRemaining: 0, legacyManualBalance: null, paymentStatus: null, canReconcileLegacy: false });
  expect(result.manualCredits![0].remainingClasses).toBe(3);
  expect(result.pendingPenalties![0].canSettle).toBe(true);
  data.rows[0].legacy_observed_balance = 0;
  expect(() => project(data)).toThrow();
});

test('raw membership budget, not a different projected balance, determines original-period availability', () => {
  const data = asMembership();
  expect(project(data)[0]).toMatchObject({ classesRemaining: 99, legacyManualBalance: 2, canReconcileLegacy: false });
  expect(project(data)[0].pendingPenalties![0].canSettle).toBe(true);
  for (const balance of [0, null, 5]) {
    data.students[0].legacyManualBalance = balance;
    data.rows[0].legacy_observed_balance = balance;
    data.rows[0].legacy_raw_state.classes_remaining = balance;
    blocked(data);
  }
  data.rows[0].legacy_observed_balance = 99;
  expect(() => project(data)).toThrow();
});

test('profiles join only by student and sede IDs, preserving order even for homonyms', () => {
  const data = fixture();
  const other = mapStudentRowToModel({ ...rawStudent, id: 'other', sede_id: 'other-sede', phone: '222' });
  data.students.push(other);
  data.rows.unshift({ ...structuredClone(data.rows[0]), student_id: other.id, sede_id: other.sedeId,
    legacy_raw_state: { ...rawStudent, id: other.id, sede_id: other.sedeId }, manual_credits: [], penalty_incidents: [] });
  const results = project(data);
  expect(results.map(student => student.id)).toEqual(['student', 'other']);
  expect(results[0].manualCredits).toHaveLength(1);
  expect(results[1].manualCredits).toEqual([]);
  expect(results[1].pendingPenalties).toEqual([]);
  const duplicate = structuredClone(data);
  duplicate.rows[0] = structuredClone(duplicate.rows[1]);
  expect(() => project(duplicate)).toThrow();
  data.rows[1].manual_credits[0].student_id = other.id;
  expect(() => project(data)).toThrow();
});

test('missing, duplicate, foreign and malformed profiles fail closed instead of keeping stale rights', () => {
  const changes: Array<(data: Fixture) => void> = [
    data => { data.rows = []; }, data => { data.rows.push(structuredClone(data.rows[0])); },
    data => { data.students.push(structuredClone(data.students[0])); data.rows.push(structuredClone(data.rows[0])); },
    data => { data.rows[0].student_id = 'homonym'; }, data => { data.rows[0].sede_id = 'foreign'; },
    data => { data.rows[0].legacy_raw_state.id = 'other'; }, data => { data.rows[0].legacy_raw_state.sede_id = 'foreign'; },
    data => { data.rows[0].legacy_raw_state.classes_remaining = 8; },
    data => { data.rows[0].legacy_observed_balance = 8; }, data => { delete data.students[0].legacyManualBalance; },
    data => { (data.rows[0] as any).legacy_observed_balance = undefined; },
    data => { (data.rows[0] as any).legacy_observed_balance = ''; },
    data => { (data.rows[0] as any).legacy_observed_balance = '9007199254740992'; },
    data => { (data.rows[0].legacy_raw_state as any).classes_remaining = undefined; },
    data => { (data.rows[0].legacy_raw_state as any).current_membership_period_id = undefined; },
    data => { delete data.students[0].sedeId; }, data => { (data.rows[0] as any).legacy_raw_state = null; },
    data => { (data.rows[0] as any).manual_credits = null; }, data => { (data.rows[0] as any).penalty_incidents = {}; },
    data => { (data.rows[0] as any).can_reconcile_legacy = 'true'; },
    data => { (data.rows[0] as any).can_approve_manual_credit = 1; }
  ];
  for (const change of changes) {
    const data = fixture();
    data.students[0].manualCredits = [{ ...manual, id: 'stale' } as any];
    change(data);
    expect(() => project(data)).toThrow();
  }
  expect(attachStudentCreditProfiles([], [], [], [], today)).toEqual([]);
  expect(() => attachStudentCreditProfiles([], fixture().rows, [], [], today)).toThrow();
});

test('manual rights reject foreign identities, duplicates, unknown enums, invalid dates and unsafe or unknown balances', () => {
  const invalid = [
    { student_id: 'other' }, { sede_id: 'other' }, { entitlement_id: '' }, { mode: 'automatic' }, { activity: 'unknown' },
    { quantity: 0 }, { quantity: true }, { quantity: '4.0' }, { remaining_classes: null }, { remaining_classes: '' },
    { remaining_classes: ' 3 ' }, { remaining_classes: '1e0' }, { remaining_classes: -1 }, { remaining_classes: 5 },
    { quantity: '9007199254740992' }, { remaining_classes: '9007199254740993' }, { remaining_classes: Infinity },
    { starts_on: '2026-02-30' }, { starts_on: '2026-10-01T00:00:00Z' }, { ends_on: 'infinity' },
    { starts_on: '2026-11-01' }, { reason: ' ' }, { evidence: '' }, { reason: 'x'.repeat(2001) },
    { evidence: 'x'.repeat(10001) }, { approved_by: null }, { approved_at: '2026-02-30T12:00:00Z' }
  ];
  for (const values of invalid) {
    const data = fixture();
    Object.assign(data.rows[0].manual_credits[0], values);
    expect(() => project(data)).toThrow();
  }
  const duplicate = fixture();
  duplicate.rows[0].manual_credits.push(structuredClone(manual));
  expect(() => project(duplicate)).toThrow();
  const safe = fixture();
  Object.assign(safe.rows[0].manual_credits[0], { quantity: String(Number.MAX_SAFE_INTEGER), remaining_classes: String(Number.MAX_SAFE_INTEGER) });
  expect(project(safe)[0].manualCredits![0].remainingClasses).toBe(Number.MAX_SAFE_INTEGER);
});

test('incidents reject unknown states, inconsistent flags, foreign rosters and stale or unsafe revisions', () => {
  const invalid = [{ penalty_state: 'unknown' }, { kind: 'attendance' }, { is_pending: false }, { is_waived: true },
    { is_pending: 'true' }, { billing_state: 'charged' }, { original_penalty_state: 'unknown' },
    { student_id: 'other' }, { sede_id: 'foreign' }, { session_id: 'missing' }, { expected_revision: '6' },
    { expected_revision: null }, { expected_revision: '9007199254740992' }, { incident_revision: '8' },
    { incident_revision: -1 }, { incident_revision: '5.0' }, { original_manual_credit_id: '' }, { incident_reason: '' }];
  for (const values of invalid) {
    const data = fixture();
    Object.assign(data.rows[0].penalty_incidents[0], values);
    expect(() => project(data)).toThrow();
  }
  for (const change of [
    (data: Fixture) => { data.sessions = []; },
    (data: Fixture) => { data.sessions.push(structuredClone(data.sessions[0])); },
    (data: Fixture) => { data.sessions[0].sedeId = 'foreign'; },
    (data: Fixture) => { data.sessions[0].studentIds = ['homonym']; },
    (data: Fixture) => { delete data.sessions[0].studentIds; },
    (data: Fixture) => { delete data.sessions[0].revision; },
    (data: Fixture) => { data.sessions[0].date = '2026-02-29'; },
    (data: Fixture) => { data.sessions[0].startTime = '25:00'; },
    (data: Fixture) => { data.rows[0].penalty_incidents.push(structuredClone(incident)); },
    (data: Fixture) => { data.rows[0].penalty_incidents.push({ ...incident, penalty_id: 'another' }); }
  ]) {
    const data = fixture();
    change(data);
    expect(() => project(data)).toThrow();
  }
});

test('provided business state must match the exact incident; missing state cannot enable settlement', () => {
  for (const values of [{ penaltyId: 'another' }, { penaltyState: 'charged' }, { billingState: 'charged' },
    { billingKind: 'late_cancellation' }, { finalizedRevision: 6 }, { finalizedRevision: NaN }]) {
    const data = fixture();
    Object.assign(data.sessions[0].businessStateByStudentId!.student, values);
    expect(() => project(data)).toThrow();
  }
  const missing = fixture();
  missing.sessions[0].businessStateByStudentId = {};
  expect(() => project(missing)).toThrow();
  delete missing.sessions[0].businessStateByStudentId;
  blocked(missing);
});

test('manual availability requires policy2 finalization and the exact original balance, activity and dates, never a substitute', () => {
  const changes: Array<(data: Fixture) => void> = [
    data => { data.sessions[0].attendancePolicyVersion = 1; }, data => { delete data.sessions[0].completedAt; },
    data => { data.students[0].archivedAt = '2026-10-01'; },
    data => { data.rows[0].legacy_raw_state.archived_at = '2026-10-01'; },
    data => { data.rows[0].manual_credits[0].remaining_classes = '0'; },
    data => { data.rows[0].manual_credits[0].activity = 'torno'; },
    data => { data.rows[0].manual_credits[0].starts_on = today; },
    data => { data.rows[0].manual_credits[0].ends_on = '2026-10-11'; },
    data => { data.rows[0].penalty_incidents[0].original_manual_credit_id = 'unloaded'; },
    data => { data.rows[0].penalty_incidents[0].original_manual_credit_id = null; },
    data => { data.rows[0].penalty_incidents[0].original_gift_card_id = 'gift'; },
    data => { data.sessions[0].manualCreditIdByStudentId = { student: 'substitute' }; },
    data => { data.sessions[0].businessStateByStudentId!.student.fundingManualCreditId = 'substitute'; },
    data => { data.sessions[0].businessStateByStudentId!.student.billingDebitId = 'already-debited'; }
  ];
  for (const change of changes) {
    const data = fixture();
    data.rows[0].manual_credits.push({ ...manual, entitlement_id: 'substitute' });
    data.giftCards = [gift];
    (data.rows[0].penalty_incidents[0] as any).can_settle = true;
    change(data);
    blocked(data);
  }
  const valid = fixture();
  (valid.rows[0].penalty_incidents[0] as any).can_settle = false;
  valid.rows[0].manual_credits[0].starts_on = session.date;
  valid.rows[0].manual_credits[0].ends_on = today;
  expect(project(valid)[0].pendingPenalties![0].canSettle).toBe(true);
});

test('gift availability requires the original recipient, payment, activation, activity and exact positive balance', () => {
  expect(project(asGift())[0].pendingPenalties![0].canSettle).toBe(true);
  const pending = asGift();
  pending.giftCards[0].status = 'pending';
  expect(project(pending)[0].pendingPenalties![0].canSettle).toBe(true);
  const invalid = [{ recipientStudentId: 'homonym' }, { recipientStudentId: undefined }, { paymentStatus: 'pending' },
    { paymentStatus: undefined }, { paymentStatus: 'refunded' }, { status: 'cancelled' }, { status: 'expired' },
    { status: 'exhausted' }, { status: undefined }, { activatedAt: undefined }, { activatedAt: today },
    { activatedAt: '2026-02-30' }, { expiryDate: '2026-10-11' }, { expiryDate: 'infinity' }, { type: 'torno' },
    { sessionsRemaining: 0 }, { sessionsRemaining: undefined }, { sessionsRemaining: 4 }, { sessionsUsed: -1 },
    { sessionsUsed: null }, { numClasses: Number.MAX_SAFE_INTEGER + 1 }, { sedeId: 'foreign' }];
  for (const values of invalid) {
    const data = asGift();
    Object.assign(data.giftCards[0], values);
    data.giftCards.push({ ...gift, id: 'substitute' });
    blocked(data);
  }
  const duplicate = asGift();
  duplicate.giftCards.push(structuredClone(gift));
  blocked(duplicate);
  const wrongSource = asGift();
  wrongSource.sessions[0].giftCardIdByStudentId = { student: 'substitute' };
  blocked(wrongSource);
});

test('membership availability requires the paid original current period, bounded raw balance and no due successor', () => {
  const changes: Array<(data: Fixture) => void> = [
    data => { data.students[0].membershipPeriods![0].paymentStatus = null; },
    data => { data.students[0].membershipPeriods![0].paymentStatus = 'pending'; },
    data => { data.students[0].membershipPeriods![0].studentId = 'homonym'; },
    data => { data.students[0].membershipPeriods![0].allocatedClasses = undefined; },
    data => { data.students[0].membershipPeriods![0].startsOn = today; },
    data => { data.students[0].membershipPeriods![0].endsOn = '2026-10-11'; },
    data => { data.students[0].membershipPeriods![0].endsOn = '2026-02-30'; },
    data => { data.students[0].materializedPeriodId = 'successor'; },
    data => { data.students[0].effectivePeriodId = 'successor'; },
    data => { data.rows[0].legacy_raw_state.current_membership_period_id = 'successor'; },
    data => { data.students[0].membershipPeriods = []; },
    data => { data.students[0].membershipPeriods!.push({ ...data.students[0].membershipPeriods![0] }); },
    data => { data.students[0].membershipPeriods!.push({ id: 'successor', studentId: 'student', predecessorId: 'period',
      startsOn: today, paymentStatus: 'paid' }); },
    data => { data.sessions[0].businessStateByStudentId!.student.fundingPeriodId = 'successor'; }
  ];
  for (const change of changes) {
    const data = asMembership();
    change(data);
    blocked(data);
  }
  const queued = asMembership();
  queued.students[0].membershipPeriods!.push({ id: 'future', studentId: 'student', predecessorId: 'period',
    startsOn: '2026-11-01', paymentStatus: 'paid' });
  expect(project(queued)[0].pendingPenalties![0].canSettle).toBe(true);
});

test('the legacy pendingPenalties name contains every incident, including direct charges and waivers', () => {
  const data = fixture();
  for (const state of ['charged', 'waived'] as const) {
    const id = `session-${state}`;
    const penaltyId = `penalty-${state}`;
    const resolved = structuredClone(session);
    resolved.id = id;
    Object.assign(resolved.businessStateByStudentId!.student, { penaltyId, penaltyState: state, billingState: state });
    data.sessions.push(resolved);
    data.rows[0].penalty_incidents.push({ ...incident, session_id: id, penalty_id: penaltyId, penalty_state: state,
      original_penalty_state: state === 'charged' ? 'charged' : 'pending', billing_state: state,
      is_pending: false, is_waived: state === 'waived' });
  }
  expect(project(data)[0].pendingPenalties!.map(penalty => [penalty.state, penalty.canSettle]))
    .toEqual([['pending', true], ['charged', false], ['waived', false]]);
});

test('settled then waived incidents retain their original reason, source and settlement audit at the current revision', () => {
  const data = fixture();
  const audit = { settlement_id: 'settlement', settlement_reason: 'Original settlement reason', settled_by: 'owner',
    settled_at: '2026-10-12T08:30:00.123456+00:00', settlement_revision: '6' };
  Object.assign(data.rows[0].penalty_incidents[0], audit, { penalty_state: 'charged', is_pending: false, billing_state: 'charged' });
  Object.assign(data.sessions[0].businessStateByStudentId!.student, { penaltyState: 'charged', billingState: 'charged',
    settlementId: audit.settlement_id, settlementReason: audit.settlement_reason, settledBy: audit.settled_by,
    settledAt: audit.settled_at, settlementRevision: 6 });
  const charged = project(data)[0].pendingPenalties![0];
  expect(charged).toMatchObject({ state: 'charged', canSettle: false, sessionRevision: 7, settlementId: 'settlement',
    settlementReason: audit.settlement_reason, settledBy: 'owner', settledAt: audit.settled_at,
    reason: incident.incident_reason, originalManualCreditId: 'manual' });
  Object.assign(data.rows[0].penalty_incidents[0], { penalty_state: 'waived', is_waived: true, billing_state: 'waived', expected_revision: '8' });
  data.sessions[0].revision = 8;
  Object.assign(data.sessions[0].businessStateByStudentId!.student, { penaltyState: 'waived', billingState: 'waived' });
  const waived = project(data)[0].pendingPenalties![0];
  expect(waived).toMatchObject({ ...charged, state: 'waived', sessionRevision: 8 });
  data.sessions[0].businessStateByStudentId!.student.settlementReason = 'Different audit';
  expect(() => project(data)).toThrow();
});

test('settlement audit must be complete, safe and consistent, including for waived incidents', () => {
  for (const values of [{ settlement_reason: 'orphan' }, { settlement_id: 'settlement' }, { settlement_revision: '8' },
    { settlement_revision: '9007199254740992' }]) {
    const data = fixture();
    Object.assign(data.rows[0].penalty_incidents[0], values);
    expect(() => project(data)).toThrow();
  }
  const waived = fixture();
  Object.assign(waived.rows[0].penalty_incidents[0], { penalty_state: 'waived', is_pending: false, is_waived: true, billing_state: 'waived' });
  Object.assign(waived.sessions[0].businessStateByStudentId!.student, { penaltyState: 'waived', billingState: 'waived' });
  expect(project(waived)[0].pendingPenalties![0]).toMatchObject({ state: 'waived', canSettle: false, settlementId: undefined });
});

test('server reconciliation boolean is preserved, not inferred from approval capability or projected classes', () => {
  const data = fixture();
  data.rows[0].can_reconcile_legacy = false;
  expect(project(data)[0].canReconcileLegacy).toBe(false);
  data.rows[0].can_reconcile_legacy = true;
  data.rows[0].can_approve_manual_credit = false;
  expect(project(data)[0].canReconcileLegacy).toBe(true);
  const reconciled = fixture();
  reconciled.rows[0].manual_credits[0].mode = 'reconcile_legacy';
  expect(() => project(reconciled)).toThrow();
  reconciled.rows[0].can_reconcile_legacy = false;
  expect(project(reconciled)[0].canReconcileLegacy).toBe(false);
});

test('default date uses Madrid and invalid explicit dates fail closed', () => {
  const data = fixture();
  const date = getWorkshopDate();
  data.sessions[0].date = date;
  data.rows[0].manual_credits[0].starts_on = date;
  data.rows[0].manual_credits[0].ends_on = date;
  expect(attachStudentCreditProfiles(data.students, data.rows, data.sessions, data.giftCards)[0].pendingPenalties![0].canSettle).toBe(true);
  expect(getWorkshopDate(new Date('2026-10-11T22:30:00Z'))).toBe('2026-10-12');
  for (const invalid of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-10-12T00:00:00Z', '', 'infinity']) {
    expect(() => project(data, invalid)).toThrow();
  }
});
