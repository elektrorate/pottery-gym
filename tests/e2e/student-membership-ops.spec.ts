import { expect, test } from '@playwright/test';
import { AttendanceMembershipIntents, PendingMembershipIntentStore, createClassAdjustmentIntent, createMembershipOperations, createRenewalIntent, persistAttendanceAfterAdjustments } from '../../context/data/membershipOps';
import { joinStudentMemberships, mapStudentRowToModel, assertOrdinaryStudentUpdate } from '../../utils/studentLifecycle';
import type { Student } from '../../types';

const base = { id: 'student', sede_id: 'tenant', name: 'Member', student_category: 'membresia',
  current_membership_period_id: 'current', payment_status: 'paid', classes_remaining: 2 };
const projection = { student_id: 'student', sede_id: 'tenant', materialized_period_id: 'current',
  effective_period_id: 'current', payment_status: null, classes_remaining: 2, allocated_classes: 4,
  membership_tier: 'gold', plan_price: 120, starts_on: '2026-10-01', ends_on: '2026-10-31' };
const current = { id: 'current', student_id: 'student', sede_id: 'tenant', payment_status: null };
const queued = { id: 'queued', student_id: 'student', sede_id: 'tenant', predecessor_id: 'current',
  starts_on: '2026-11-01', ends_on: '2026-11-30', allocated_classes: 8, membership_tier: 'platinum', payment_status: 'pending' };
const student: Student = { id: 'student', name: 'Member', phone: '', status: 'membresia', studentCategory: 'membresia',
  effectivePeriodId: 'current', membershipActivatedAt: '2026-10-01', expiryDate: '2026-10-31', classesRemaining: 2 };

const mockOperations = (respond: (name: string, args: Record<string, unknown>) => any = () => ({ data: queued, error: null })) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let refreshes = 0;
  return {
    calls, get refreshes() { return refreshes; },
    operations: createMembershipOperations({ rpc: async (name, args) => {
      calls.push({ name, args }); return respond(name, args);
    }, refresh: async () => { refreshes++; } })
  };
};

test('profile edits reject every protected field including unchanged values and payment reversal', () => {
  expect(() => assertOrdinaryStudentUpdate(student, { name: 'Edited', archivedAt: '2026-10-11' })).not.toThrow();
  for (const updates of [{ paymentStatus: 'pending' as const }, { classesRemaining: 2 },
    { expiryDate: '2026-10-31' }, { membershipTier: 'platinum' as const }, { price: 180 },
    { bonosAsignados: 8 }, { studentCategory: 'temporal' as const }]) {
    expect(() => assertOrdinaryStudentUpdate(student, updates)).toThrow('acciones de período');
  }
  expect(() => assertOrdinaryStudentUpdate({ ...student, studentCategory: 'temporal' }, { classesRemaining: 1 })).not.toThrow();
});

test('SELECT mapping preserves authoritative NULL and queued history without changing current balance', () => {
  const [mapped] = joinStudentMemberships([base], [projection], [current, queued]);
  expect(mapped.paymentStatus).toBeNull();
  expect(mapped.classesRemaining).toBe(2);
  expect(mapped.effectivePeriodId).toBe('current');
  expect(mapped.membershipTier).toBe('gold');
  expect(mapped.membershipPeriods?.map(period => period.id)).toEqual(['current', 'queued']);
});

test('due effective period overlays unmaterialized current row including its NULL payment', () => {
  const [mapped] = joinStudentMemberships([base], [{ ...projection, effective_period_id: 'queued',
    classes_remaining: 8, membership_tier: 'platinum', starts_on: '2026-11-01' }], [current, queued]);
  expect(mapped.materializedPeriodId).toBe('current');
  expect(mapped.effectivePeriodId).toBe('queued');
  expect(mapped.classesRemaining).toBe(8);
  expect(mapped.paymentStatus).toBeNull();
});

test('missing or mismatched membership projection rejects instead of falling back', () => {
  for (const projections of [[], [{ ...projection, sede_id: 'other' }],
    [{ ...projection, materialized_period_id: 'other' }], [projection, projection]]) {
    expect(() => joinStudentMemberships([base], projections, [current])).toThrow();
  }
  expect(() => joinStudentMemberships([base], [projection], [])).toThrow();
});

test('legacy SELECT remains unknown and does not require initializing a period', () => {
  const [mapped] = joinStudentMemberships([{ ...base, current_membership_period_id: null }],
    [{ ...projection, effective_period_id: null, materialized_period_id: null }], []);
  expect(mapped.paymentStatus).toBeNull();
  expect(mapped.effectivePeriodId).toBeUndefined();
  expect(mapped.membershipPeriods).toEqual([]);
});

