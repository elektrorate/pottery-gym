import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';
import { apiUrl, frontendUrl, projectId, redact, testPassword } from '../../scripts/local-staging-runtime.mjs';

type Row = Record<string, any>;
type Actor = { id: string; token: string };
type Subject = { kind: string; studentId: string; periodId: string; successorId?: string; cardId?: string };
type Session = { id: string; subject: Subject; date: string; metadata: Row };
type Manifest = { version: number; runId: string; today: string; serverNow: string; clockChecks: string; sedeId: string;
  actors: Record<string, string>; subjects: Record<string, Subject> };
const ownSede = '30000000-0000-0000-0000-000000000001';
const foreignSede = '30000000-0000-0000-0000-000000000002';
const anonKey = process.env.TEST_LOCAL_SUPABASE_ANON_KEY || '';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const businessTables = ['session_business_exceptions', 'session_business_penalties', 'session_business_waivers',
  'session_business_billing', 'session_business_events', 'session_business_state'];
const stateColumns = ['session_id', 'student_id', 'sede_id', 'policy_version', 'reservation_state', 'cancelled_at',
  'cancellation_kind', 'exception_id', 'exception_kind', 'exception_period_id', 'exception_reason', 'approved_by',
  'billing_state', 'billing_kind', 'penalty_id', 'penalty_state', 'penalty_reason', 'cancellation_reason', 'cancelled_by',
  'exception_gift_card_id', 'approved_at', 'billing_debit_id', 'funding_period_id', 'funding_gift_card_id',
  'waiver_reason', 'waived_by', 'waived_at', 'finalized_revision',
  'funding_manual_credit_id', 'exception_manual_credit_id', 'penalty_manual_credit_id', 'settlement_id',
  'settlement_debit_id', 'settlement_reason', 'settled_by', 'settled_at', 'settlement_revision'];
let manifest: Manifest;
let owner: Actor;
let other: Actor;
let reader: Actor;
let employee: Actor;
let supervisor: Actor;
let seedBefore: Row;

function jwtRole(token: string) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role; } catch { return undefined; }
}

// Business writes always use a real password-login JWT and the public anon key.
// This worker never imports the DB/bootstrap helper or receives admin credentials.
async function http(actor: Actor | null, route: string, method = 'GET', body?: unknown) {
  if (!/^\/(?:rest\/v1\/|auth\/v1\/(?:token\?|user$))/.test(route) || route.includes('://')
    || !['GET', 'POST', 'PATCH'].includes(method) || jwtRole(anonKey) !== 'anon'
    || (actor && jwtRole(actor.token) !== 'authenticated')) throw new Error('Only local public-key Auth/REST operations allowed.');
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { apikey: anonKey, Authorization: `Bearer ${actor?.token || anonKey}`, 'Content-Type': 'application/json',
        Prefer: 'return=representation' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new Error(`Local transport failed: ${method} ${route.split('?')[0]}`); }
  let data: any;
  try { const text = await response.text(); data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Local API returned non-JSON: HTTP ${response.status}`); }
  return { status: response.status, data, headers: response.headers };
}
async function ok(actor: Actor | null, route: string, method = 'GET', body?: unknown): Promise<any> {
  const result = await http(actor, route, method, body);
  if (result.status < 200 || result.status >= 300) {
    const code = /^[A-Z0-9]{5,8}$/.test(result.data?.code || '') ? result.data.code : 'unclassified';
    throw new Error(`Local API rejected ${method} ${route.split('?')[0]}: HTTP ${result.status}, code ${code}`);
  }
  return result.data;
}
const rows = (actor: Actor, table: string, filter: string, select = '*', order = 'id'): Promise<Row[]> =>
  ok(actor, `/rest/v1/${table}?select=${select}&${filter}${order ? `&order=${order}` : ''}`);
const rpc = (actor: Actor, name: string, args: Row) => ok(actor, `/rest/v1/rpc/${name}`, 'POST', args);
const inIds = (ids: string[]) => `in.(${ids.join(',')})`;

const test = base.extend<{ isolation: void }>({
  isolation: [async ({ context }, use) => {
    const rejected: string[] = [];
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if ([frontendUrl, apiUrl].includes(url.origin)) {
        if (url.origin === apiUrl) {
          const headers = request.headers();
          const token = headers.authorization?.replace(/^Bearer /i, '');
          if ((headers.apikey && headers.apikey !== anonKey)
            || (token && !['anon', 'authenticated'].includes(jwtRole(token)))) {
            rejected.push('Unexpected browser API credential role');
            return route.abort('blockedbyclient');
          }
        }
        return route.continue();
      }
      const staticGet = request.method() === 'GET' && url.protocol === 'https:' && (
        (url.hostname === 'cdn.tailwindcss.com' && request.resourceType() === 'script' && /^\/(?:\d+\.\d+\.\d+)?$/.test(url.pathname))
        || (url.hostname === 'fonts.googleapis.com' && request.resourceType() === 'stylesheet' && url.pathname === '/css2')
        || (url.hostname === 'fonts.gstatic.com' && request.resourceType() === 'font' && url.pathname.startsWith('/s/')));
      if (staticGet) return route.continue();
      rejected.push(`${request.method()} ${request.resourceType()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      const origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
      if ([frontendUrl, apiUrl].includes(origin)) socket.connectToServer();
      else { rejected.push(`websocket ${origin}${url.pathname}`); socket.close(); }
    });
    try { await use(); } finally {
      expect(rejected, 'Remote backends and privileged browser credentials are forbidden').toEqual([]);
      expect(context.serviceWorkers()).toHaveLength(0);
    }
  }, { auto: true }]
});
test.describe.configure({ mode: 'default' });
test.use({ baseURL: frontendUrl, serviceWorkers: 'block', timezoneId: 'Europe/Madrid', trace: 'off', screenshot: 'off', video: 'off' });

async function login(email: string, key: string, role: string): Promise<Actor> {
  const data = await ok(null, '/auth/v1/token?grant_type=password', 'POST', { email, password: testPassword });
  if (jwtRole(data.access_token) !== 'authenticated' || data.user?.email !== email || data.user.id !== manifest.actors[key]) {
    throw new Error('Password Auth identity differs from the public fixture manifest.');
  }
  const actor = { id: data.user.id, token: data.access_token };
  expect(await rows(actor, 'profiles', `id=eq.${actor.id}`, 'id,email,role'))
    .toEqual([{ id: actor.id, email, role }]);
  return actor;
}

