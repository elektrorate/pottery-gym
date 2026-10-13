import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readAllRows } from '../../context/data/readAllRows';
import { createStudentCreditOperations, StudentCreditIntentStore } from '../../context/data/studentCreditOps';
import type { ClassSession } from '../../types';
import { attachSessionBusinessState } from '../../utils/sessionBusiness';
import { attachStudentCreditProfiles } from '../../utils/studentCredits';
import { mapStudentRowToModel } from '../../utils/studentLifecycle';

// Real Supabase query builders, entirely in-memory PostgREST transport; no env or remote access.
const sedeId = 'sede';
type Tables = Record<string, any[]>;
type Page = { data: any[] | null; error: any; count?: number | null };
type Call = { table: string; offset: number; limit: number | null; order: string | null; exact: boolean };
const orderColumns: Record<string, string[]> = {
  sessions: ['id'], students: ['id'], session_students: ['session_id', 'student_id'],
  session_business_state: ['session_id', 'student_id'], student_credit_profile: ['student_id']
};
const postgrest = (tables: Tables, options: {
  cap?: number;
  respond?: (call: Call, page: Page) => Page | PromiseLike<Page>;
} = {}) => {
  const calls: Call[] = [];
  const client = createClient('https://pagination.supabase.invalid', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const table = url.pathname.replace('/rest/v1/', '');
      expect(url.origin).toBe('https://pagination.supabase.invalid');
      expect(Object.hasOwn(tables, table)).toBe(true);
      expect(init?.method).toBe('GET');
      expect(url.searchParams.get('select')).toBe('*');
      expect(url.searchParams.get('sede_id')).toBe(`eq.${sedeId}`);
      const headers = new Headers(init?.headers);
      const call: Call = { table, offset: Number(url.searchParams.get('offset') || 0),
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : null,
        order: url.searchParams.get('order'), exact: headers.get('prefer')?.includes('count=exact') ?? false };
      expect(headers.get('prefer')).toBe(call.exact ? 'count=exact' : null);
      calls.push(call);
      const rows = tables[table].filter(row => row.sede_id === sedeId).slice();
      if (call.order) {
        const columns = call.order.split(',').map(value => value.split('.')[0]);
        rows.sort((left, right) => {
          for (const column of columns) {
            if (left[column] < right[column]) return -1;
            if (left[column] > right[column]) return 1;
          }
          return 0;
        });
      }
      let page: Page = { data: rows.slice(call.offset, call.offset + Math.min(call.limit ?? 1000, options.cap ?? 1000)),
        error: null, count: call.exact ? rows.length : null };
      if (options.respond) page = await options.respond(call, page);
      if (page.error) return Response.json(page.error, { status: 503 });
      const range = page.data?.length ? `${call.offset}-${call.offset + page.data.length - 1}` : '*';
      return Response.json(page.data, { status: 200,
        headers: { 'content-range': `${range}/${page.count ?? '*'}` } });
    } }
  });
  const query = (table: string, offset: number, limit: number, requireExactCount = true) => {
    let builder = client.from(table).select('*', requireExactCount ? { count: 'exact' } : {}).eq('sede_id', sedeId);
    for (const column of orderColumns[table] || ['id']) builder = builder.order(column, { ascending: true });
    return builder.range(offset, offset + limit - 1);
  };
  return { calls, client, query, read: (table: string, pageSize?: number, options: { requireExactCount?: boolean } = {}) =>
    readAllRows((offset, limit) => query(table, offset, limit, options.requireExactCount !== false), pageSize, options) };
};

