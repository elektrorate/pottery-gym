import { expect, test } from '@playwright/test';
import { StudentCreditIntentStore, createStudentCreditOperations } from '../../context/data/studentCreditOps';
import type { ManualCreditIntent, PenaltySettlementIntent, SessionBusinessIntent, PendingStudentCreditOperation } from '../../types';

type Operation = PendingStudentCreditOperation['operation'];
type Operations = ReturnType<typeof createStudentCreditOperations>;
const actorId = 'owner';
const studentId = 'student-first';
const sessionId = 'original-session';
const penaltyId = 'original-penalty';
const manual: ManualCreditIntent = { studentId, requestKey: 'manual-key', mode: 'new_manual', quantity: 4,
    expectedLegacyBalance: null, activity: 'mesa', startsOn: '2026-10-12', endsOn: '2026-11-12',
    reason: 'Verified manual allocation', evidence: 'Private supporting evidence' };
const settlement: PenaltySettlementIntent = { studentId, penaltyId, requestKey: 'settlement-key', expectedRevision: 7, reason: 'Original incident source' };
const waiver: SessionBusinessIntent = { operation: 'waive_penalty', studentId, sessionId, requestKey: 'waiver-key', expectedRevision: 7, reason: 'Justified waiver' };
const operations: Operation[] = ['approve_manual', 'settle_penalty', 'waive_penalty'];
const names: Record<Operation, string> = { approve_manual: 'approve_student_manual_credit', settle_penalty: 'settle_student_penalty', waive_penalty: 'waive_session_penalty' };
const expectedArgs = (operation: Operation) => operation === 'approve_manual'
    ? { p_student_id: studentId, p_request_key: manual.requestKey, p_mode: manual.mode, p_quantity: manual.quantity,
        p_expected_legacy_balance: manual.expectedLegacyBalance, p_activity: manual.activity, p_starts_on: manual.startsOn,
        p_ends_on: manual.endsOn, p_reason: manual.reason, p_evidence: manual.evidence }
    : operation === 'settle_penalty'
        ? { p_penalty_id: penaltyId, p_request_key: settlement.requestKey, p_expected_revision: 7, p_reason: settlement.reason }
        : { p_session_id: sessionId, p_student_id: studentId, p_request_key: waiver.requestKey, p_expected_revision: 7, p_reason: waiver.reason };
const descriptor = (operation: Operation): PendingStudentCreditOperation => ({ operation, studentId,
    requestKey: operation === 'approve_manual' ? manual.requestKey : operation === 'settle_penalty' ? settlement.requestKey : waiver.requestKey,
    reason: operation === 'approve_manual' ? manual.reason : operation === 'settle_penalty' ? settlement.reason : waiver.reason,
    ...(operation === 'approve_manual' ? {} : { penaltyId, sessionId }) });
const start = (api: Operations, operation: Operation, changes: Record<string, any> = {}, relatedId?: string) =>
    operation === 'approve_manual' ? api.approve({ ...manual, ...changes })
        : operation === 'settle_penalty' ? api.settle({ ...settlement, ...changes }, relatedId === undefined ? sessionId : relatedId)
            : api.waive({ ...waiver, ...changes }, relatedId === undefined ? penaltyId : relatedId);
const receipt = (name: string, args: Record<string, any>) => ({ data: name === names.approve_manual
    ? { student_id: args.p_student_id, request_key: args.p_request_key, entitlement_id: 'entitlement', remaining_classes: args.p_quantity }
    : { student_id: args.p_student_id ?? studentId, request_key: args.p_request_key,
        session_id: args.p_session_id ?? sessionId, revision: Math.min(args.p_expected_revision + 1, Number.MAX_SAFE_INTEGER),
        ...(name === names.settle_penalty ? { penalty_id: args.p_penalty_id, settlement_id: 'settlement' } : {}) }, error: null });