// Include BOTH sedes, complete rows and every new policy projection. This is
// post-migration preservation evidence, not a substitute for the rollout snapshot.
async function seedSnapshot() {
  const students = [1, 2, 3, 4].map(n => `10000000-0000-0000-0000-00000000000${n}`);
  const sessions = [1, 2, 3, 4].map(n => `20000000-0000-0000-0000-00000000000${n}`);
  const cards = [1, 2].map(n => `40000000-0000-0000-0000-00000000000${n}`);
  const queries: [string, string, string][] = [
    ['students', `id=${inIds(students)}`, 'id'],
    ['student_membership_periods', `student_id=${inIds(students)}`, 'id'],
    ['student_membership_class_adjustments', `student_id=${inIds(students)}`, 'id'],
    ['gift_cards', `id=${inIds(cards)}`, 'id'],
    ['gift_card_movements', `gift_card_id=${inIds(cards)}`, 'id'],
    ['gift_card_operation_receipts', `gift_card_id=${inIds(cards)}`, 'request_key'],
    ['sessions', `id=${inIds(sessions)}`, 'id'],
    ['session_students', `session_id=${inIds(sessions)}`, 'id'],
    ['session_operation_receipts', `session_id=${inIds(sessions)}`, 'session_id,request_key'],
    ['session_credit_movements', `session_id=${inIds(sessions)}`, 'id'],
    ...businessTables.map(table => [table, `session_id=${inIds(sessions)}`, 'session_id,student_id'] as [string, string, string]),
    ['workshop_schedules', `sede_id=${inIds([ownSede, foreignSede])}`, 'id'],
    ['workshop_capacity_defaults', `sede_id=${inIds([ownSede, foreignSede])}`, 'sede_id,class_type'],
    ['workshop_schedule_exceptions', `sede_id=${inIds([ownSede, foreignSede])}`, 'id'],
    ['teachers', `id=eq.70000000-0000-0000-0000-000000000001`, 'id'],
    ['sedes', `id=${inIds([ownSede, foreignSede])}`, 'id']
  ];
  return Object.fromEntries(await Promise.all(queries.map(async ([table, filter, order]) => [table,
    [...await rows(owner, table, filter, '*', order), ...await rows(other, table, filter, '*', order)]
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])));
}