const fixture = () => {
  const students = Array.from({ length: 1103 }, (_, index) => ({ id: `student-${String(index).padStart(4, '0')}`,
    sede_id: sedeId, name: 'Alex', phone: '', status: 'new', student_category: 'temporal', classes_remaining: 7,
    payment_status: null, current_membership_period_id: null, archived_at: null }));
  const profiles = students.map(student => ({ student_id: student.id, sede_id: sedeId,
    legacy_observed_balance: student.classes_remaining, legacy_raw_state: { ...student },
    manual_credits: [{ entitlement_id: `manual-${student.id}`, student_id: student.id, sede_id: sedeId, mode: 'new_manual',
      quantity: 5000, remaining_classes: 5000, activity: 'mesa', starts_on: '2026-10-01', ends_on: '2026-10-31',
      reason: 'Approved original right', evidence: 'Verified evidence', approved_by: 'owner', approved_at: '2026-10-01T12:00:00Z' }],
    penalty_incidents: [] as any[], can_approve_manual_credit: true, can_reconcile_legacy: true }));
  const roster: any[] = [];
  const business: any[] = [];
  const sessions = Array.from({ length: 1207 }, (_, index) => {
    const sessionId = `session-${String(index).padStart(4, '0')}`;
    for (const studentIndex of [0, index % (students.length - 1) + 1]) {
      const student = students[studentIndex];
      const penaltyId = `penalty-${sessionId}-${student.id}`;
      const manualId = `manual-${student.id}`;
      roster.push({ session_id: sessionId, student_id: student.id, student_name: student.name,
        sede_id: sedeId, manual_credit_id: manualId });
      business.push({ session_id: sessionId, student_id: student.id, sede_id: sedeId, policy_version: 2,
        reservation_state: 'reserved', billing_state: 'incident', billing_kind: 'no_show', penalty_id: penaltyId,
        penalty_state: 'pending', funding_manual_credit_id: manualId, finalized_revision: 5 });
      profiles[studentIndex].penalty_incidents.push({ penalty_id: penaltyId, student_id: student.id, sede_id: sedeId,
        session_id: sessionId, expected_revision: 7, incident_revision: 5, kind: 'no_show', penalty_state: 'pending',
        original_penalty_state: 'pending', billing_state: 'incident', original_period_id: null,
        original_gift_card_id: null, original_manual_credit_id: manualId, incident_reason: 'Original historical incident',
        is_pending: true, is_waived: false });
    }
    return { id: sessionId, sede_id: sedeId, revision: 7, attendance_policy_version: 2, date: '2026-10-11',
      start_time: '18:00', end_time: '20:00', class_type: 'mesa', completed_at: '2026-10-11T20:00:00Z' };
  });
  return { students: students.reverse(), sessions: sessions.reverse(), session_students: roster.reverse(),
    session_business_state: business.reverse(), student_credit_profile: profiles.reverse() };
};

const project = (tables: Tables) => {
  const sessions = tables.sessions.map(row => {
    const roster = tables.session_students.filter(item => item.session_id === row.id);
    const session: ClassSession = { id: row.id, sedeId: row.sede_id, revision: row.revision,
      attendancePolicyVersion: row.attendance_policy_version, date: row.date, startTime: row.start_time,
      endTime: row.end_time, classType: row.class_type, completedAt: row.completed_at,
      students: roster.map(item => item.student_name), studentIds: roster.map(item => item.student_id),
      manualCreditIdByStudentId: Object.fromEntries(roster.map(item => [item.student_id, item.manual_credit_id])) };
    return attachSessionBusinessState(session, tables.session_business_state.filter(item => item.session_id === row.id));
  });
  return attachStudentCreditProfiles(tables.students.map(mapStudentRowToModel), tables.student_credit_profile,
    sessions, [], '2026-10-12');
};

test('complete historical profiles join more than 1000 sessions, rosters, business rows and homonymous students', async () => {
  const tables = fixture();
  const h = postgrest(tables);
  const capped = await h.client.from('sessions').select('*').eq('sede_id', sedeId).order('id');
  expect(capped.data).toHaveLength(1000);
  expect(capped.count).toBeNull();
  expect(() => project({ ...tables, sessions: capped.data! })).toThrow();
  h.calls.length = 0;
  const loaded: Tables = {};
  await Promise.all(Object.keys(tables).map(async table => {
    const result = await h.read(table);
    expect(result.error).toBeNull();
    expect(Object.keys(result).sort()).toEqual(['data', 'error']);
    expect(result.data).toHaveLength(tables[table].length);
    loaded[table] = result.data;
  }));
  expect(Object.fromEntries(Object.entries(loaded).map(([table, rows]) => [table, rows.length]))).toEqual({
    students: 1103, sessions: 1207, session_students: 2414, session_business_state: 2414, student_credit_profile: 1103
  });
  for (const table of Object.keys(tables)) {
    const count = tables[table].length;
    expect(h.calls.filter(call => call.table === table)).toEqual(Array.from({ length: Math.ceil(count / 500) }, (_, page) => ({
      table, offset: page * 500, limit: page === 0 ? 500 : Math.min(500, count - page * 500),
      order: orderColumns[table].map(column => `${column}.asc`).join(','), exact: true
    })));
  }
  const students = project(loaded);
  expect(students).toHaveLength(1103);
  expect(students[0].id).toBe('student-0000');
  expect(students[0].pendingPenalties).toHaveLength(1207);
  expect(students[0].pendingPenalties!.at(-1)).toMatchObject({ sessionId: 'session-1206', canSettle: true });
  expect(students.flatMap(student => student.pendingPenalties)).toHaveLength(2414);
  expect(students.every(student => student.pendingPenalties!.every(penalty => penalty.canSettle))).toBe(true);
  expect(students.every(student => student.classesRemaining === 7 && student.paymentStatus === null)).toBe(true);
});