const storage = () => {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const harness = (options: {
    store?: StudentCreditIntentStore;
    actor?: string;
    rpc?: (name: string, args: Record<string, any>) => PromiseLike<{ data: any; error: any }>;
    refresh?: () => Promise<void>;
} = {}) => {
    const store = options.store ?? new StudentCreditIntentStore(storage());
    const calls: { name: string; args: Record<string, any> }[] = [];
    let refreshes = 0;
    const api = createStudentCreditOperations({ actorId: options.actor === undefined ? actorId : options.actor, store,
        rpc: async (name, args) => { calls.push({ name, args }); return options.rpc ? await options.rpc(name, args) : receipt(name, args); },
        refresh: async () => { refreshes++; await options.refresh?.(); } });
    return { api, store, calls, refreshes: () => refreshes };
};

for (const operation of operations) {
    test(`${operation} persists an immutable exact allowlisted request before the sole RPC and clears only after refresh`, async () => {
        const persisted = storage();
        const store = new StudentCreditIntentStore(persisted);
        const events: string[] = [];
        const h = harness({ store, rpc: async (name, args) => {
            events.push('rpc');
            const saved = store.get(actorId, studentId)!;
            expect(saved).toEqual({ actorId, operation, descriptor: descriptor(operation), args: expectedArgs(operation) });
            expect(Object.isFrozen(saved)).toBe(true);
            expect(Object.isFrozen(saved.descriptor)).toBe(true);
            expect(Object.isFrozen(saved.args)).toBe(true);
            expect(Object.isFrozen(args)).toBe(true);
            expect(args).toEqual(saved.args);
            return receipt(name, args);
        }, refresh: async () => {
            events.push('refresh');
            expect(store.get(actorId, studentId)).not.toBeNull();
        } });
        const result = await start(h.api, operation);
        expect(h.calls).toEqual([{ name: names[operation], args: expectedArgs(operation) }]);
        expect(result).toEqual(receipt(names[operation], expectedArgs(operation)).data);
        expect(events).toEqual(['rpc', 'refresh']);
        expect(h.api.getPending(studentId)).toBeNull();
        expect(persisted.values.size).toBe(0);
        expect(h.refreshes()).toBe(1);
    });

    test(`${operation} detaches and freezes input, arguments and its evidence-free recovery descriptor`, async () => {
        const persisted = storage();
        const h = harness({ store: new StudentCreditIntentStore(persisted), rpc: async (_name, args) => {
            expect(() => { args.p_reason = 'RPC mutation'; }).toThrow();
            throw new Error('Response lost');
        } });
        const mutable = operation === 'approve_manual' ? { ...manual } : operation === 'settle_penalty' ? { ...settlement } : { ...waiver };
        const attempt = operation === 'approve_manual' ? h.api.approve(mutable as ManualCreditIntent)
            : operation === 'settle_penalty' ? h.api.settle(mutable as PenaltySettlementIntent, sessionId)
                : h.api.waive(mutable as SessionBusinessIntent, penaltyId);
        mutable.reason = 'Changed caller draft';
        await expect(attempt).rejects.toThrow('Response lost');
        expect(Object.isFrozen(mutable)).toBe(false);
        const saved = h.store.get(actorId, studentId)!;
        expect(saved.args).toEqual(expectedArgs(operation));
        expect(h.api.getPending(studentId)).toEqual(descriptor(operation));
        expect(h.api.getPending(studentId)).not.toHaveProperty('args');
        expect(h.api.getPending(studentId)).not.toHaveProperty('actorId');
        expect(h.api.getPending(studentId)).not.toHaveProperty('evidence');
        expect(JSON.stringify(h.api.getPending(studentId))).not.toContain(manual.evidence);
        expect(() => { (saved.descriptor as any).studentId = 'other'; }).toThrow();
        expect(() => { (saved as any).operation = 'arbitrary_rpc'; }).toThrow();
        const copy = JSON.parse(JSON.stringify(saved));
        h.store.set(actorId, studentId, copy);
        copy.args.p_reason = 'Changed store caller';
        expect(h.store.get(actorId, studentId)).toEqual(saved);
    });

    test(`${operation} survives store recreation and replays the original key, IDs and revision after profile changes`, async () => {
        const persisted = storage();
        const first = harness({ store: new StudentCreditIntentStore(persisted), rpc: async () => { throw new Error('Committed response lost'); } });
        await expect(start(first.api, operation)).rejects.toThrow('Committed response lost');
        const original = first.calls[0];
        const serialized = [...persisted.values.values()][0];
        const replacement = harness({ store: new StudentCreditIntentStore(persisted) });
        expect(replacement.api.getPending(studentId)).toEqual(descriptor(operation));
        const edits: Record<string, any>[] = operation === 'approve_manual'
            ? [{ requestKey: 'new-key' }, { quantity: 6 }, { expectedLegacyBalance: -3 }, { evidence: 'Replacement evidence' }, { activity: 'torno' }]
            : [{ requestKey: 'new-key' }, { expectedRevision: 19 }, { reason: 'New reason' }];
        if (operation === 'settle_penalty') edits.push({ penaltyId: 'new-penalty' });
        if (operation === 'waive_penalty') edits.push({ sessionId: 'new-session' });
        for (const changes of edits) await expect(start(replacement.api, operation, changes)).rejects.toThrow('pendiente');
        if (operation !== 'approve_manual') await expect(start(replacement.api, operation, {}, 'different-related-id')).rejects.toThrow('pendiente');
        for (const other of operations.filter(other => other !== operation)) {
            await expect(start(replacement.api, other)).rejects.toThrow('pendiente');
        }
        expect(replacement.calls).toEqual([]);
        expect([...persisted.values.values()]).toEqual([serialized]);
        await replacement.api.retry(studentId);
        expect(replacement.calls).toEqual([original]);
        expect(replacement.api.getPending(studentId)).toBeNull();
        expect(replacement.refreshes()).toBe(1);
    });

    test(`${operation} permits exact original replay without a new request key or argument substitution`, async () => {
        const h = harness({ rpc: async () => { throw new Error('lost'); } });
        await expect(start(h.api, operation)).rejects.toThrow('lost');
        const original = h.store.get(actorId, studentId);
        await expect(start(h.api, operation)).rejects.toThrow('lost');
        expect(h.calls).toHaveLength(2);
        expect(h.calls[1]).toEqual(h.calls[0]);
        expect(h.store.get(actorId, studentId)).toEqual(original);
        expect(h.refreshes()).toBe(0);
    });

    test(`${operation} retains its exact intent after a valid commit receipt when authoritative refresh fails`, async () => {
        const persisted = storage();
        const first = harness({ store: new StudentCreditIntentStore(persisted), refresh: async () => { throw new Error('Refresh unavailable'); } });
        await expect(start(first.api, operation)).rejects.toThrow('Refresh unavailable');
        const original = first.store.get(actorId, studentId);
        const next = harness({ store: new StudentCreditIntentStore(persisted) });
        await expect(start(next.api, operation, { requestKey: 'replacement-key' })).rejects.toThrow('pendiente');
        expect(next.store.get(actorId, studentId)).toEqual(original);
        expect(next.calls).toEqual([]);
        await next.api.retry(studentId);
        expect(next.calls).toEqual(first.calls);
        expect(next.api.getPending(studentId)).toBeNull();
        expect(next.refreshes()).toBe(1);
    });
}

test('default sessionStorage persists all three operations across recreation, with actor/student rather than request-key namespaces', async () => {
    const persisted = storage();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: persisted } });
    try {
        for (const operation of operations) {
            const first = harness({ store: new StudentCreditIntentStore(), rpc: async () => { throw new Error('lost'); } });
            await expect(start(first.api, operation)).rejects.toThrow('lost');
            const keys = [...persisted.values.keys()];
            expect(keys).toEqual([`student-credit-intent:${JSON.stringify([actorId, studentId])}`]);
            expect(keys[0]).not.toContain(descriptor(operation).requestKey);
            const restored = harness({ store: new StudentCreditIntentStore() });
            expect(restored.api.getPending(studentId)).toEqual(descriptor(operation));
            await restored.api.retry(studentId);
            expect(restored.calls).toEqual(first.calls);
            expect(persisted.values.size).toBe(0);
        }
    } finally {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

test('Node fallback store retains frozen copies and retries without browser storage', async () => {
    const h = harness({ store: new StudentCreditIntentStore(), rpc: async () => { throw new Error('lost'); } });
    await expect(h.api.approve(manual)).rejects.toThrow('lost');
    expect(h.api.getPending(studentId)).toEqual(descriptor('approve_manual'));
    const next = harness({ store: h.store });
    await next.api.retry(studentId);
    expect(next.calls).toEqual(h.calls);
    expect(h.store.get(actorId, studentId)).toBeNull();
});

test('actor isolation prevents discovering, replaying or clearing another actor intent, including moved storage blobs', async () => {
    const persisted = storage();
    const first = harness({ store: new StudentCreditIntentStore(persisted), rpc: async () => { throw new Error('lost'); } });
    await expect(first.api.approve(manual)).rejects.toThrow('lost');
    const original = first.store.get(actorId, studentId);
    const other = harness({ actor: 'other-owner', store: new StudentCreditIntentStore(persisted) });
    expect(other.api.getPending(studentId)).toBeNull();
    await expect(other.api.retry(studentId)).rejects.toThrow('No hay');
    expect(other.calls).toEqual([]);
    await other.api.approve({ ...manual, requestKey: 'other-key' });
    expect(first.store.get(actorId, studentId)).toEqual(original);
    const raw = [...persisted.values.values()][0];
    const otherKey = `student-credit-intent:${JSON.stringify(['other-owner', studentId])}`;
    persisted.setItem(otherKey, raw);
    expect(() => other.api.getPending(studentId)).toThrow('actor');
    await expect(other.api.retry(studentId)).rejects.toThrow('actor');
    expect(other.calls).toHaveLength(1);
    expect(persisted.getItem(otherKey)).toBe(raw);
    expect(first.store.get(actorId, studentId)).toEqual(original);
});

test('homonyms are independent by student ID and namespace delimiters cannot collide', async () => {
    const persisted = storage();
    const h = harness({ store: new StudentCreditIntentStore(persisted), rpc: async () => { throw new Error('lost'); } });
    const homonyms = [{ id: studentId, name: 'Alex Perez' }, { id: 'student-second', name: 'Alex Perez' }];
    for (const student of homonyms) await expect(h.api.approve({ ...manual, studentId: student.id })).rejects.toThrow('lost');
    expect(persisted.values.size).toBe(2);
    const next = harness({ store: new StudentCreditIntentStore(persisted) });
    await next.api.retry(homonyms[1].id);
    expect(next.calls[0].args.p_student_id).toBe(homonyms[1].id);
    expect(next.api.getPending(homonyms[0].id)?.studentId).toBe(homonyms[0].id);
    expect(next.api.getPending(homonyms[1].id)).toBeNull();
    for (const [actor, student] of [['a:b', 'c'], ['a', 'b:c']]) {
        const api = harness({ actor, store: new StudentCreditIntentStore(persisted), rpc: async () => { throw new Error('lost'); } }).api;
        await expect(api.approve({ ...manual, studentId: student })).rejects.toThrow('lost');
        expect(api.getPending(student)?.studentId).toBe(student);
    }
    expect(persisted.values.size).toBe(3);
});

test('user/student lock spans RPC and refresh across factories, without blocking independent actors or students', async () => {
    const persisted = storage();
    let releaseRpc!: () => void;
    let releaseRefresh!: () => void;
    let refreshing!: () => void;
    const rpcGate = new Promise<void>(resolve => { releaseRpc = resolve; });
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const refreshEntered = new Promise<void>(resolve => { refreshing = resolve; });
    const first = harness({ store: new StudentCreditIntentStore(persisted), rpc: async (name, args) => {
        await rpcGate; return receipt(name, args);
    }, refresh: async () => { refreshing(); await refreshGate; } });
    const second = harness({ store: new StudentCreditIntentStore(persisted) });
    const attempt = first.api.approve(manual);
    try {
        for (const operation of operations) await expect(start(second.api, operation)).rejects.toThrow('Ya se esta');
        await expect(second.api.retry(studentId)).rejects.toThrow('Ya se esta');
        const otherActor = harness({ actor: 'independent-owner', store: new StudentCreditIntentStore(persisted) });
        await otherActor.api.approve(manual);
        await second.api.approve({ ...manual, studentId: 'independent-student' });
        expect(first.calls).toHaveLength(1);
        expect(second.calls).toHaveLength(1);
        releaseRpc();
        await refreshEntered;
        await expect(second.api.retry(studentId)).rejects.toThrow('Ya se esta');
        expect(first.api.getPending(studentId)).not.toBeNull();
    } finally {
        releaseRpc(); releaseRefresh(); await attempt;
    }
    expect(first.api.getPending(studentId)).toBeNull();
    await second.api.approve({ ...manual, requestKey: 'explicit-next-key' });
    expect(second.calls).toHaveLength(2);
});

for (const code of ['P0001', '42501', '40001', '22003', '23505', '0A000', '55P03']) {
    test(`${code} refreshes before clearing a definite SQL rejection and preserves its error code without new writes`, async () => {
        for (const operation of operations) {
            const store = new StudentCreditIntentStore(storage());
            const h = harness({ store, rpc: async () => ({ data: null, error: { code, message: 'Original SQL rejection' } }),
                refresh: async () => { expect(store.get(actorId, studentId)?.descriptor).toEqual(descriptor(operation)); } });
            await expect(start(h.api, operation)).rejects.toMatchObject({ code, message: 'Original SQL rejection' });
            expect(h.calls).toEqual([{ name: names[operation], args: expectedArgs(operation) }]);
            expect(h.refreshes()).toBe(1);
            expect(h.api.getPending(studentId)).toBeNull();
        }
    });
    test(`${code} refresh failure after SQL rejection keeps the original payload for exact replay after reload`, async () => {
        for (const operation of operations) {
            const persisted = storage();
            const first = harness({ store: new StudentCreditIntentStore(persisted), rpc: async () => ({ data: null, error: { code, message: 'rejected' } }),
                refresh: async () => { throw new Error('Rejected refresh unavailable'); } });
            await expect(start(first.api, operation)).rejects.toThrow('Rejected refresh unavailable');
            const original = first.store.get(actorId, studentId);
            const next = harness({ store: new StudentCreditIntentStore(persisted) });
            await expect(start(next.api, operation, { requestKey: 'new-key' })).rejects.toThrow('pendiente');
            expect(next.store.get(actorId, studentId)).toEqual(original);
            expect(next.calls).toEqual([]);
            await next.api.retry(studentId);
            expect(next.calls).toEqual(first.calls);
            expect(next.api.getPending(studentId)).toBeNull();
        }
    });
}

for (const code of ['08000', '08003', '08006', '08001', '08007', '57014', '57P01', 'PGRST000', 'PGRST301', 'FETCH', 'ABCDE', undefined]) {
    test(`${code ?? 'uncoded transport'} keeps every original intent and never refreshes or substitutes a write`, async () => {
        for (const operation of operations) {
            const h = harness({ rpc: async () => ({ data: null, error: { code, message: 'Ambiguous result' } }) });
            await expect(start(h.api, operation)).rejects.toMatchObject({ code, message: 'Ambiguous result' });
            const original = h.store.get(actorId, studentId);
            await expect(h.api.retry(studentId)).rejects.toThrow('Ambiguous result');
            expect(h.calls).toHaveLength(2);
            expect(h.calls[1]).toEqual(h.calls[0]);
            expect(h.store.get(actorId, studentId)).toEqual(original);
            expect(h.refreshes()).toBe(0);
        }
    });
}

test('thrown definite SQL errors preserve code after refresh; thrown transport errors retain the intent', async () => {
    for (const code of ['42501', '08006', 'PGRST000']) {
        const h = harness({ rpc: async () => { throw Object.assign(new Error('RPC rejected'), { code }); } });
        await expect(h.api.approve(manual)).rejects.toMatchObject({ code });
        expect(h.refreshes()).toBe(code === '42501' ? 1 : 0);
        expect(h.api.getPending(studentId) === null).toBe(code === '42501');
    }
});

test('approval receipts remain historical snapshots and cannot replace the authoritative refreshed balance', async () => {
    const state = { remaining: 1, revision: 30 };
    const h = harness({ refresh: async () => { state.remaining = 2; state.revision = 31; } });
    const result = await h.api.approve(manual);
    expect(result.remaining_classes).toBe(4);
    expect(state).toEqual({ remaining: 2, revision: 31 });
    expect(h.api.getPending(studentId)).toBeNull();
});

for (const operation of operations) {
    test(`${operation} forged or malformed receipts cannot refresh or clear the original durable intent`, async () => {
        const base = receipt(names[operation], expectedArgs(operation)).data;
        const data: any[] = [null, {}, [], 'receipt', { ...base, student_id: 'foreign' }, { ...base, student_id: '' },
            { ...base, request_key: 'foreign' }, { ...base, request_key: undefined }];
        if (operation === 'approve_manual') {
            for (const entitlement_id of ['', ' ', null, 3]) data.push({ ...base, entitlement_id });
            for (const remaining_classes of [undefined, null, '4', 1.5, -1, 2147483648, Number.MAX_SAFE_INTEGER + 1]) data.push({ ...base, remaining_classes });
        } else {
            for (const session_id of ['', 'foreign', undefined]) data.push({ ...base, session_id });
            for (const revision of [undefined, null, '8', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) data.push({ ...base, revision });
            if (operation === 'settle_penalty') {
                for (const penalty_id of ['', 'foreign', undefined]) data.push({ ...base, penalty_id });
                for (const settlement_id of ['', ' ', null, 4]) data.push({ ...base, settlement_id });
            }
        }
        for (const invalid of data) {
            const persisted = storage();
            const h = harness({ store: new StudentCreditIntentStore(persisted), rpc: async () => ({ data: invalid, error: null }) });
            await expect(start(h.api, operation)).rejects.toThrow('comprobante');
            const original = h.store.get(actorId, studentId);
            expect(original?.descriptor).toEqual(descriptor(operation));
            expect(h.refreshes()).toBe(0);
            const next = harness({ store: new StudentCreditIntentStore(persisted) });
            await next.api.retry(studentId);
            expect(next.calls).toEqual(h.calls);
        }
    });
}

test('manual approval validates exact raw balances, PostgreSQL integers, activity, real dates and bounded audit text before persistence', async () => {
    const invalid: Record<string, any>[] = [
        ...['', ' ', null, 3].flatMap(value => [{ studentId: value }, { requestKey: value }]),
        ...[0, -1, 1.5, '4', null, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER + 1].map(quantity => ({ quantity })),
        ...[undefined, '4', 1.5, NaN, Infinity, 2147483648, -2147483649].map(expectedLegacyBalance => ({ expectedLegacyBalance })),
        ...['', 'legacy', null].map(mode => ({ mode })),
        ...['', 'feriado', 'modelado', null].map(activity => ({ activity })),
        ...['2026-02-29', '2026-04-31', '1900-02-29', '0000-01-01', '2026-1-01', '2026-10-12T00:00:00Z', 'infinity', null].flatMap(value => [{ startsOn: value }, { endsOn: value }]),
        { startsOn: '2026-12-01', endsOn: '2026-11-01' },
        ...['', ' ', null, 3, 'r'.repeat(2001)].map(reason => ({ reason })),
        ...['', ' ', null, 3, 'e'.repeat(10001)].map(evidence => ({ evidence }))
    ];
    const persisted = storage();
    const h = harness({ store: new StudentCreditIntentStore(persisted) });
    for (const changes of invalid) await expect(h.api.approve({ ...manual, ...changes })).rejects.toThrow();
    const missing = { ...manual } as any;
    delete missing.expectedLegacyBalance;
    await expect(h.api.approve(missing)).rejects.toThrow();
    expect(h.calls).toEqual([]);
    expect(h.refreshes()).toBe(0);
    expect(persisted.values.size).toBe(0);
});

test('new_manual accepts unknown, zero and negative raw legacy observations, integer limits, leap dates and exact untrimmed audit text', async () => {
    const h = harness();
    for (const expectedLegacyBalance of [null, 0, -4, -2147483648, 2147483647]) {
        await h.api.approve({ ...manual, expectedLegacyBalance, quantity: 2147483647, reason: 'r'.repeat(2000), evidence: 'e'.repeat(10000) });
        expect(h.calls.at(-1)?.args.p_expected_legacy_balance).toBe(expectedLegacyBalance);
    }
    for (const activity of ['mesa', 'torno', 'coworking', 'workshop', 'privada'] as const) {
        await h.api.approve({ ...manual, activity, startsOn: '2000-02-29', endsOn: '2000-02-29', reason: '  Exact reason  ', evidence: '  Exact evidence  ' });
        expect(h.calls.at(-1)?.args).toMatchObject({ p_activity: activity, p_reason: '  Exact reason  ', p_evidence: '  Exact evidence  ' });
    }
    expect(h.calls).toHaveLength(10);
});

test('legacy reconciliation requires a known positive balance and its exact quantity without inferring from any other field', async () => {
    const h = harness();
    for (const expectedLegacyBalance of [null, 0, -4, 5]) {
        await expect(h.api.approve({ ...manual, mode: 'reconcile_legacy', expectedLegacyBalance })).rejects.toThrow();
    }
    expect(h.calls).toEqual([]);
    await h.api.approve({ ...manual, mode: 'reconcile_legacy', expectedLegacyBalance: 4 });
    expect(h.calls[0].args).toMatchObject({ p_mode: 'reconcile_legacy', p_quantity: 4, p_expected_legacy_balance: 4 });
});

for (const operation of ['settle_penalty', 'waive_penalty'] as const) {
    test(`${operation} requires nonempty exact IDs, a nonnegative safe revision and bounded reason without imposing client UUID authority`, async () => {
        const h = harness();
        const invalid = [
            ...['', ' ', null, 3].flatMap(value => [{ studentId: value }, { requestKey: value },
                operation === 'settle_penalty' ? { penaltyId: value } : { sessionId: value }]),
            ...[-1, 1.5, '7', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ({ expectedRevision })),
            ...['', ' ', null, 3, 'r'.repeat(2001)].map(reason => ({ reason }))
        ];
        for (const changes of invalid) await expect(start(h.api, operation, changes)).rejects.toThrow();
        for (const related of ['', ' ']) await expect(start(h.api, operation, {}, related)).rejects.toThrow();
        if (operation === 'waive_penalty') {
            for (const changed of ['approve_exception', 'cancel_reservation', 'arbitrary_rpc']) {
                await expect(start(h.api, operation, { operation: changed })).rejects.toThrow();
            }
        }
        expect(h.calls).toEqual([]);
        expect(h.api.getPending(studentId)).toBeNull();
        for (const expectedRevision of [0, Number.MAX_SAFE_INTEGER]) await start(h.api, operation, { expectedRevision });
        expect(h.calls.map(call => call.args.p_expected_revision)).toEqual([0, Number.MAX_SAFE_INTEGER]);
    });
}

test('all input objects reject unsupported owner/sede claims, selectors, tokens, RPC names and optional exception fields', async () => {
    const h = harness();
    for (const operation of operations) {
        for (const field of ['sedeId', 'actorId', 'ownerId', 'manualCreditId', 'giftCardId', 'periodId', 'source', 'token', 'apiKey', 'rpc', 'kind', 'unsupported']) {
            await expect(start(h.api, operation, { [field]: 'not-allowed' })).rejects.toThrow('Campos');
        }
        await expect(start(h.api, operation, { kind: undefined })).rejects.toThrow('Campos');
        const value = operation === 'approve_manual' ? { ...manual } : operation === 'settle_penalty' ? { ...settlement } : { ...waiver };
        Object.defineProperty(value, 'hidden', { value: 'not-allowed' });
        const attempt = operation === 'approve_manual' ? h.api.approve(value as ManualCreditIntent)
            : operation === 'settle_penalty' ? h.api.settle(value as PenaltySettlementIntent, sessionId)
                : h.api.waive(value as SessionBusinessIntent, penaltyId);
        await expect(attempt).rejects.toThrow('Campos');
    }
    expect(h.calls).toEqual([]);
    expect(h.api.getPending(studentId)).toBeNull();
});

for (const operation of operations) {
    test(`${operation} validates every deserialized envelope, descriptor and RPC argument before any replay or replacement`, async () => {
        const persisted = storage();
        const initial = harness({ store: new StudentCreditIntentStore(persisted), rpc: async () => { throw new Error('lost'); } });
        await expect(start(initial.api, operation)).rejects.toThrow('lost');
        const [key, raw] = [...persisted.values.entries()][0];
        const mutations: ((intent: any) => void)[] = [
            value => { value.operation = 'arbitrary_rpc'; }, value => { value.operation = '__proto__'; },
            value => { value.actorId = 'foreign-actor'; }, value => { value.rpc = 'delete_student'; },
            value => { value.descriptor.studentId = 'foreign-student'; }, value => { value.descriptor.requestKey = 'foreign-key'; },
            value => { value.descriptor.operation = operations.find(other => other !== operation); },
            value => { value.descriptor.reason = 'altered'; }, value => { value.descriptor.evidence = 'secret'; },
            value => { value.args.p_request_key = 'foreign-key'; }, value => { delete value.args.p_request_key; },
            value => { value.args.p_reason = 'altered'; }, value => { value.args.p_sede_id = 'foreign-sede'; },
            value => { value.args.p_source = 'replacement-credit'; }, value => { value.token = 'not-allowed'; },
            value => { value.args = []; }, value => { value.descriptor = null; }
        ];
        if (operation === 'approve_manual') mutations.push(
            value => { value.args.p_student_id = 'foreign-student'; }, value => { value.args.p_quantity = 0; },
            value => { value.args.p_expected_legacy_balance = '4'; }, value => { value.args.p_mode = 'automatic'; },
            value => { value.args.p_activity = 'feriado'; }, value => { value.args.p_starts_on = '2026-02-29'; },
            value => { value.args.p_evidence = ''; }, value => { value.args.p_mode = 'reconcile_legacy'; }
        );
        else mutations.push(value => { value.args.p_expected_revision = -1; }, value => { value.descriptor.sessionId = ''; },
            value => { value.descriptor.penaltyId = ''; }, ...(operation === 'settle_penalty'
                ? [(value: any) => { value.args.p_penalty_id = 'foreign-penalty'; }]
                : [(value: any) => { value.args.p_session_id = 'foreign-session'; }, (value: any) => { value.args.p_student_id = 'foreign-student'; }]));
        const invalid = ['', '{corrupt', 'null', '[]', '"intent"', ...mutations.map(mutate => {
            const value = JSON.parse(raw); mutate(value); return JSON.stringify(value);
        })];
        for (const serialized of invalid) {
            persisted.setItem(key, serialized);
            const h = harness({ store: new StudentCreditIntentStore(persisted) });
            expect(() => h.api.getPending(studentId)).toThrow();
            await expect(h.api.retry(studentId)).rejects.toThrow();
            await expect(start(h.api, operation)).rejects.toThrow();
            expect(h.calls).toEqual([]);
            expect(h.refreshes()).toBe(0);
            expect(persisted.getItem(key)).toBe(serialized);
        }
        persisted.setItem(key, raw);
        const restored = harness({ store: new StudentCreditIntentStore(persisted) });
        await restored.api.retry(studentId);
        expect(restored.calls).toEqual(initial.calls);
    });
}

test('missing, unavailable, silent-write-loss or malformed storage cannot generate a recovery key or start an unpersisted RPC', async () => {
    const empty = harness();
    await expect(empty.api.retry(studentId)).rejects.toThrow('No hay');
    expect(empty.calls).toEqual([]);
    for (const unavailable of [
        { ...storage(), setItem: () => { throw new Error('Storage write denied'); } },
        { ...storage(), getItem: () => { throw new Error('Storage read denied'); } },
        { ...storage(), setItem: () => {} },
        { ...storage(), getItem: () => '{corrupt' }
    ]) {
        const h = harness({ store: new StudentCreditIntentStore(unavailable) });
        for (const operation of operations) await expect(start(h.api, operation)).rejects.toThrow();
        expect(h.calls).toEqual([]);
        expect(h.refreshes()).toBe(0);
    }
});

test('invalid actor/student namespaces fail before storage or RPC and do not expose any foreign intent', async () => {
    for (const actor of ['', ' ', null, 3]) expect(() => harness({ actor: actor as string })).toThrow('actor');
    const h = harness();
    for (const id of ['', ' ', null, 3]) {
        expect(() => h.api.getPending(id as string)).toThrow('IDs');
        await expect(h.api.retry(id as string)).rejects.toThrow('IDs');
    }
    expect(h.calls).toEqual([]);
});