test('unmanaged categories remain exact and ignore membership overlays', () => {
  for (const student_category of ['temporal', 'grupal', 'grupo_temporal']) {
    const [mapped] = joinStudentMemberships([{ ...base, student_category }], [], []);
    expect(mapped.studentCategory).toBe(student_category);
    expect(mapped.membershipTier).toBeUndefined();
    expect(mapped.classesRemaining).toBe(2);
  }
});

test('creation mapper uses returned period identity, dates, pending payment and plan', () => {
  const mapped = mapStudentRowToModel({ ...base, payment_status: 'pending', membership_tier: 'plata',
    price: 90, bonos_asignados: 3, classes_remaining: 3, expiry_date: '2026-11-09', membership_activated_at: '2026-10-10' });
  expect(mapped).toMatchObject({ classesRemaining: 3, price: 90, bonosAsignados: 3, paymentStatus: 'pending',
    effectivePeriodId: 'current', membershipTier: 'plata', expiryDate: '2026-11-09' });
});

test('renewal sends only the immutable RPC intent and refreshes authoritative data', async () => {
  const mocked = mockOperations();
  const intent = createRenewalIntent('student', 'platinum');
  const result = await mocked.operations.renew(intent);
  expect(Object.isFrozen(intent)).toBe(true);
  expect(result.id).toBe('queued');
  expect(mocked.calls).toEqual([{ name: 'schedule_student_membership', args: {
    student_id: 'student', request_key: intent.requestKey, membership_tier: 'platinum', allocated_classes: 8
  } }]);
  expect(mocked.refreshes).toBe(1);
});

test('timeout renewal retries retain exact identity and original arguments', async () => {
  let attempts = 0;
  const mocked = mockOperations(() => {
    if (++attempts === 1) throw new Error('timeout');
    return { data: queued, error: null };
  });
  const intent = createRenewalIntent('student', 'gold');
  await expect(mocked.operations.renew(intent)).rejects.toThrow('timeout');
  await mocked.operations.renew(intent);
  expect(mocked.calls[1]).toEqual(mocked.calls[0]);
});

test('RPC conflicts and absent backend reject with no generic update fallback', async () => {
  for (const code of ['PGRST202', '23505']) {
    const mocked = mockOperations(() => ({ data: null, error: { code, message: 'conflict or unavailable' } }));
    await expect(mocked.operations.renew(createRenewalIntent('student', 'gold'))).rejects.toThrow('conflict or unavailable');
    expect(mocked.calls).toHaveLength(1);
    expect(mocked.refreshes).toBe(0);
  }
});

test('historical confirmation targets selected identity, never the effective period', async () => {
  const mocked = mockOperations(() => ({ data: { ...current, id: 'old', payment_status: 'paid' }, error: null }));
  await mocked.operations.confirm('old');
  expect(mocked.calls).toEqual([{ name: 'confirm_student_membership_payment', args: { period_id: 'old' } }]);
  expect(mocked.refreshes).toBe(1);
});

test('explicit legacy initialization returns the identity safely used for confirmation', async () => {
  const mocked = mockOperations(name => ({ data: { id: name === 'activate_student_membership' ? 'legacy-captured' : 'confirmed' }, error: null }));
  const period = await mocked.operations.activate('student');
  await mocked.operations.confirm(period.id);
  expect(mocked.calls.map(call => call.args)).toEqual([{ student_id: 'student' }, { period_id: 'legacy-captured' }]);
});

test('class retry identity remains fixed across timeout and rollover', async () => {
  let attempts = 0;
  let effectiveBalance = 8;
  const calls: any[] = [];
  const operations = createMembershipOperations({ rpc: async (name, args) => {
    calls.push({ name, args });
    if (++attempts === 1) throw new Error('timeout');
    return { data: { period_id: 'current', resulting_balance: 1 }, error: null };
  }, refresh: async () => { effectiveBalance = 8; } });
  const intent = createClassAdjustmentIntent(student, -1);
  await expect(operations.adjust(intent)).rejects.toThrow('timeout');
  await operations.adjust(intent);
  expect(calls[1]).toEqual(calls[0]);
  expect(effectiveBalance).toBe(8);
  expect(intent.periodId).toBe('current');
});

test('stale 40001 refreshes and rejects without retargeting or automatic retry', async () => {
  const mocked = mockOperations(() => ({ data: null, error: { code: '40001', message: 'stale' } }));
  const intent = createClassAdjustmentIntent(student, -1);
  await expect(mocked.operations.adjust(intent)).rejects.toMatchObject({ code: '40001' });
  expect(mocked.refreshes).toBe(1);
  expect(mocked.calls).toHaveLength(1);
  expect(mocked.calls[0].args.period_id).toBe('current');
});

