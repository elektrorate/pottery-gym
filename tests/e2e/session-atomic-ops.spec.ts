import { expect, test } from '@playwright/test';
import {
    SessionIntentStore, attendanceInput, createSessionAttendanceIntent, createSessionOperations,
    createSessionReservationIntent, reservationInput, resolveSessionStudentIds, type RevisionedSession
} from '../../context/data/sessionAttendanceOps';
import type { Student } from '../../types';

const students = [
    { id: 'one', name: 'Alex', surname: 'Perez' },
    { id: 'two', name: 'Alex', surname: 'Perez' }
] as Student[];
const session: RevisionedSession = { id: 'session', date: '2026-10-11', startTime: '10:00', endTime: '11:00',
    classType: 'mesa', capacity: 2, students: ['ALEX PEREZ', 'ALEX PEREZ'], studentIds: ['two', 'one'], revision: 7,
    attendanceByStudentId: { one: 'present', two: 'absent' } };
const storage = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};

test('partial ID override produces the full immutable persisted roster, not homonym guesses', () => {
    const intent = createSessionAttendanceIntent(session, students, { attendanceByStudentId: { two: 'present' }, completedAt: 'now' }, 'key');
    expect(intent.args).toEqual({ p_session_id: 'session', p_request_key: 'key', p_expected_revision: 7,
        p_attendance: [{ student_id: 'one', status: 'present' }, { student_id: 'two', status: 'present' }],
        p_finalize: true, p_teacher_substitute_id: null });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.args.p_attendance[0])).toBe(true);
    expect(session.attendanceByStudentId).toEqual({ one: 'present', two: 'absent' });
});

test('ambiguous name attendance and reservation compatibility reject instead of finding first', () => {
    expect(() => createSessionAttendanceIntent(session, students, { attendance: { 'ALEX PEREZ': 'present' } })).toThrow('ambigua');
    expect(() => resolveSessionStudentIds(students, ['ALEX PEREZ'])).toThrow('ambiguo');
    expect(resolveSessionStudentIds(students, ['ALEX PEREZ'], ['two'])).toEqual(['two']);
    expect(() => resolveSessionStudentIds(students, [], ['one', 'one'])).toThrow('duplicados');
});

test('unique old name keys map only within the persisted ID roster', () => {
    const unique = [{ ...students[0], surname: 'One' }, { ...students[1], surname: 'Two' }];
    const intent = createSessionAttendanceIntent({ ...session, attendanceByStudentId: undefined,
        attendance: { 'ALEX ONE': 'present', 'ALEX TWO': 'absent' } }, unique, { attendance: { 'ALEX TWO': 'present' } });
    expect(intent.args.p_attendance).toEqual([{ student_id: 'one', status: 'present' }, { student_id: 'two', status: 'present' }]);
});

test('missing roster/revision, foreign ID, mixed maps and incomplete finalization fail before writes', () => {
    expect(() => createSessionAttendanceIntent({ ...session, studentIds: undefined }, students, {})).toThrow('persistido');
    expect(() => createSessionAttendanceIntent({ ...session, revision: undefined }, students, {})).toThrow('revision');
    expect(() => createSessionAttendanceIntent(session, students, { attendanceByStudentId: { foreign: 'present' } })).toThrow('fuera');
    expect(() => createSessionAttendanceIntent(session, students, { attendanceByStudentId: { constructor: 'present' as const } })).toThrow('fuera');
    expect(() => createSessionAttendanceIntent(session, students, { attendance: {}, attendanceByStudentId: {} })).toThrow('combines');
    expect(() => createSessionAttendanceIntent({ ...session, attendanceByStudentId: {} }, students, { completedAt: 'now' })).toThrow('todos');
});

test('one intent is stored before the single attendance RPC and reloads on committed receipt', async () => {
    const store = new SessionIntentStore(storage());
    let refreshes = 0;
    const calls: any[] = [];
    const updates = { attendanceByStudentId: { two: 'present' as const }, revision: 7, completedAt: 'now' };
    const operations = createSessionOperations({ store, rpc: async (name, args) => {
        expect(store.get('tenant:session')?.requestKey).toBe(args.p_request_key);
        calls.push({ name, args });
        return { data: { session_id: 'session', request_key: args.p_request_key, revision: 8 }, error: null };
    }, refresh: async () => { refreshes++; } });
    await operations.save('tenant:session', attendanceInput(updates), () => createSessionAttendanceIntent(session, students, updates));
    expect(calls.map(call => call.name)).toEqual(['save_session_attendance']);
    expect(refreshes).toBe(1);
    expect(store.get('tenant:session')).toBeNull();
});

test('lost response survives remount and rollover: retry sends exact original key/revision/input', async () => {
    const persisted = storage();
    const calls: any[] = [];
    const updates = { attendanceByStudentId: { two: 'present' as const }, completedAt: 'now' };
    const first = createSessionOperations({ store: new SessionIntentStore(persisted), rpc: async (_name, args) => {
        calls.push(args); throw new Error('response lost');
    }, refresh: async () => undefined });
    await expect(first.save('tenant:session', attendanceInput(updates), () => createSessionAttendanceIntent(session, students, updates))).rejects.toThrow('response lost');
    let refreshes = 0;
    const second = createSessionOperations({ store: new SessionIntentStore(persisted), rpc: async (_name, args) => {
        calls.push(args); return { data: { session_id: 'session', request_key: args.p_request_key, revision: 8, replayed: true }, error: null };
    }, refresh: async () => { refreshes++; } });
    await second.save('tenant:session', attendanceInput({ ...updates, completedAt: 'new timestamp' }), () => {
        throw new Error('must not rebuild intent using new current data');
    });
    expect(calls[1]).toEqual(calls[0]);
    expect(refreshes).toBe(1);
});