test.beforeAll(async () => {
  if (process.env.BASE_URL !== frontendUrl || jwtRole(anonKey) !== 'anon'
    || Object.keys(process.env).some(key => /(?:SERVICE_ROLE|SECRET|TOKEN|PASSWORD|(?:API|ACCESS)[_-]?KEY|DATABASE_URL|DB_URL|JWT)/i.test(key))) {
    throw new Error('Use only the sanitized owned local-staging runner.');
  }
  try { manifest = JSON.parse(process.env.TEST_LOCAL_POLICY_FIXTURES || ''); }
  catch { throw new Error('Parent-prepared public policy manifest required.'); }
  if (manifest.version !== 1 || !uuid.test(manifest.runId) || manifest.sedeId !== ownSede
    || Object.values(manifest.actors).length !== 5 || new Set(Object.values(manifest.actors)).size !== 5
    || Object.values(manifest.actors).some(id => !uuid.test(id))) throw new Error('Invalid controlled local policy manifest.');
  expect(manifest.clockChecks).toBe('exact_8h_madrid_dst');
  const identityResponse = await fetch(`${frontendUrl}/__local-staging`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const identity = await identityResponse.json();
  expect(identityResponse.status).toBe(200);
  expect({ projectId: identity.projectId, apiUrl: identity.apiUrl, frontendUrl: identity.frontendUrl })
    .toEqual({ projectId, apiUrl, frontendUrl });
  [owner, other, reader, employee, supervisor] = await Promise.all([
    login('staff@pottery.local', 'staff_id', 'tallerista'), login('other@pottery.local', 'other_id', 'tallerista'),
    login('reader@pottery.local', 'reader_id', 'tallerista'), login('employee@pottery.local', 'employee_id', 'staff'),
    login('supervisor@pottery.local', 'supervisor_id', 'super_admin')
  ]);
  expect(await rows(owner, 'sedes', `id=eq.${ownSede}`, 'id,owner_id,is_active'))
    .toEqual([{ id: ownSede, owner_id: owner.id, is_active: true }]);
  expect(await rows(other, 'sedes', `id=eq.${foreignSede}`, 'id,owner_id,is_active'))
    .toEqual([{ id: foreignSede, owner_id: other.id, is_active: true }]);
  for (const [actor, role] of [[employee, 'staff'], [supervisor, 'super_admin']] as const) {
    expect(await rows(actor, 'sede_members', `user_id=eq.${actor.id}`, 'sede_id,user_id,role'))
      .toEqual([{ sede_id: ownSede, user_id: actor.id, role }]);
    expect(await rows(actor, 'sedes', `owner_id=eq.${actor.id}`)).toEqual([]);
  }
  expect(await rows(reader, 'sede_members', 'limit=1')).toEqual([]);
  expect(await rows(reader, 'sedes', 'limit=1')).toEqual([]);
  seedBefore = await seedSnapshot();
  const allIds = Object.values(manifest.subjects).flatMap(s => [s.studentId, s.periodId, s.successorId, s.cardId].filter(Boolean));
  expect(allIds.every(id => uuid.test(id!))).toBe(true);
  expect(new Set(allIds).size).toBe(allIds.length);
  const date = (days: number) => new Date(Date.parse(`${manifest.today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  // A restarted worker shares the manifest with already-completed scenarios.
  // Validate immutable sources here; exact untouched balances belong to reserve().
  for (const [key, subject] of Object.entries(manifest.subjects)) {
    const payment = subject.kind === 'pending' ? 'pending' : subject.kind === 'unknown' ? null : 'paid';
    const expired = ['expired_grace', 'expired_beyond5', 'queued'].includes(subject.kind);
    const startsOn = date(expired ? -40 : -10);
    const endsOn = date(expired ? subject.kind === 'expired_grace' ? -5 : -6 : 40);
    const students = await rows(owner, 'students', `id=eq.${subject.studentId}`);
    expect(students).toEqual([expect.objectContaining({
      id: subject.studentId, sede_id: ownSede, full_name: `Policy ${key} ${subject.studentId}`,
      email: `policy-${subject.studentId}@pottery.local`, student_category: 'membresia', membership_tier: 'gold',
      current_membership_period_id: subject.periodId, bonos_asignados: 4, payment_status: payment,
      membership_activated_at: startsOn
    })]);
    expect(new Date(students[0].expiry_date).toISOString()).toBe(`${endsOn}T00:00:00.000Z`);
    expect(Number.isInteger(students[0].classes_remaining)).toBe(true);
    expect(students[0].classes_remaining).toBeGreaterThanOrEqual(0);
    expect(students[0].classes_remaining).toBeLessThanOrEqual(4);
    const periods = await rows(owner, 'student_membership_periods', `student_id=eq.${subject.studentId}`);
    expect(periods).toHaveLength(subject.kind === 'queued' ? 2 : 1);
    expect(periods).toContainEqual(expect.objectContaining({ id: subject.periodId, student_id: subject.studentId,
      sede_id: ownSede, membership_tier: 'gold', allocated_classes: 4, starts_on: startsOn, ends_on: endsOn,
      payment_status: payment, confirmed_by: payment === 'paid' ? owner.id : null, outgoing_snapshot: null }));
    if (subject.kind === 'queued') expect(periods).toContainEqual(expect.objectContaining({ id: subject.successorId,
      student_id: subject.studentId, sede_id: ownSede, predecessor_id: subject.periodId, allocated_classes: 8,
      starts_on: manifest.today, ends_on: date(29), payment_status: 'paid', activated_at: null }));
    const cards = await rows(owner, 'gift_cards', `recipient_student_id=eq.${subject.studentId}`);
    expect(cards).toHaveLength(subject.kind === 'queued' ? 1 : 0);
    if (subject.kind === 'queued') {
      expect(cards[0]).toMatchObject({ id: subject.cardId, sede_id: ownSede, recipient_student_id: subject.studentId,
        num_classes: 2, payment_status: 'paid', activated_at: manifest.today });
      expect(Number.isInteger(cards[0].sessions_used)).toBe(true);
      expect(cards[0].sessions_used).toBeGreaterThanOrEqual(0);
      expect(cards[0].sessions_used).toBeLessThanOrEqual(2);
    }
  }
});
test.afterAll(async () => {
  if (seedBefore) expect(await seedSnapshot(), 'All old seed rows, v1 policy metadata and history must be unchanged').toEqual(seedBefore);
});

async function reserve(key: string, hour = 12, futureHours?: number): Promise<Session> {
  const subject = manifest.subjects[key];
  if (!subject) throw new Error(`Missing controlled subject: ${key}`);
  // Each scenario still starts with its exact fresh financial state, including
  // on a replacement worker. The source-binding case reserves twice before use.
  expect(await rows(owner, 'students', `id=eq.${subject.studentId}`, 'id,classes_remaining'))
    .toEqual([{ id: subject.studentId, classes_remaining: subject.kind === 'zero' ? 0 : 4 }]);
  const id = randomUUID();
  let date = manifest.today;
  let start = `${date}T${String(hour).padStart(2, '0')}:00:00Z`;
  let end = `${date}T${String(hour + 1).padStart(2, '0')}:00:00Z`;
  if (futureHours !== undefined) {
    // Obtain CURRENT server time from Auth's HTTP Date, not a client override.
    // 9h/1h margins avoid probing the exact cutoff over an HTTP round trip.
    const clock = await http(owner, '/auth/v1/user');
    expect(clock.status).toBe(200);
    const now = Date.parse(clock.headers.get('date') || '');
    expect(Number.isFinite(now)).toBe(true);
    const instant = now + futureHours * 3_600_000;
    const wall = (ms: number) => {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      const part = (type: string) => parts.find(p => p.type === type)!.value;
      return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`;
    };
    start = wall(instant); end = wall(instant + 1_800_000);
    // Keep the declared wall-date interval valid near midnight, without ever
    // moving towards the eight-hour boundary or overriding the server clock.
    if (start.slice(0, 10) !== end.slice(0, 10)) {
      start = wall(instant + 1_800_000); end = wall(instant + 3_600_000);
    }
    date = start.slice(0, 10);
  }
  const metadata = { date, start_time: start, end_time: end, class_type: 'mesa', capacity: 1,
    teacher_id: '70000000-0000-0000-0000-000000000001', session_audience: 'membresia' };
  const args = { p_session_id: id, p_request_key: randomUUID(), p_expected_revision: 0, p_sede_id: ownSede,
    p_metadata: metadata, p_student_ids: [subject.studentId], p_gift_card_ids: {} };
  const receipt = await rpc(owner, 'save_session_reservation', args);
  expect(receipt).toMatchObject({ session_id: id, request_key: args.p_request_key, revision: 1, replayed: false,
    session: { attendance_policy_version: 2 }, student_ids: [subject.studentId] });
  const session = { id, subject, date, metadata };
  const initial = await snapshot(session);
  noFinance(initial, subject.kind === 'zero' ? 0 : 4);
  expect(initial.sessions).toEqual([expect.objectContaining({ attendance_policy_version: 2, revision: 1, completed_at: null })]);
  expect(initial.credits).toEqual([]);
  expect(initial.state[0]).toMatchObject({ policy_version: 2, reservation_state: 'reserved', billing_state: 'unfinalized',
    funding_period_id: subject.periodId, funding_gift_card_id: null });
  expect(Object.keys(initial.state[0]).sort()).toEqual([...stateColumns].sort());
  return session;
}

async function snapshot(s: Session): Promise<Row> {
  const query: Record<string, Promise<Row[]>> = {
    students: rows(owner, 'students', `id=eq.${s.subject.studentId}`),
    periods: rows(owner, 'student_membership_periods', `student_id=eq.${s.subject.studentId}`),
    cards: rows(owner, 'gift_cards', `recipient_student_id=eq.${s.subject.studentId}`),
    gifts: rows(owner, 'gift_card_movements', `student_id=eq.${s.subject.studentId}`),
    giftReceipts: rows(owner, 'gift_card_operation_receipts', `student_id=eq.${s.subject.studentId}`, '*', 'request_key'),
    adjustments: rows(owner, 'student_membership_class_adjustments', `student_id=eq.${s.subject.studentId}`),
    sessions: rows(owner, 'sessions', `id=eq.${s.id}`),
    roster: rows(owner, 'session_students', `session_id=eq.${s.id}`),
    receipts: rows(owner, 'session_operation_receipts', `session_id=eq.${s.id}`, '*', 'request_key'),
    credits: rows(owner, 'session_credit_movements', `session_id=eq.${s.id}`, '*', 'revision,id')
  };
  for (const table of businessTables) query[table === 'session_business_state' ? 'state' : table.replace('session_business_', '')]
    = rows(owner, table, `session_id=eq.${s.id}`, '*', table === 'session_business_waivers' ? 'penalty_id'
      : ['session_business_state', 'session_business_billing'].includes(table) ? 'session_id,student_id' : 'id');
  return Object.fromEntries(await Promise.all(Object.entries(query).map(async ([key, value]) => [key, await value])));
}
const attendanceArgs = (s: Session, revision: number, status: string, finalize = true) => ({
  p_session_id: s.id, p_request_key: randomUUID(), p_expected_revision: revision,
  p_attendance: [{ student_id: s.subject.studentId, status }], p_finalize: finalize, p_teacher_substitute_id: null
});
const actionArgs = (s: Session, revision: number, reason: string, kind?: string) => ({
  p_session_id: s.id, p_student_id: s.subject.studentId, p_request_key: randomUUID(), p_expected_revision: revision,
  p_reason: reason, ...(kind === undefined ? {} : { p_kind: kind })
});
function receipt(result: Row, s: Session, args: Row, replayed = false) {
  expect(result).toMatchObject({ session_id: s.id, request_key: args.p_request_key,
    revision: args.p_expected_revision + 1, replayed });
}
async function reject(actor: Actor, name: string, args: Row, code = 'P0001') {
  const response = await http(actor, `/rest/v1/rpc/${name}`, 'POST', args);
  if (code === '42501') expect(response.status).toBe(403);
  else { expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(600); }
  expect(response.data?.code).toBe(code);
}
function noFinance(s: Row, balance: number) {
  expect(s.students[0].classes_remaining).toBe(balance);
  expect(s.credits).toEqual([]);
  expect(s.adjustments).toEqual([]);
  expect(s.gifts).toEqual([]);
  expect(s.giftReceipts).toEqual([]);
}
function oneDebit(s: Session, result: Row, balance = 3) {
  expect(result.students[0]).toMatchObject({ current_membership_period_id: s.subject.periodId, classes_remaining: balance });
  expect(result.credits).toEqual([expect.objectContaining({ session_id: s.id, student_id: s.subject.studentId,
    period_id: s.subject.periodId, gift_card_id: null, delta: -1, reverses_id: null })]);
  expect(result.adjustments).toContainEqual(expect.objectContaining({ id: result.credits[0].adjustment_id,
    period_id: s.subject.periodId, delta: -1, resulting_balance: balance }));
  expect(result.adjustments.filter((a: Row) => a.id === result.credits[0].adjustment_id)).toHaveLength(1);
  expect(result.gifts).toEqual([]);
}

test('policy2 paid presence: reservation and provisional save spend zero; finalization and exact replay spend one', async () => {
  const s = await reserve('paidPresence');
  const before = await snapshot(s);
  await reject(employee, 'approve_session_exception', actionArgs(s, 1, 'Cannot evade available credit', 'no_credit'));
  await reject(employee, 'approve_session_exception', actionArgs(s, 1, 'Paid valid credit needs no override', 'membership_override'));
  expect(await snapshot(s)).toEqual(before);
  const draft = attendanceArgs(s, 1, 'present', false);
  receipt(await rpc(owner, 'save_session_attendance', draft), s, draft);
  const provisional = await snapshot(s);
  noFinance(provisional, 4);
  expect(provisional.periods).toEqual(before.periods);
  expect(provisional.sessions[0]).toMatchObject({ revision: 2, completed_at: null });
  const final = attendanceArgs(s, 2, 'present');
  const result = await rpc(owner, 'save_session_attendance', final);
  receipt(result, s, final);
  const charged = await snapshot(s);
  oneDebit(s, charged);
  expect(charged.adjustments).toHaveLength(1);
  expect(charged.state[0]).toMatchObject({ billing_state: 'charged', billing_kind: 'attendance', penalty_id: null,
    billing_debit_id: charged.credits[0].id, finalized_revision: 3 });
  expect(charged.periods).toEqual(before.periods);
  expect(await rpc(owner, 'save_session_attendance', final)).toEqual({ ...result, replayed: true });
  expect(await snapshot(s)).toEqual(charged);
  await reject(owner, 'save_session_attendance', attendanceArgs(s, 3, 'present', false));
  expect(await snapshot(s)).toEqual(charged);
});

test('policy2 no-show costs one; ordinary present/absent corrections retain the original penalty and debit', async () => {
  const s = await reserve('paidAbsence');
  const args = attendanceArgs(s, 1, 'absent');
  receipt(await rpc(employee, 'save_session_attendance', args), s, args);
  const charged = await snapshot(s);
  oneDebit(s, charged);
  expect(charged.penalties).toEqual([expect.objectContaining({ kind: 'no_show', state: 'charged',
    reason: 'One class: no_show', period_id: s.subject.periodId, debit_id: charged.credits[0].id, created_by: employee.id })]);
  for (const [revision, status] of [[2, 'present'], [3, 'absent']] as const) {
    const correction = attendanceArgs(s, revision, status);
    receipt(await rpc(employee, 'save_session_attendance', correction), s, correction);
    const corrected = await snapshot(s);
    oneDebit(s, corrected);
    expect(corrected.credits).toEqual(charged.credits);
    expect(corrected.penalties).toEqual(charged.penalties);
    expect(corrected.state[0]).toMatchObject({ billing_kind: 'no_show', penalty_state: 'charged' });
  }
});

for (const [key, payment, expiredDays] of [
  ['pending', 'pending', 0], ['unknown', null, 0], ['expiredGrace', 'paid', 5], ['expiredBeyond5', 'paid', 6]
] as const) test(`policy2 ${key}: explicit same-sede employee override consumes original credit without changing payment/expiry`, async () => {
  const s = await reserve(key);
  const before = await snapshot(s);
  expect(before.periods[0].payment_status).toBe(payment);
  if (expiredDays) {
    const days = (Date.parse(`${manifest.today}T12:00:00Z`) - Date.parse(`${before.periods[0].ends_on}T12:00:00Z`)) / 86_400_000;
    expect(days).toBe(expiredDays);
  }
  await reject(owner, 'save_session_attendance', attendanceArgs(s, 1, 'present'));
  expect(await snapshot(s)).toEqual(before);
  const args = actionArgs(s, 1, `Individual ${key} approval ${manifest.runId}`, 'membership_override');
  for (const actor of [other, reader]) await reject(actor, 'approve_session_exception', args, '42501');
  await reject(employee, 'approve_session_exception', { ...args, p_reason: ' \t\n' });
  await reject(employee, 'approve_session_exception', { ...args, p_student_id: randomUUID() });
  expect(await snapshot(s)).toEqual(before);
  const approved = await rpc(employee, 'approve_session_exception', args);
  receipt(approved, s, args);
  const authorized = await snapshot(s);
  noFinance(authorized, 4);
  expect(authorized.periods).toEqual(before.periods);
  expect(authorized.exceptions).toEqual([expect.objectContaining({ id: approved.exception_id, kind: 'membership_override',
    student_id: s.subject.studentId, session_id: s.id, period_id: s.subject.periodId, gift_card_id: null,
    reason: args.p_reason, approved_by: employee.id, revision: 2,
    funding_snapshot: expect.objectContaining({ period_id: s.subject.periodId, current_period_id: s.subject.periodId,
      balance: 4, payment_status: payment, starts_on: before.periods[0].starts_on, ends_on: before.periods[0].ends_on }) })]);
  expect(await rpc(employee, 'approve_session_exception', args)).toEqual({ ...approved, replayed: true });
  expect(await snapshot(s)).toEqual(authorized);
  await rpc(owner, 'save_session_attendance', attendanceArgs(s, 2, 'present'));
  const charged = await snapshot(s);
  oneDebit(s, charged);
  expect(charged.students[0].payment_status).toBe(payment);
  expect(charged.periods).toEqual(before.periods);
  expect(charged.state[0]).toMatchObject({ exception_id: approved.exception_id, approved_by: employee.id,
    exception_reason: args.p_reason, exception_period_id: s.subject.periodId, billing_state: 'charged', billing_kind: 'attendance' });
});

test('policy2 no-credit courtesy is individual and traceable; it neither fabricates payment/balance nor waives a later no-show', async () => {
  const s = await reserve('courtesy');
  const before = await snapshot(s);
  await reject(owner, 'save_session_attendance', attendanceArgs(s, 1, 'present'));
  expect(await snapshot(s)).toEqual(before);
  const args = actionArgs(s, 1, `Individual courtesy ${manifest.runId}`, 'no_credit');
  const approved = await rpc(employee, 'approve_session_exception', args);
  receipt(approved, s, args);
  await rpc(owner, 'save_session_attendance', attendanceArgs(s, 2, 'present'));
  const courtesy = await snapshot(s);
  noFinance(courtesy, 0);
  expect(courtesy.students).toEqual(before.students);
  expect(courtesy.periods).toEqual(before.periods);
  expect(courtesy.state[0]).toMatchObject({ billing_state: 'no_charge', billing_kind: 'courtesy', exception_kind: 'no_credit',
    exception_reason: args.p_reason, approved_by: employee.id, penalty_id: null });
  await rpc(employee, 'save_session_attendance', attendanceArgs(s, 3, 'absent'));
  const incident = await snapshot(s);
  noFinance(incident, 0);
  expect(incident.state[0]).toMatchObject({ billing_state: 'incident', billing_kind: 'no_show', penalty_state: 'pending' });
  expect(incident.penalties[0]).toMatchObject({ period_id: s.subject.periodId, debit_id: null, state: 'pending' });
});

for (const [key, hours, kind] of [['timely', 9, 'timely'], ['late', 1, 'late']] as const)
  test(`policy2 ${kind} cancellation uses server clock (${hours}h ahead), debits only at finalization and replays exact tombstone`, async () => {
    const s = await reserve(key, 12, hours);
    const args = actionArgs(s, 1, `Server-clock ${kind} cancellation ${manifest.runId}`);
    const cancelled = await rpc(employee, 'cancel_session_reservation', args);
    receipt(cancelled, s, args);
    expect(cancelled).toMatchObject({ cancellation_kind: kind, student_id: s.subject.studentId });
    expect(cancelled.cancelled_at).toBeTruthy();
    const tombstone = await snapshot(s);
    noFinance(tombstone, 4);
    expect(tombstone.roster[0]).toMatchObject({ cancelled_at: cancelled.cancelled_at, cancelled_by: employee.id,
      cancellation_kind: kind, cancellation_reason: args.p_reason, membership_period_id: s.subject.periodId });
    expect(await rpc(employee, 'cancel_session_reservation', args)).toEqual({ ...cancelled, replayed: true });
    expect(await snapshot(s)).toEqual(tombstone);
    const final = attendanceArgs(s, 2, 'pending');
    const finalized = await rpc(owner, 'save_session_attendance', final);
    receipt(finalized, s, final);
    const billed = await snapshot(s);
    expect(billed.state[0]).toMatchObject({ reservation_state: 'cancelled', cancellation_kind: kind,
      billing_kind: kind === 'timely' ? 'timely_cancellation' : 'late_cancellation',
      billing_state: kind === 'timely' ? 'no_charge' : 'charged', penalty_state: kind === 'timely' ? null : 'charged' });
    if (kind === 'timely') noFinance(billed, 4); else oneDebit(s, billed);
    expect(billed.roster).toEqual(tombstone.roster);
    expect(await rpc(owner, 'save_session_attendance', final)).toEqual({ ...finalized, replayed: true });
    expect(await snapshot(s)).toEqual(billed);
    // Public RPC has no client cancellation timestamp or clock parameter.
    const forged = await http(owner, '/rest/v1/rpc/cancel_session_reservation', 'POST', { ...args,
      p_request_key: randomUUID(), p_expected_revision: 3, p_cancelled_at: '2000-01-01T00:00:00Z' });
    expect(forged.status).toBe(404);
    expect(forged.data.code).toBe('PGRST202');
    expect(await snapshot(s)).toEqual(billed);
  });

for (const [key, late] of [['zeroNoShow', false], ['zeroLate', true]] as const)
  test(`policy2 zero-credit ${late ? 'late cancellation' : 'no-show'} is a durable Pending incident, never a negative debit`, async () => {
    const s = await reserve(key, 12, late ? 1 : undefined);
    const before = await snapshot(s);
    let revision = 1;
    if (late) {
      const args = actionArgs(s, revision++, 'No-credit late cancellation');
      expect(await rpc(employee, 'cancel_session_reservation', args)).toMatchObject({ cancellation_kind: 'late' });
    }
    await rpc(owner, 'save_session_attendance', attendanceArgs(s, revision++, late ? 'pending' : 'absent'));
    const incident = await snapshot(s);
    noFinance(incident, 0);
    expect(incident.students).toEqual(before.students);
    expect(incident.periods).toEqual(before.periods);
    expect(incident.state[0]).toMatchObject({ billing_state: 'incident', penalty_state: 'pending',
      billing_kind: late ? 'late_cancellation' : 'no_show', billing_debit_id: null, funding_period_id: s.subject.periodId });
    expect(incident.penalties[0]).toMatchObject({ state: 'pending', debit_id: null, gift_card_id: null, period_id: s.subject.periodId });
    expect(incident.penalties[0].reason).toBeTruthy();
    await rpc(employee, 'save_session_attendance', attendanceArgs(s, revision, 'present'));
    const corrected = await snapshot(s);
    noFinance(corrected, 0);
    expect(corrected.penalties).toEqual(incident.penalties);
    expect(corrected.state).toEqual(incident.state);
  });

test('policy2 Pending no-show never materializes a paid successor or selects another available gift card', async () => {
  const s = await reserve('queuedNoShow');
  const before = await snapshot(s);
  expect(before.periods).toHaveLength(2);
  expect(before.periods.find((p: Row) => p.id === s.subject.successorId)).toMatchObject({ predecessor_id: s.subject.periodId,
    payment_status: 'paid', allocated_classes: 8, activated_at: null, outgoing_snapshot: null });
  expect(before.cards).toEqual([expect.objectContaining({ id: s.subject.cardId, sessions_used: 0, status: 'active', payment_status: 'paid' })]);
  await rpc(owner, 'save_session_attendance', attendanceArgs(s, 1, 'absent'));
  const incident = await snapshot(s);
  noFinance(incident, 4);
  expect(incident.students).toEqual(before.students);
  expect(incident.periods).toEqual(before.periods);
  expect(incident.cards).toEqual(before.cards);
  expect(incident.state[0]).toMatchObject({ billing_state: 'incident', penalty_state: 'pending',
    funding_period_id: s.subject.periodId, funding_gift_card_id: null });
  await rpc(employee, 'save_session_attendance', attendanceArgs(s, 2, 'present'));
  const corrected = await snapshot(s);
  noFinance(corrected, 4);
  expect(corrected.periods).toEqual(before.periods);
  expect(corrected.cards).toEqual(before.cards);
  await reject(employee, 'approve_session_exception', actionArgs(s, 3, 'Not a penalty waiver', 'membership_override'));
  const waiver = actionArgs(s, 3, 'Owner resolves pending incident without inventing a refund');
  receipt(await rpc(owner, 'waive_session_penalty', waiver), s, waiver);
  const waived = await snapshot(s);
  noFinance(waived, 4);
  expect(waived.periods).toEqual(before.periods);
  expect(waived.cards).toEqual(before.cards);
  expect(waived.waivers[0]).toMatchObject({ reversal_id: null, waived_by: owner.id, reason: waiver.p_reason });
});

for (const key of ['pendingNoShow', 'unknownNoShow', 'graceNoShow', 'expiredNoShow'])
  test(`policy2 ${key} has positive but invalid original credit: no-show records Pending without fabricating a payment or debit`, async () => {
    const s = await reserve(key);
    const before = await snapshot(s);
    const args = attendanceArgs(s, 1, 'absent');
    const result = await rpc(employee, 'save_session_attendance', args);
    receipt(result, s, args);
    const incident = await snapshot(s);
    noFinance(incident, 4);
    expect(incident.students).toEqual(before.students);
    expect(incident.periods).toEqual(before.periods);
    expect(incident.penalties).toEqual([expect.objectContaining({ state: 'pending', kind: 'no_show',
      period_id: s.subject.periodId, gift_card_id: null, debit_id: null, created_by: employee.id })]);
    expect(incident.state[0]).toMatchObject({ billing_state: 'incident', penalty_state: 'pending', billing_kind: 'no_show' });
    expect(await rpc(employee, 'save_session_attendance', args)).toEqual({ ...result, replayed: true });
    expect(await snapshot(s)).toEqual(incident);
  });

test('policy2 waiver is owner-only: actual employee, foreign owner, unlinked integration and real linked super_admin cannot refund', async () => {
  const s = await reserve('permissions');
  await rpc(owner, 'save_session_attendance', attendanceArgs(s, 1, 'absent'));
  const charged = await snapshot(s);
  for (const actor of [employee, other, reader, supervisor]) {
    await reject(actor, 'waive_session_penalty', actionArgs(s, 2, 'Unauthorized waiver'), '42501');
    expect(await snapshot(s)).toEqual(charged);
  }
  for (const actor of [other, reader]) {
    for (const table of [...businessTables, 'sessions', 'session_students', 'session_credit_movements', 'session_operation_receipts']) {
      expect(await rows(actor, table, `${table === 'sessions' ? 'id' : 'session_id'}=eq.${s.id}`, '*', '')).toEqual([]);
    }
    await reject(actor, 'approve_session_exception', actionArgs(s, 2, 'Forged approval', 'no_credit'), '42501');
    await reject(actor, 'cancel_session_reservation', actionArgs(s, 2, 'Forged cancellation'), '42501');
  }
  // A real superadmin has read scope, not ownership or penalty authority.
  expect(await rows(supervisor, 'session_business_state', `session_id=eq.${s.id}`, '*', '')).toEqual(charged.state);
  for (const targetOwner of [supervisor.id, other.id]) {
    const denied = await http(supervisor, `/rest/v1/sedes?id=eq.${ownSede}`, 'PATCH', { owner_id: targetOwner });
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe('42501');
    expect(await rows(owner, 'sedes', `id=eq.${ownSede}`, 'owner_id', '')).toEqual([{ owner_id: owner.id }]);
    expect(await snapshot(s)).toEqual(charged);
  }
  for (const table of ['session_business_exceptions', 'session_business_penalties', 'session_business_waivers', 'session_business_billing']) {
    const denied = await http(owner, `/rest/v1/${table}?session_id=eq.${s.id}`, 'PATCH',
      table === 'session_business_billing' ? { state: 'waived' } : { reason: 'Direct write bypass' });
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe('42501');
  }
  expect(await snapshot(s)).toEqual(charged);
  const args = actionArgs(s, 2, `Owner documented justified absence ${manifest.runId}`);
  const result = await rpc(owner, 'waive_session_penalty', args);
  receipt(result, s, args);
  const waived = await snapshot(s);
  expect(waived.students[0].classes_remaining).toBe(4);
  expect(waived.credits).toEqual([charged.credits[0], expect.objectContaining({ delta: 1, reverses_id: charged.credits[0].id,
    period_id: s.subject.periodId, gift_card_id: null, created_by: owner.id, disposition: 'current_period' })]);
  expect(waived.penalties).toEqual(charged.penalties);
  expect(waived.state[0]).toMatchObject({ billing_state: 'waived', penalty_state: 'waived', waiver_reason: args.p_reason,
    waived_by: owner.id, funding_period_id: s.subject.periodId });
  expect(await rpc(owner, 'waive_session_penalty', args)).toEqual({ ...result, replayed: true });
  expect(await snapshot(s)).toEqual(waived);
  await rpc(employee, 'save_session_attendance', attendanceArgs(s, 3, 'present'));
  const corrected = await snapshot(s);
  expect(corrected.students[0].classes_remaining).toBe(4);
  expect(corrected.credits).toEqual(waived.credits);
  expect(corrected.state[0].penalty_state).toBe('waived');
});

test('policy2 approval binds session/student/source snapshot: another session has no grant and changed balance requires reapproval', async () => {
  const first = await reserve('boundApproval', 10);
  const second = await reserve('boundApproval', 14);
  const firstArgs = actionArgs(first, 1, 'First source-bound approval', 'membership_override');
  await rpc(employee, 'approve_session_exception', firstArgs);
  const unapproved = await snapshot(second);
  await reject(owner, 'save_session_attendance', attendanceArgs(second, 1, 'present'));
  expect(await snapshot(second)).toEqual(unapproved);
  const secondArgs = actionArgs(second, 1, 'Second independent source-bound approval', 'membership_override');
  await rpc(employee, 'approve_session_exception', secondArgs);
  await rpc(owner, 'save_session_attendance', attendanceArgs(first, 2, 'present'));
  const stale = await snapshot(second);
  expect(stale.students[0].classes_remaining).toBe(3);
  expect(stale.exceptions[0].funding_snapshot.balance).toBe(4);
  await reject(owner, 'save_session_attendance', attendanceArgs(second, 2, 'present'));
  expect(await snapshot(second)).toEqual(stale);
  await reject(employee, 'approve_session_exception', { ...secondArgs, p_reason: 'Changed body using old key' });
  expect(await snapshot(second)).toEqual(stale);
  const reapproval = actionArgs(second, 2, 'Reapproved current original balance', 'membership_override');
  receipt(await rpc(employee, 'approve_session_exception', reapproval), second, reapproval);
  await rpc(owner, 'save_session_attendance', attendanceArgs(second, 3, 'present'));
  const finalized = await snapshot(second);
  oneDebit(second, finalized, 2);
  expect(finalized.adjustments).toHaveLength(2);
  expect(finalized.exceptions).toHaveLength(2);
  expect(finalized.exceptions).toContainEqual(stale.exceptions[0]);
  expect(finalized.state[0]).toMatchObject({ approved_by: employee.id, exception_reason: reapproval.p_reason });
});

async function loginBrowser(page: Page, email = 'staff@pottery.local') {
  const pageErrors: string[] = [];
  const requestStats = new Map<string, number>();
  const onPageError = (error: Error) => pageErrors.push(redact(error.message).replaceAll(testPassword, '[redacted password]'));
  const onResponse = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    if (![frontendUrl, apiUrl].includes(url.origin)) return;
    const key = `${response.request().method()} ${url.origin}${url.pathname} HTTP ${response.status()}`;
    requestStats.set(key, (requestStats.get(key) || 0) + 1);
  };
  const onRequestFailed = (request: import('@playwright/test').Request) => {
    const url = new URL(request.url());
    if (![frontendUrl, apiUrl].includes(url.origin)) return;
    const key = `${request.method()} ${url.origin}${url.pathname} transport-failed`;
    requestStats.set(key, (requestStats.get(key) || 0) + 1);
  };
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    await page.goto('/login');
    await page.getByLabel('Correo electr\u00f3nico', { exact: true }).fill(email);
    await page.getByLabel('Contrase\u00f1a', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: 'Iniciar sesi\u00f3n', exact: true }).click();
    await expect(page).toHaveURL(`${frontendUrl}/dashboard`);
  } catch (error) {
    console.log(`Local login diagnostics (no headers, bodies, query strings or artifacts): ${redact(JSON.stringify({
      pageErrors, requests: Object.fromEntries(requestStats)
    })).replaceAll(anonKey, '[redacted public key]').replaceAll(testPassword, '[redacted password]')}`);
    throw error;
  } finally {
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Control de asistencia', exact: true });
const row = (page: Page, s: Session) => dialog(page).locator(`[data-student-id="${s.subject.studentId}"]`);
async function open(page: Page, s: Session) {
  await page.goto(`/calendar?date=${s.date}&sessionId=${s.id}&attendance=1`);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-student-id]')).toHaveCount(1);
  await expect(row(page, s)).toBeVisible();
  await expect(dialog(page).getByTestId('attendance-policy')).toContainText('Guardar provisional no consume clases');
}
async function uiAction(page: Page, s: Session, name: string, button: string, reason: string, kind?: string) {
  const revision = Number(await dialog(page).getAttribute('data-revision'));
  await expect(row(page, s).getByRole('button', { name: button, exact: true })).toBeDisabled();
  if (kind) await row(page, s).getByLabel(/Tipo de excepci\u00f3n/).selectOption(kind);
  await row(page, s).getByLabel(name === 'approve_session_exception' ? /Motivo de excepci\u00f3n/
    : name === 'cancel_session_reservation' ? /Motivo de cancelaci\u00f3n/ : /Motivo de exenci\u00f3n/).fill(reason);
  const responsePromise = page.waitForResponse(response => response.url() === `${apiUrl}/rest/v1/rpc/${name}`
    && response.request().method() === 'POST' && response.request().postDataJSON().p_session_id === s.id);
  await row(page, s).getByRole('button', { name: button, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const args = response.request().postDataJSON();
  expect(Object.keys(args).sort()).toEqual(['p_session_id', 'p_student_id', 'p_request_key', 'p_expected_revision', 'p_reason',
    ...(kind ? ['p_kind'] : [])].sort());
  expect(args).toMatchObject({ p_session_id: s.id, p_student_id: s.subject.studentId, p_expected_revision: revision,
    p_reason: reason, ...(kind ? { p_kind: kind } : {}) });
  expect(args.p_request_key).toMatch(uuid);
  const result = await response.json();
  receipt(result, s, args);
  await expect(dialog(page)).toHaveAttribute('data-revision', String(result.revision));
  return { args, result };
}

for (const [key, kind, balance] of [['uiPending', 'membership_override', 3], ['uiCourtesy', 'no_credit', 0]] as const)
  test(`policy2 real employee UI ${kind}: explicit approval, provisional save and finalization show persisted business state`, async ({ page }) => {
    const s = await reserve(key);
    await loginBrowser(page, 'employee@pottery.local');
    await open(page, s);
    const reason = `UI individual ${kind} ${manifest.runId}`;
    const { result } = await uiAction(page, s, 'approve_session_exception', 'Aprobar excepci\u00f3n', reason, kind);
    await expect(row(page, s).getByTestId('exception-state')).toContainText(reason);
    await expect(row(page, s).getByTestId('exception-state')).toContainText(employee.id);
    await row(page, s).getByRole('button', { name: /^Marcar asistencia de / }).click();
    await dialog(page).getByRole('button', { name: 'Guardar provisional', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    const provisional = await snapshot(s);
    noFinance(provisional, kind === 'no_credit' ? 0 : 4);
    expect(provisional.state[0]).toMatchObject({ exception_id: result.exception_id, billing_state: 'unfinalized' });
    await open(page, s);
    await dialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    const finalized = await snapshot(s);
    expect(finalized.students[0].classes_remaining).toBe(balance);
    expect(finalized.students[0].payment_status).toBe(kind === 'no_credit' ? 'paid' : 'pending');
    expect(finalized.state[0]).toMatchObject({ billing_state: kind === 'no_credit' ? 'no_charge' : 'charged',
      billing_kind: kind === 'no_credit' ? 'courtesy' : 'attendance', exception_id: result.exception_id });
    await open(page, s);
    await expect(row(page, s)).toHaveAttribute('data-billing-state', kind === 'no_credit' ? 'no_charge' : 'charged');
    await expect(row(page, s).getByRole('button', { name: 'Eximir penalizaci\u00f3n (propietario)', exact: true })).toHaveCount(0);
  });

test('policy2 real cancellation UI retains the cancelled row, server timestamp and free finalization', async ({ page }) => {
  const s = await reserve('uiTimely', 12, 9);
  await loginBrowser(page);
  await open(page, s);
  const { result } = await uiAction(page, s, 'cancel_session_reservation', 'Cancelar reserva', 'UI timely cancellation');
  expect(result.cancellation_kind).toBe('timely');
  await expect(row(page, s)).toHaveAttribute('data-reservation-state', 'cancelled');
  await expect(row(page, s).getByTestId('cancellation-state')).toContainText(result.cancelled_at);
  await expect(row(page, s).getByRole('button', { name: /^Marcar asistencia de / })).toBeDisabled();
  noFinance(await snapshot(s), 4);
  await dialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const finalized = await snapshot(s);
  noFinance(finalized, 4);
  expect(finalized.state[0]).toMatchObject({ reservation_state: 'cancelled', billing_state: 'no_charge',
    billing_kind: 'timely_cancellation', cancelled_at: result.cancelled_at });
});

test('policy2 real owner waiver UI acts only after a persisted no-show penalty and restores the original source exactly once', async ({ page }) => {
  const s = await reserve('uiWaiver');
  await loginBrowser(page);
  await open(page, s);
  await expect(row(page, s).getByRole('button', { name: 'Eximir penalizaci\u00f3n (propietario)', exact: true })).toHaveCount(0);
  await row(page, s).getByRole('button', { name: /^Marcar falta de / }).click();
  await dialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const charged = await snapshot(s);
  oneDebit(s, charged);
  expect(charged.state[0].penalty_state).toBe('charged');
  await open(page, s);
  const reason = `UI owner justified absence ${manifest.runId}`;
  const { args, result } = await uiAction(page, s, 'waive_session_penalty', 'Eximir penalizaci\u00f3n (propietario)', reason);
  expect(result.penalty_id).toBe(charged.penalties[0].id);
  await expect(row(page, s)).toHaveAttribute('data-billing-state', 'waived');
  await expect(row(page, s).getByRole('button', { name: 'Eximir penalizaci\u00f3n (propietario)', exact: true })).toHaveCount(0);
  const waived = await snapshot(s);
  expect(waived.students[0].classes_remaining).toBe(4);
  expect(waived.credits).toContainEqual(expect.objectContaining({ delta: 1, reverses_id: charged.credits[0].id,
    period_id: s.subject.periodId, gift_card_id: null, created_by: owner.id }));
  expect(waived.waivers[0]).toMatchObject({ waived_by: owner.id, reason, reversal_id: waived.credits[1].id });
  expect(await rpc(owner, 'waive_session_penalty', args)).toEqual({ ...result, replayed: true });
  expect(await snapshot(s)).toEqual(waived);
});

for (const [key, operation, name, button] of [
  ['uiApprovalRecovery', 'approve_exception', 'approve_session_exception', 'Aprobar excepci\u00f3n'],
  ['uiCancelRecovery', 'cancel_reservation', 'cancel_session_reservation', 'Cancelar reserva'],
  ['uiWaiverRecovery', 'waive_penalty', 'waive_session_penalty', 'Eximir penalizaci\u00f3n (propietario)']
] as const) test(`policy2 real ${operation} commit with lost delivery survives browser reload and replays the original stored body exactly once`, async ({ page, context }) => {
  const s = await reserve(key, 12, operation === 'cancel_reservation' ? 9 : undefined);
  const actor = operation === 'waive_penalty' ? owner : employee;
  let revision = 1;
  if (operation === 'waive_penalty') {
    await rpc(owner, 'save_session_attendance', attendanceArgs(s, revision++, 'absent'));
    const charged = await snapshot(s);
    oneDebit(s, charged);
    expect(charged.state[0].penalty_state).toBe('charged');
  }
  const baseline = await snapshot(s);
  await loginBrowser(page, operation === 'waive_penalty' ? 'staff@pottery.local' : 'employee@pottery.local');
  await open(page, s);
  const bodies: string[] = [];
  let committed: Row | undefined;
  await context.route(`${apiUrl}/rest/v1/rpc/${name}`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postData() || '';
    if (JSON.parse(body).p_session_id !== s.id) return route.fallback();
    bodies.push(body);
    if (bodies.length > 1) return route.fallback();
    // Forward the real Auth write and discard ONLY delivery of its committed
    // receipt. The subsequent reload/retry uses the actual app and PostgreSQL.
    try {
      const headers = route.request().headers();
      if (headers.apikey !== anonKey || jwtRole(headers.authorization?.replace(/^Bearer /i, '') || '') !== 'authenticated') {
        throw new Error('Recovery forwarding requires the authenticated browser JWT and public anon key.');
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
      if (response.status() === 200) committed = await response.json();
      await response.dispose();
    } catch { /* Assertions require independent proof of the actual commit. */ }
    await route.abort('failed');
  });
  const reason = `Original ${operation} recovery reason ${manifest.runId}`;
  const target = row(page, s);
  if (operation === 'approve_exception') await target.getByLabel(/Tipo de excepci\u00f3n/).selectOption('membership_override');
  await target.getByLabel(operation === 'approve_exception' ? /Motivo de excepci\u00f3n/
    : operation === 'cancel_reservation' ? /Motivo de cancelaci\u00f3n/ : /Motivo de exenci\u00f3n/).fill(reason);
  await target.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  expect(bodies).toHaveLength(1);
  const args = JSON.parse(bodies[0]);
  expect(Object.keys(args).sort()).toEqual(['p_session_id', 'p_student_id', 'p_request_key', 'p_expected_revision', 'p_reason',
    ...(operation === 'approve_exception' ? ['p_kind'] : [])].sort());
  expect(args).toMatchObject({ p_session_id: s.id, p_student_id: s.subject.studentId, p_expected_revision: revision,
    p_reason: reason, ...(operation === 'approve_exception' ? { p_kind: 'membership_override' } : {}) });
  expect(args.p_request_key).toMatch(uuid);
  expect(committed).toBeDefined();
  receipt(committed!, s, args);
  const afterCommit = await snapshot(s);
  expect(afterCommit.sessions[0].revision).toBe(revision + 1);
  expect(afterCommit.receipts).toHaveLength(baseline.receipts.length + 1);
  expect(afterCommit.receipts.filter((r: Row) => r.operation === name)).toEqual([expect.objectContaining({
    request_key: args.p_request_key, created_by: actor.id, result: committed
  })]);
  expect(afterCommit.periods).toEqual(baseline.periods);
  if (operation === 'approve_exception') {
    noFinance(afterCommit, 4);
    expect(afterCommit.students).toEqual(baseline.students);
    expect(afterCommit.exceptions).toEqual([expect.objectContaining({ id: committed!.exception_id, reason,
      approved_by: employee.id, period_id: s.subject.periodId, revision: revision + 1 })]);
  } else if (operation === 'cancel_reservation') {
    noFinance(afterCommit, 4);
    expect(committed!.cancellation_kind).toBe('timely');
    expect(committed!.cancelled_at).toBeTruthy();
    expect(afterCommit.roster[0]).toMatchObject({ cancelled_at: committed!.cancelled_at,
      cancellation_reason: reason, cancelled_by: employee.id });
  } else {
    expect(afterCommit.students[0].classes_remaining).toBe(4);
    expect(afterCommit.credits).toEqual([baseline.credits[0], expect.objectContaining({ delta: 1,
      reverses_id: baseline.credits[0].id, period_id: s.subject.periodId, gift_card_id: null, created_by: owner.id })]);
    expect(afterCommit.waivers).toEqual([expect.objectContaining({ penalty_id: baseline.penalties[0].id,
      reason, waived_by: owner.id, reversal_id: afterCommit.credits[1].id })]);
  }
  expect(afterCommit.events.filter((event: Row) => event.event === (operation === 'approve_exception' ? 'exception_approved'
    : operation === 'cancel_reservation' ? 'reservation_cancelled' : 'penalty_waived'))).toHaveLength(1);
  const storageKey = `atomic-session-intent:${ownSede}:${s.id}`;
  const retainedRaw = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
  const retained = JSON.parse(retainedRaw || 'null');
  expect(retained).toMatchObject({ operation, sessionId: s.id, requestKey: args.p_request_key, args });
  expect(JSON.parse(retained.input)).toMatchObject({ operation, sessionId: s.id, studentId: s.subject.studentId,
    requestKey: args.p_request_key, expectedRevision: revision, reason });

  await page.reload();
  await expect(dialog(page)).toBeVisible();
  const descriptor = dialog(page).getByTestId('pending-session-operation');
  await expect(descriptor).toHaveAttribute('data-operation', operation);
  await expect(descriptor).toContainText(reason);
  await expect(dialog(page)).toHaveAttribute('data-revision', String(revision + 1));
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal', exact: true })).toBeDisabled();
  await expect(row(page, s).getByRole('button', { name: /^Marcar asistencia de / })).toBeDisabled();
  expect(bodies).toHaveLength(1);
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(retainedRaw);
  expect(await snapshot(s), 'Reload must not regenerate or execute any pending business write').toEqual(afterCommit);
  const replayResponse = page.waitForResponse(response => response.url() === `${apiUrl}/rest/v1/rpc/${name}`
    && response.request().method() === 'POST' && response.request().postDataJSON().p_session_id === s.id);
  await dialog(page).getByRole('button', { name: 'Reintentar operaci\u00f3n', exact: true }).click();
  const replay = await replayResponse;
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual({ ...committed, replayed: true });
  await expect(descriptor).toHaveCount(0);
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(await snapshot(s), 'Recovery must preserve the original revision, receipt, approval/cancellation/waiver and all financial history').toEqual(afterCommit);
});