for (const cap of [137, 1]) {
  test(`exact counts complete short pages under a server cap of ${cap} using actual-row offsets`, async () => {
    const rows = Array.from({ length: 1207 }, (_, id) => ({ id, sede_id: sedeId })).reverse();
    const h = postgrest({ students: [...rows, { id: -1, sede_id: 'foreign' }] }, { cap });
    const result = await h.read('students');
    expect(result.error).toBeNull();
    expect(result.data.map(row => row.id)).toEqual(Array.from({ length: 1207 }, (_, id) => id));
    expect(h.calls.map(call => [call.offset, call.limit])).toEqual(Array.from({ length: Math.ceil(1207 / cap) }, (_, page) => [
      page * cap, page === 0 ? 500 : Math.min(500, 1207 - page * cap)
    ]));
    expect(h.calls.every(call => call.exact && call.order === 'id.asc')).toBe(true);
  });
}

for (const cap of [2, 137, 1]) {
  for (const count of [7, 1207]) {
    test(`count-free reads complete ${count} rows under a server cap of ${cap} through an empty page`, async () => {
      const rows = Array.from({ length: count }, (_, id) => ({ id, sede_id: sedeId,
        legacy_raw_state: { original_index: id, unknown_legacy_field: `legacy-${id}` } }));
      const h = postgrest({ students: [...rows].reverse().concat({ ...rows[0], sede_id: 'foreign' }) }, { cap });
      const result = await h.read('students', 1000, { requireExactCount: false });
      expect(result).toEqual({ data: rows, error: null });
      expect(Object.keys(result).sort()).toEqual(['data', 'error']);
      expect(h.calls).toEqual([...Array.from({ length: Math.ceil(count / cap) }, (_, page) => page * cap), count]
        .map(offset => ({ table: 'students', offset, limit: 1000, order: 'id.asc', exact: false })));
    });
  }
}

test('count-free reads require an empty page after exact multiples and accept an initially empty dataset', async () => {
  for (const [count, cap] of [[0, 1000], [6, 2], [2000, 1000]]) {
    const rows = Array.from({ length: count }, (_, id) => ({ id, sede_id: sedeId }));
    const h = postgrest({ students: rows }, { cap });
    expect(await h.read('students', 1000, { requireExactCount: false })).toEqual({ data: rows, error: null });
    expect(h.calls).toEqual(Array.from({ length: count / cap + 1 }, (_, page) => ({
      table: 'students', offset: page * cap, limit: 1000, order: 'id.asc', exact: false
    })));
  }
});

test('count-free reads ignore absent, null, mismatched and invalid counts on every page', async () => {
  const rows = Array.from({ length: 7 }, (_, id) => ({ id }));
  for (const counts of [[], [null], [0, 99, 1, 10000, 7], ['7', -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]]) {
    const calls: number[] = [];
    const result = await readAllRows(async (offset, limit) => {
      expect(limit).toBe(1000);
      const count = counts.length ? { count: counts[calls.length % counts.length] as any } : {};
      calls.push(offset);
      return { data: rows.slice(offset, offset + 2), error: null, ...count };
    }, 1000, { requireExactCount: false });
    expect(result).toEqual({ data: rows, error: null });
    expect(calls).toEqual([0, 2, 4, 6, 7]);
  }
});

