import { expect, test } from '@playwright/test';
import { createSessionBusinessIntent, createSessionOperations, SessionIntentStore, createSessionAttendanceIntent } from '../../context/data/sessionAttendanceOps';
import { attachSessionBusinessState } from '../../utils/sessionBusiness';
import { getSessionEnrolledCount } from '../../utils/sessionCapacity';
import { attachAttendanceHistory } from '../../utils/attendanceHistory';
import type { ClassSession, SessionBusinessIntent, Student } from '../../types';

const session: ClassSession = { id: 'session', sedeId: 'sede', revision: 3, attendancePolicyVersion: 2, date: '2026-10-11',
  startTime: '10:00', endTime: '12:00', classType: 'mesa', students: ['ALEX', 'ALEX'], studentIds: ['first', 'second'],
  attendanceByStudentId: { first: 'present', second: 'pending' } };
const rows = ['first', 'second'].map(student_id => ({ session_id: 'session', sede_id: 'sede', student_id,
  policy_version: 2, reservation_state: student_id === 'second' ? 'cancelled' : 'reserved', billing_state: 'unfinalized',
  cancellation_kind: student_id === 'second' ? 'timely' : null, cancelled_by: 'actor', cancellation_reason: 'Aviso',
  cancelled_at: '2026-10-10T10:00:00Z', waiver_reason: 'Justificada', waived_by: 'owner', waived_at: '2026-10-11T10:00:00Z' }));
const business: SessionBusinessIntent = { operation: 'approve_exception', sessionId: 'session', studentId: 'first', requestKey: 'key',
  expectedRevision: 3, kind: 'membership_override', reason: 'Excepcion individual' };

test('business projection maps audit fields by exact IDs and preserves source objects', () => {
  const mapped = attachSessionBusinessState(session, rows);
  expect(mapped.businessStateByStudentId?.second).toMatchObject({ reservationState: 'cancelled', cancellationReason: 'Aviso',
    cancelledBy: 'actor', waiverReason: 'Justificada', waivedBy: 'owner' });
  expect(session.businessStateByStudentId).toBeUndefined();
});

test('missing, duplicate, foreign and wrong-version projections fail closed', () => {
  for (const data of [[], [rows[0]], [...rows, rows[0]], [{ ...rows[0], sede_id: 'foreign' }, rows[1]],
    [{ ...rows[0], policy_version: 1 }, rows[1]], [{ ...rows[0], student_id: 'other' }, rows[1]]]) {
    expect(() => attachSessionBusinessState(session, data)).toThrow();
  }
  expect(() => attachSessionBusinessState({ ...session, attendancePolicyVersion: undefined }, rows)).toThrow();
});

test('cancellation releases the seat and is not fabricated as an attendance absence', () => {
  const mapped = attachSessionBusinessState({ ...session, attendanceByStudentId: { first: 'present', second: 'absent' } }, rows);
  expect(getSessionEnrolledCount(mapped)).toBe(1);
  const students = ['first', 'second'].map(id => ({ id, name: 'Alex', phone: '', status: 'new', classesRemaining: 1 })) as Student[];
  const history = attachAttendanceHistory(students, [mapped]);
  expect(history[0].assignedClasses).toHaveLength(1);
  expect(history[1].assignedClasses).toHaveLength(0);
  expect(createSessionAttendanceIntent(mapped, students, { completedAt: '2026-10-11T12:00:00Z' }).args.p_attendance).toHaveLength(2);
});

test('business intents have immutable exact args and never carry client owner claims', () => {
  const intent = createSessionBusinessIntent(business);
  expect(Object.isFrozen(intent.args)).toBe(true);
  expect(intent.args).toEqual({ p_session_id: 'session', p_student_id: 'first', p_request_key: 'key', p_expected_revision: 3,
    p_kind: 'membership_override', p_reason: 'Excepcion individual' });
  for (const changed of [{ reason: '' }, { expectedRevision: -1 }, { kind: undefined }, { operation: 'waive_penalty' }]) {
    expect(() => createSessionBusinessIntent({ ...business, ...changed } as SessionBusinessIntent)).toThrow();
  }
});

for (const [operation, rpc] of [['approve_exception', 'approve_session_exception'], ['cancel_reservation', 'cancel_session_reservation'],
  ['waive_penalty', 'waive_session_penalty']] as const) {
  test(`${operation} uses the allowlisted RPC and retries the original identity after transport loss`, async () => {
    const value = { ...business, operation, ...(operation === 'approve_exception' ? {} : { kind: undefined }) };
    const frozen = createSessionBusinessIntent(value);
    const store = new SessionIntentStore();
    const calls: any[] = [];
    let attempts = 0;
    const operations = createSessionOperations({ store, refresh: async () => {}, rpc: async (name, args) => {
      calls.push({ name, args });
      if (++attempts === 1) throw new Error('Response lost');
      return { data: { session_id: 'session', request_key: 'key', revision: 4, replayed: true }, error: null };
    } });
    await expect(operations.save('sede:session', frozen.input, () => frozen)).rejects.toThrow('Response lost');
    expect(store.get('sede:session')).not.toBeNull();
    await operations.save('sede:session', frozen.input, () => { throw new Error('Must not rebuild'); });
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0].name).toBe(rpc);
    expect(store.get('sede:session')).toBeNull();
  });
}