test('refresh failure rejects successful mutations so callers cannot mark completion', async () => {
  const operations = createMembershipOperations({ rpc: async () => ({ data: queued, error: null }),
    refresh: async () => { throw new Error('projection unavailable'); } });
  await expect(operations.renew(createRenewalIntent('student', 'gold'))).rejects.toThrow('projection unavailable');
});

test('attendance intents survive remount and retain old receipt identity after rollover', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const first = new AttendanceMembershipIntents(storage).get('session', student, -1, '2026-10-10');
  const next = new AttendanceMembershipIntents(storage).get('session', { ...student, effectivePeriodId: 'next', classesRemaining: 8 }, -1, '2026-10-10');
  expect(next).toEqual(first);
  expect(next.periodId).toBe('current');
});

test('historical and undated attendance adjustments fail closed; credits never guess period', () => {
  const intents = new AttendanceMembershipIntents();
  expect(() => intents.get('old', student, 1, '2026-09-01')).toThrow('otro período');
  expect(() => intents.get('current', student, 1, '2026-10-10')).toThrow('no tiene vínculo');
  expect(() => intents.get('undated', { ...student, membershipActivatedAt: undefined }, -1, '2026-10-10')).toThrow();
  expect(() => createClassAdjustmentIntent({ ...student, effectivePeriodId: undefined }, -1)).toThrow('Inicializa');
});

test('stale attendance attempt cannot silently become a new current-period intent', () => {
  const intents = new AttendanceMembershipIntents();
  intents.get('session', student, -1, '2026-10-10');
  intents.conflict('session', student.id, -1);
  expect(() => intents.get('session', { ...student, effectivePeriodId: 'next' }, -1, '2026-10-10')).toThrow('obsoleto');
});

test('pending profile intent survives remount with immutable arguments until explicit resolution', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const first = new PendingMembershipIntentStore(storage);
  const intent = createClassAdjustmentIntent(student, -1);
  first.set('adjust:student', intent);
  const reloaded = new PendingMembershipIntentStore(storage);
  expect(reloaded.get('adjust:student')).toEqual(intent);
  expect(Object.isFrozen(reloaded.get('adjust:student'))).toBe(true);
  reloaded.clear('adjust:student');
  expect(first.get('adjust:student')).toBeNull();
});

test('partial attendance freezes original target; reviewed conflict gets a new intent without replaying successful debit', () => {
  const intents = new AttendanceMembershipIntents();
  intents.begin('session', { MEMBER: 'present', SECOND: 'present' });
  const first = intents.get('session', student, -1, '2026-10-10');
  const secondStudent = { ...student, id: 'second' };
  const stale = intents.get('session', secondStudent, -1, '2026-10-10');
  intents.conflict('session', secondStudent.id, -1);
  expect(() => intents.begin('session', { MEMBER: 'absent', SECOND: 'present' })).toThrow('parcial');
  intents.reviewConflicts('session');
  const reviewed = intents.get('session', { ...secondStudent, classesRemaining: 3 }, -1, '2026-10-10');
  expect(reviewed.requestKey).not.toBe(stale.requestKey);
  expect(reviewed.expectedBalance).toBe(3);
  expect(intents.get('session', { ...student, classesRemaining: 1 }, -1, '2026-10-10')).toEqual(first);
});

test('calendar/dashboard concurrent saves of one session cannot run a second adjustment batch', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = persistAttendanceAfterAdjustments(() => gate, async () => undefined, 'shared-session');
  let secondAdjusted = false;
  await expect(persistAttendanceAfterAdjustments(async () => { secondAdjusted = true; }, async () => undefined, 'shared-session')).rejects.toThrow('Ya se está guardando');
  expect(secondAdjusted).toBe(false);
  release();
  await first;
  await persistAttendanceAfterAdjustments(async () => undefined, async () => undefined, 'shared-session');
});

test('partial attendance failure does not persist or complete session; retry replays first receipt', async () => {
  const intents = new AttendanceMembershipIntents();
  const secondStudent = { ...student, id: 'second' };
  const receipts = new Set<string>();
  const calls: string[] = [];
  let failSecond = true;
  let persisted = false;
  const adjust = async () => {
    for (const attendee of [student, secondStudent]) {
      const intent = intents.get('session', attendee, -1, '2026-10-10');
      calls.push(intent.requestKey);
      if (attendee.id === 'second' && failSecond) throw new Error('second failed');
      receipts.add(intent.requestKey);
    }
  };
  const persist = async () => { persisted = true; };
  await expect(persistAttendanceAfterAdjustments(adjust, persist)).rejects.toThrow('second failed');
  expect(persisted).toBe(false);
  expect(receipts.size).toBe(1);
  failSecond = false;
  await persistAttendanceAfterAdjustments(adjust, persist);
  expect(calls[2]).toBe(calls[0]);
  expect(receipts.size).toBe(2);
  expect(persisted).toBe(true);
});