test('count-free malformed and oversized pages fail closed before or after loading rows', async () => {
  for (const response of [null, undefined, { data: null, error: null }, { data: {}, error: null }, { error: null },
    { data: Array.from({ length: 1001 }, (_, id) => ({ id })), error: null }]) {
    for (const failureOffset of [0, 2]) {
      const calls: number[] = [];
      const result = await readAllRows(async (offset, limit) => {
        calls.push(offset);
        expect(limit).toBe(1000);
        return offset === failureOffset ? response as any : { data: [{ id: 0 }, { id: 1 }], error: null };
      }, 1000, { requireExactCount: false });
      expect(result.data).toEqual([]);
      expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
      expect(calls).toEqual(failureOffset ? [0, 2] : [0]);
    }
  }
});

test('count-free page sizes retain the default and allow up to 1000 without starting invalid queries', async () => {
  for (const pageSize of [undefined, 1, 500, 501, 1000]) {
    const calls: number[] = [];
    const result = await readAllRows(async (offset, limit) => {
      calls.push(offset);
      expect(limit).toBe(pageSize ?? 500);
      return { data: offset ? [] : [{ id: 0 }], error: null };
    }, pageSize, { requireExactCount: false });
    expect(result).toEqual({ data: [{ id: 0 }], error: null });
    expect(calls).toEqual([0, 1]);
  }
  for (const pageSize of [0, -1, 1.5, NaN, Infinity, 1001, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    const result = await readAllRows(async () => { calls++; return { data: [], error: null }; }, pageSize,
      { requireExactCount: false });
    expect(result.data).toEqual([]);
    expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
    expect(calls).toBe(0);
  }
});

test('count-free page errors, throws and rejections discard all rows, including failures on the final empty request', async () => {
  const error = { code: 'PGRST000', message: 'Roster page unavailable', details: null, hint: null };
  const timeout = new Error('session_students.select: timeout');
  const failures: Array<{ fail: () => PromiseLike<Page>; expected: any }> = [
    { fail: () => Promise.resolve({ data: [{ id: 'untrusted' }], error }), expected: error },
    { fail: () => { throw error; }, expected: error },
    { fail: () => Promise.reject(timeout), expected: timeout },
    { fail: () => Promise.reject(null), expected: expect.objectContaining({ code: 'DATA_PAGINATION_ERROR' }) }
  ];
  const rows = Array.from({ length: 4 }, (_, id) => ({ id }));
  for (const { fail, expected } of failures) {
    for (const failureOffset of [0, 2, 4]) {
      const calls: number[] = [];
      const result = await readAllRows((offset, limit) => {
        calls.push(offset);
        expect(limit).toBe(1000);
        return offset === failureOffset ? fail() : Promise.resolve({ data: rows.slice(offset, offset + 2), error: null });
      }, 1000, { requireExactCount: false });
      expect(result.data).toEqual([]);
      if (expected === error || expected === timeout) expect(result.error).toBe(expected);
      else expect(result.error).toEqual(expected);
      expect(calls).toEqual(Array.from({ length: failureOffset / 2 + 1 }, (_, page) => page * 2));
    }
  }
  const h = postgrest({ session_students: rows.map(row => ({ ...row, sede_id: sedeId })) }, { cap: 2,
    respond: (call, page) => call.offset === 4 ? { data: null, error } : page });
  expect(await h.read('session_students', 1000, { requireExactCount: false })).toEqual({ data: [], error });
  expect(h.calls.map(call => [call.offset, call.limit, call.exact])).toEqual([[0, 1000, false], [2, 1000, false], [4, 1000, false]]);
});

test('small custom pages complete an exact multiple without requesting an extra empty page', async () => {
  const h = postgrest({ students: Array.from({ length: 6 }, (_, id) => ({ id, sede_id: sedeId })) });
  expect(await h.read('students', 2)).toEqual({ data: Array.from({ length: 6 }, (_, id) => ({ id, sede_id: sedeId })), error: null });
  expect(h.calls.map(call => [call.offset, call.limit])).toEqual([[0, 2], [2, 2], [4, 2]]);
});

test('only an empty array with an exact zero count is a successful initial empty response', async () => {
  const h = postgrest({ students: [] });
  expect(await h.read('students')).toEqual({ data: [], error: null });
  expect(h.calls).toHaveLength(1);
  for (const count of [undefined, null, 1]) {
    const result = await readAllRows(async () => ({ data: [], error: null, count }));
    expect(result.data).toEqual([]);
    expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
  }
});

test('missing, nonnumeric, negative, fractional and unsafe counts fail closed on every page', async () => {
  for (const count of [undefined, null, '2', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true]) {
    for (const firstPage of [true, false]) {
      const calls: number[] = [];
      const result = await readAllRows(async offset => {
        calls.push(offset);
        return { data: [{ id: offset }], error: null, count: firstPage || offset > 0 ? count as any : 2 };
      }, 1);
      expect(result.data).toEqual([]);
      expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
      expect(calls).toEqual(firstPage ? [0] : [0, 1]);
    }
  }
});

test('insert and delete count drift fail closed, including on the would-be final page', async () => {
  for (const changedCount of [0, 1, 3]) {
    const h = postgrest({ students: [{ id: 0, sede_id: sedeId }, { id: 1, sede_id: sedeId }] }, {
      respond: (call, page) => call.offset ? { ...page, count: changedCount } : page
    });
    const result = await h.read('students', 1);
    expect(result.data).toEqual([]);
    expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR', message: expect.stringContaining('count changed') });
    expect(h.calls.map(call => call.offset)).toEqual([0, 1]);
  }
});

test('empty pages before completion and excess range or count rows never return partial data', async () => {
  const invalid: Page[] = [
    { data: [], error: null, count: 3 },
    { data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null, count: 3 },
    { data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null, count: 4 }
  ];
  for (const finalPage of invalid) {
    const calls: number[] = [];
    const result = await readAllRows(async offset => {
      calls.push(offset);
      return offset ? finalPage : { data: [{ id: 0 }], error: null, count: finalPage.count };
    }, 2);
    expect(result.data).toEqual([]);
    expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
    expect(calls).toEqual([0, 1]);
  }
  const overCount = await readAllRows(async () => ({ data: [{ id: 0 }, { id: 1 }], error: null, count: 1 }));
  expect(overCount.data).toEqual([]);
  expect(overCount.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
});

test('malformed successful bodies and invalid page sizes fail without exposing rows or starting invalid queries', async () => {
  for (const response of [null, undefined, { data: null, error: null, count: 0 },
    { data: {}, error: null, count: 1 }, { error: null, count: 0 }]) {
    const result = await readAllRows(async () => response as any);
    expect(result.data).toEqual([]);
    expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
  }
  for (const pageSize of [0, -1, 1.5, NaN, Infinity, 501, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    const result = await readAllRows(async () => { calls++; return { data: [], error: null, count: 0 }; }, pageSize);
    expect(result.data).toEqual([]);
    expect(result.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
    expect(calls).toBe(0);
  }
});

test('resolved page errors, factory throws and rejected per-page timeouts preserve the original error', async () => {
  const error = { code: 'PGRST205', message: 'Missing dependency', details: 'Table missing', hint: 'Reload after migration' };
  const timeout = new Error('students.select: timeout');
  const failures: Array<{ fail: () => PromiseLike<Page>; expected: any }> = [
    { fail: () => Promise.resolve({ data: [{ id: 'untrusted' }], error, count: 2 }), expected: error },
    { fail: () => { throw error; }, expected: error },
    { fail: () => Promise.reject(timeout), expected: timeout }
  ];
  for (const { fail, expected } of failures) {
    const calls: number[] = [];
    const result = await readAllRows((offset, limit) => {
      calls.push(offset);
      expect(limit).toBe(1);
      return offset ? fail() : Promise.resolve({ data: [{ id: 0 }], error: null, count: 2 });
    }, 1);
    expect(result.data).toEqual([]);
    expect(result.error).toBe(expected);
    expect(calls).toEqual([0, 1]);
  }
  const unknownFailure = await readAllRows(() => Promise.reject(null));
  expect(unknownFailure.data).toEqual([]);
  expect(unknownFailure.error).toMatchObject({ code: 'DATA_PAGINATION_ERROR' });
});

test('a late PostgREST failure retains loaded dependencies and the original credit intent until a complete retry', async () => {
  const initial = fixture();
  const tables = structuredClone(initial);
  let failing = true;
  const h = postgrest(tables, { respond: (call, page) => failing && call.table === 'session_students' && call.offset >= 500
    ? { data: null, error: { code: 'PGRST000', message: 'Roster page unavailable', details: null, hint: null }, count: null } : page });
  const previous = { students: project(initial), tables: initial };
  let retained = previous;
  const rpcCalls: Array<{ name: string; args: Record<string, any> }> = [];
  const store = new StudentCreditIntentStore();
  const operations = createStudentCreditOperations({ actorId: 'owner', store,
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      tables.sessions.find(session => session.id === 'session-1206')!.revision = 8;
      const audit = { settlement_id: 'settlement', settlement_reason: args.p_reason, settled_by: 'owner',
        settled_at: '2026-10-12T08:30:00Z', settlement_revision: 8 };
      for (const profile of tables.student_credit_profile) {
        for (const incident of profile.penalty_incidents) {
          if (incident.session_id === 'session-1206') incident.expected_revision = 8;
          if (incident.penalty_id === args.p_penalty_id) {
            Object.assign(incident, audit, { penalty_state: 'charged', billing_state: 'charged', is_pending: false });
          }
        }
      }
      Object.assign(tables.session_business_state.find(row => row.penalty_id === args.p_penalty_id)!, audit,
        { penalty_state: 'charged', billing_state: 'charged', settlement_debit_id: 'debit' });
      return { data: { student_id: 'student-0000', request_key: args.p_request_key, penalty_id: args.p_penalty_id,
        session_id: 'session-1206', settlement_id: 'settlement', revision: 8 }, error: null };
    },
    refresh: async () => {
      const results = await Promise.all(Object.keys(tables).map(async table => ({ table, ...await h.read(table) })));
      for (const result of results) {
        if (result.error) {
          expect(result.data).toEqual([]);
          throw result.error;
        }
      }
      const loaded = Object.fromEntries(results.map(result => [result.table, result.data]));
      retained = { students: project(loaded), tables: loaded as typeof tables };
    }
  });
  const intent = { studentId: 'student-0000', penaltyId: 'penalty-session-1206-student-0000',
    requestKey: 'original-key', expectedRevision: 7, reason: 'Settle original source' };
  await expect(operations.settle(intent, 'session-1206')).rejects.toMatchObject({ code: 'PGRST000' });
  expect(retained).toBe(previous);
  const saved = store.get('owner', intent.studentId);
  expect(saved?.args).toEqual({ p_penalty_id: intent.penaltyId, p_request_key: intent.requestKey,
    p_expected_revision: intent.expectedRevision, p_reason: intent.reason });
  expect(h.calls.filter(call => call.table === 'session_students').map(call => call.offset)).toEqual([0, 500]);
  failing = false;
  h.calls.length = 0;
  await operations.retry(intent.studentId);
  expect(rpcCalls).toHaveLength(2);
  expect(rpcCalls[1]).toEqual(rpcCalls[0]);
  expect(retained).not.toBe(previous);
  expect(retained.students[0].pendingPenalties!.at(-1)).toMatchObject({ sessionId: 'session-1206', sessionRevision: 8,
    state: 'charged', settlementId: 'settlement', canSettle: false });
  expect(retained.tables.session_students).toHaveLength(2414);
  expect(store.get('owner', intent.studentId)).toBeNull();
  expect(h.calls.filter(call => call.table === 'session_students').map(call => call.offset)).toEqual([0, 500, 1000, 1500, 2000]);
});

test('unchanged counts do not replace mapper validation of duplicate row identities', async () => {
  const tables = fixture();
  const h = postgrest(tables, { respond: (call, page) => call.table === 'student_credit_profile' && call.offset === 1000
    ? { ...page, data: [{ ...tables.student_credit_profile.at(-1) }, ...page.data!.slice(1)] } : page });
  const result = await h.read('student_credit_profile');
  expect(result.error).toBeNull();
  expect(result.data).toHaveLength(1103);
  expect(() => project({ ...tables, student_credit_profile: result.data })).toThrow();
});