test('uncertain failure blocks a different target and malformed receipt keeps original intent', async () => {
    const store = new SessionIntentStore(storage());
    const updates = { attendanceByStudentId: { two: 'present' as const } };
    const operations = createSessionOperations({ store, rpc: async () => ({ data: {}, error: null }), refresh: async () => undefined });
    await expect(operations.save('session', attendanceInput(updates), () => createSessionAttendanceIntent(session, students, updates))).rejects.toThrow('comprobante');
    const retained = store.get('session');
    await expect(operations.save('session', attendanceInput({ attendanceByStudentId: { two: 'absent' } }), () => {
        throw new Error('not called');
    })).rejects.toThrow('pendiente');
    expect(store.get('session')).toEqual(retained);
});

test('SQL rollback clears intent; stale revision reloads without automatic retargeting', async () => {
    for (const code of ['P0001', '40001']) {
        const store = new SessionIntentStore(storage());
        let refreshes = 0;
        let calls = 0;
        const operations = createSessionOperations({ store, rpc: async () => {
            calls++; return { data: null, error: { code, message: 'rolled back' } };
        }, refresh: async () => { refreshes++; } });
        await expect(operations.save('session', attendanceInput({}), () => createSessionAttendanceIntent(session, students, {}))).rejects.toMatchObject({ code });
        expect(calls).toBe(1);
        expect(refreshes).toBe(code === '40001' ? 1 : 0);
        expect(store.get('session')).toBeNull();
    }
});

test('commit followed by reload failure retains retry identity rather than returning success', async () => {
    const store = new SessionIntentStore(storage());
    const operations = createSessionOperations({ store, rpc: async (_name, args) => ({ data: {
        session_id: 'session', request_key: args.p_request_key, revision: 8 }, error: null }),
    refresh: async () => { throw new Error('reload failed'); } });
    await expect(operations.save('session', attendanceInput({}), () => createSessionAttendanceIntent(session, students, {}))).rejects.toThrow('reload failed');
    expect(store.get('session')?.args.p_expected_revision).toBe(7);
});

test('concurrent UI saves for same session cannot launch two RPCs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const operations = createSessionOperations({ store: new SessionIntentStore(storage()), rpc: async (_name, args) => {
        calls++; await gate;
        return { data: { session_id: 'session', request_key: args.p_request_key, revision: 8 }, error: null };
    }, refresh: async () => undefined });
    const first = operations.save('session', attendanceInput({}), () => createSessionAttendanceIntent(session, students, {}));
    await expect(operations.save('session', attendanceInput({}), () => createSessionAttendanceIntent(session, students, {}))).rejects.toThrow('Ya se esta');
    expect(calls).toBe(1);
    release();
    await first;
});

test('reservation intent freezes IDs and explicit funding with a separate RPC contract', async () => {
    const calls: any[] = [];
    const operations = createSessionOperations({ store: new SessionIntentStore(storage()), rpc: async (name, args) => {
        calls.push({ name, args }); return { data: { session_id: 'session', request_key: 'key', revision: 1 }, error: null };
    }, refresh: async () => undefined });
    await operations.save('session', 'input', () => createSessionReservationIntent('session', 0, 'tenant',
        { capacity: 2 }, ['two', 'one'], { two: 'explicit-card' }, 'input', 'key'));
    expect(calls).toEqual([{ name: 'save_session_reservation', args: { p_session_id: 'session', p_request_key: 'key',
        p_expected_revision: 0, p_sede_id: 'tenant', p_metadata: { capacity: 2 },
        p_student_ids: ['one', 'two'], p_gift_card_ids: { two: 'explicit-card' } } }]);
});

test('reservation retry ignores refreshed revision but never rebuilds its frozen metadata or key', async () => {
    const persisted = storage();
    const calls: any[] = [];
    const input = reservationInput({ revision: 7, capacity: 3, studentIds: ['one', 'two'] });
    const intent = createSessionReservationIntent('session', 7, 'tenant', { capacity: 3 }, ['one', 'two'], {}, input);
    const first = createSessionOperations({ store: new SessionIntentStore(persisted), rpc: async (_name, args) => {
        calls.push(args); throw new Error('lost reservation response');
    }, refresh: async () => undefined });
    await expect(first.save('session', input, () => intent)).rejects.toThrow('lost reservation');
    const retry = createSessionOperations({ store: new SessionIntentStore(persisted), rpc: async (_name, args) => {
        calls.push(args); return { data: { session_id: 'session', request_key: args.p_request_key, revision: 8, replayed: true }, error: null };
    }, refresh: async () => undefined });
    await retry.save('session', reservationInput({ revision: 8, capacity: 3, studentIds: ['one', 'two'] }), () => {
        throw new Error('must not rebuild');
    });
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1].p_expected_revision).toBe(7);
});
