import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { test as base, expect, type Page } from '@playwright/test';
import { apiUrl, frontendUrl, projectId, redact, testPassword } from '../../scripts/local-staging-runtime.mjs';

type Row = Record<string, any>;
type Actor = { id: string; token: string };
type Subject = { kind: string; studentId: string; periodId?: string; successorId?: string; cardId?: string; alternativeCardId?: string };
type Session = { id: string; key: string; metadata: Row };
type Manifest = { version: number; projectId: string; runId: string; today: string; sedeId: string;
  preservationChecks: string; actors: Record<string, string>; subjects: Record<string, Subject>;
  initial: Record<string, { student: Row; periods: Row[]; cards: Row[] }> };
const ownSede = '30000000-0000-0000-0000-000000000001';
const foreignSede = '30000000-0000-0000-0000-000000000002';
const anonKey = process.env.TEST_LOCAL_SUPABASE_ANON_KEY || '';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorKeys = ['staff_id', 'other_id', 'reader_id', 'employee_id', 'supervisor_id'];
const subjectKinds = { known: 'known', unknown: 'unknown', manualAttendance: 'zero', giftSettlement: 'gift',
  blockedSuccessor: 'queued', missingSource: 'zero', approvalRecovery: 'known', settlementRecovery: 'gift', waiverRecovery: 'gift',
  approvalRefreshRecovery: 'known', settlementRefreshRecovery: 'gift', waiverRefreshRecovery: 'gift',
  approvalRejectedRefreshRecovery: 'known', settlementRejectedRefreshRecovery: 'gift', waiverRejectedRefreshRecovery: 'gift' };
const historyTables = ['session_business_exceptions', 'session_business_penalties', 'session_business_waivers',
  'session_business_billing', 'session_business_events', 'session_credit_movements', 'student_penalty_settlements'];
let manifest: Manifest;
let owner: Actor;
let foreign: Actor;
let integration: Actor;
let employee: Actor;
let supervisor: Actor;
let seedBefore: Row;

function jwtRole(token: string) {
  try { return JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString()).role; } catch { return undefined; }
}
const safe = (text: unknown) => redact(String(text || ''))
  .replace(/("(?:refresh_token|authorization|apikey)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted credential]"')
  .replaceAll(anonKey || '\u0000', '[redacted public key]')
  .replaceAll(testPassword, '[redacted password]');

// Tests never import fixture/DB helpers or receive administrative credentials.
async function http(actor: Actor | null, route: string, method = 'GET', body?: unknown) {
  if (!/^\/(?:rest\/v1\/(?:[a-z_]+\?|rpc\/[a-z_]+$)|auth\/v1\/(?:token\?grant_type=password$|user$))/.test(route)
    || route.includes('://') || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)
    || jwtRole(anonKey) !== 'anon' || (actor && jwtRole(actor.token) !== 'authenticated')) {
    throw new Error('Only fixed loopback public-key Auth/PostgREST operations allowed.');
  }
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { apikey: anonKey, Authorization: `Bearer ${actor?.token || anonKey}`, 'Content-Type': 'application/json',
        Prefer: 'return=representation' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new Error(`Local transport failed: ${method} ${route.split('?')[0]}`); }
  let data: any;
  try { const text = await response.text(); data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Local API returned non-JSON: HTTP ${response.status}`); }
  return { status: response.status, data };
}
async function ok(actor: Actor | null, route: string, method = 'GET', body?: unknown): Promise<any> {
  const result = await http(actor, route, method, body);
  if (result.status < 200 || result.status >= 300) {
    const code = /^[A-Z0-9]{5,8}$/.test(result.data?.code || '') ? result.data.code : 'unclassified';
    throw new Error(`Local API rejected ${method} ${route.split('?')[0]}: HTTP ${result.status}, code ${code}`);
  }
  return result.data;
}
const rows = (actor: Actor, table: string, filter: string, order = 'id'): Promise<Row[]> =>
  ok(actor, `/rest/v1/${table}?select=*&${filter}${order ? `&order=${order}` : ''}`);
const rpc = (actor: Actor, name: string, args: Row) => ok(actor, `/rest/v1/rpc/${name}`, 'POST', args);
const inIds = (ids: string[]) => `in.(${ids.join(',')})`;
async function reject(actor: Actor | null, name: string, args: Row, code = 'P0001') {
  const response = await http(actor, `/rest/v1/rpc/${name}`, 'POST', args);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(600);
  if (code === '42501' && actor) expect(response.status).toBe(403);
  expect(response.data?.code).toBe(code);
}

const test = base.extend<{ isolation: void }>({
  isolation: [async ({ context, page }, use, testInfo) => {
    const rejected: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(safe(error.message)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(safe(message.text())); });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if ([frontendUrl, apiUrl].includes(url.origin)) {
        if (url.origin === apiUrl) {
          const headers = request.headers();
          const token = headers.authorization?.replace(/^Bearer /i, '');
          if (url.pathname.startsWith('/auth/v1/admin') || (headers.apikey && headers.apikey !== anonKey)
            || (token && !['anon', 'authenticated'].includes(jwtRole(token)))) {
            rejected.push('Privileged browser Auth/API operation');
            return route.abort('blockedbyclient');
          }
        }
        return route.continue();
      }
      // No remote network, including fonts/CDN. Only presentation assets are
      // fulfilled locally; Auth, REST and application data are NEVER mocked.
      if (request.method() === 'GET' && url.protocol === 'https:' && url.hostname === 'cdn.tailwindcss.com'
        && request.resourceType() === 'script' && /^\/(?:\d+\.\d+\.\d+)?$/.test(url.pathname)) {
        return route.fulfill({ contentType: 'application/javascript', body: 'globalThis.tailwind = { config: {} };' });
      }
      if (request.method() === 'GET' && url.protocol === 'https:' && url.hostname === 'fonts.googleapis.com'
        && url.pathname === '/css2' && request.resourceType() === 'stylesheet') {
        return route.fulfill({ contentType: 'text/css', body: '' });
      }
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
      for (const error of testInfo.errors) {
        if (error.message) error.message = safe(error.message);
        if (error.stack) error.stack = safe(error.stack);
        if (error.value) error.value = safe(error.value);
      }
      if (testInfo.status !== testInfo.expectedStatus) {
        console.log(`Sanitized local browser diagnostics (no headers/bodies/artifacts): ${safe(JSON.stringify({ pageErrors, consoleErrors }))}`);
      }
      expect(rejected, 'Remote networks and privileged browser operations are blocked').toEqual([]);
      expect(pageErrors, 'Browser execution must not fail').toEqual([]);
      expect(context.serviceWorkers()).toHaveLength(0);
    }
  }, { auto: true }]
});
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: frontendUrl, serviceWorkers: 'block', timezoneId: 'Europe/Madrid',
  trace: 'off', screenshot: 'off', video: 'off', launchOptions: {
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    // Prevent even HTML preconnect hints from resolving remote presentation hosts.
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
  } });

async function login(email: string, key: string, role: string): Promise<Actor> {
  const data = await ok(null, '/auth/v1/token?grant_type=password', 'POST', { email, password: testPassword });
  if (jwtRole(data.access_token) !== 'authenticated' || data.user?.email !== email || data.user.id !== manifest.actors[key]) {
    throw new Error('Password Auth identity differs from controlled public manifest.');
  }
  const actor = { id: data.user.id, token: data.access_token };
  const profiles = await rows(actor, 'profiles', `id=eq.${actor.id}`);
  expect(profiles).toEqual([expect.objectContaining({ id: actor.id, email, role })]);
  return actor;
}
async function seedSnapshot() {
  const students = [1, 2, 3, 4].map(n => `10000000-0000-0000-0000-00000000000${n}`);
  const sessions = [1, 2, 3, 4].map(n => `20000000-0000-0000-0000-00000000000${n}`);
  const queries: [string, string, string][] = [
    ['students', `id=${inIds(students)}`, 'id'], ['student_membership_periods', `student_id=${inIds(students)}`, 'id'],
    ['student_membership_class_adjustments', `student_id=${inIds(students)}`, 'id'],
    ['gift_cards', `recipient_student_id=${inIds(students)}`, 'id'], ['gift_card_movements', `student_id=${inIds(students)}`, 'id'],
    ['gift_card_operation_receipts', `student_id=${inIds(students)}`, 'request_key'],
    ['student_manual_credit_entitlements', `student_id=${inIds(students)}`, 'id'],
    ['manual_credit_entitlements_with_balance', `student_id=${inIds(students)}`, 'entitlement_id'],
    ['student_credit_profile', `student_id=${inIds(students)}`, 'student_id'],
    ['sessions', `id=${inIds(sessions)}`, 'id'], ['session_students', `session_id=${inIds(sessions)}`, 'id'],
    ['session_operation_receipts', `session_id=${inIds(sessions)}`, 'session_id,request_key'],
    ...historyTables.map(table => [table, `session_id=${inIds(sessions)}`,
      table === 'session_business_waivers' ? 'penalty_id' : table === 'session_business_billing' ? 'session_id,student_id' : 'id'] as [string, string, string]),
    ['session_business_state', `session_id=${inIds(sessions)}`, 'session_id,student_id'],
    ['session_pending_penalties', `session_id=${inIds(sessions)}`, 'penalty_id'],
    ['sedes', `id=${inIds([ownSede, foreignSede])}`, 'id'],
    ['sede_members', `sede_id=${inIds([ownSede, foreignSede])}`, 'sede_id,user_id'],
    ['workshop_schedules', `sede_id=${inIds([ownSede, foreignSede])}`, 'id'],
    ['workshop_capacity_defaults', `sede_id=${inIds([ownSede, foreignSede])}`, 'sede_id,class_type'],
    ['workshop_schedule_exceptions', `sede_id=${inIds([ownSede, foreignSede])}`, 'id'],
    ['teachers', 'id=eq.70000000-0000-0000-0000-000000000001', 'id']
  ];
  return Object.fromEntries(await Promise.all(queries.map(async ([table, filter, order]) => [table,
    [...await rows(owner, table, filter, order), ...await rows(foreign, table, filter, order)]
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])));
}

test.beforeAll(async () => {
  if (process.env.BASE_URL !== frontendUrl || apiUrl !== 'http://127.0.0.1:55321'
    || frontendUrl !== 'http://127.0.0.1:3017' || projectId !== 'pottery-gym-local-staging' || jwtRole(anonKey) !== 'anon'
    || Object.keys(process.env).some(key => /(?:SERVICE_ROLE|SECRET|TOKEN|PASSWORD|(?:API|ACCESS)[_-]?KEY|DATABASE_URL|DB_URL|JWT)/i.test(key))) {
    throw new Error('Use only the sanitized owned local-staging runner.');
  }
  try {
    manifest = JSON.parse(inflateRawSync(Buffer.from(process.env.TEST_LOCAL_MANUAL_CREDIT_FIXTURES || '', 'base64'),
      { maxOutputLength: 1024 * 1024 }).toString('utf8'));
  }
  catch { throw new Error('Parent-prepared public manual-credit manifest required.'); }
  if (manifest.version !== 1 || manifest.projectId !== projectId || !uuid.test(manifest.runId)
    || manifest.sedeId !== ownSede || manifest.preservationChecks !== 'existing_rows_unchanged'
    || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.today)
    || Object.keys(manifest.actors).sort().join(',') !== [...actorKeys].sort().join(',')
    || new Set(Object.values(manifest.actors)).size !== 5 || Object.values(manifest.actors).some(id => !uuid.test(id))
    || Object.keys(manifest.subjects).sort().join(',') !== Object.keys(subjectKinds).sort().join(',')) {
    throw new Error('Invalid controlled local manual-credit manifest.');
  }
  const ids = [manifest.runId, ...Object.values(manifest.subjects).flatMap(subject => Object.entries(subject)
    .filter(([key]) => key.endsWith('Id')).map(([, value]) => value))];
  if (ids.some(id => !uuid.test(id)) || new Set(ids).size !== ids.length) throw new Error('Fresh distinct fixture UUIDs required.');
  const identityResponse = await fetch(`${frontendUrl}/__local-staging`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const identity = await identityResponse.json();
  expect(identityResponse.status).toBe(200);
  expect({ projectId: identity.projectId, apiUrl: identity.apiUrl, frontendUrl: identity.frontendUrl })
    .toEqual({ projectId, apiUrl, frontendUrl });
  [owner, foreign, integration, employee, supervisor] = await Promise.all([
    login('staff@pottery.local', 'staff_id', 'tallerista'), login('other@pottery.local', 'other_id', 'tallerista'),
    login('reader@pottery.local', 'reader_id', 'tallerista'), login('employee@pottery.local', 'employee_id', 'staff'),
    login('supervisor@pottery.local', 'supervisor_id', 'super_admin')
  ]);
  expect(await rows(owner, 'sedes', `id=eq.${ownSede}`)).toEqual([expect.objectContaining({ owner_id: owner.id, is_active: true })]);
  expect(await rows(foreign, 'sedes', `id=eq.${foreignSede}`)).toEqual([expect.objectContaining({ owner_id: foreign.id, is_active: true })]);
  for (const [actor, role] of [[employee, 'staff'], [supervisor, 'super_admin']] as const) {
    expect(await rows(actor, 'sede_members', `user_id=eq.${actor.id}`, 'sede_id,user_id'))
      .toEqual([expect.objectContaining({ sede_id: ownSede, user_id: actor.id, role })]);
    expect(await rows(actor, 'sedes', `owner_id=eq.${actor.id}`)).toEqual([]);
  }
  expect(await rows(integration, 'sede_members', 'limit=1', '')).toEqual([]);
  expect(await rows(integration, 'sedes', 'limit=1', '')).toEqual([]);
  for (const [key, subject] of Object.entries(manifest.subjects)) {
    expect(subject.kind).toBe(subjectKinds[key]);
    const initial = manifest.initial[key];
    expect(await rows(owner, 'students', `id=eq.${subject.studentId}`)).toEqual([initial.student]);
    expect(initial.student).toMatchObject({ id: subject.studentId, sede_id: ownSede,
      full_name: `Manual ${key} ${subject.studentId}`, name: `Manual ${key} ${subject.studentId}`, surname: null,
      student_category: subject.kind === 'queued' ? 'membresia' : 'temporal',
      payment_status: subject.kind === 'queued' ? 'paid' : 'pending',
      classes_remaining: subject.kind === 'unknown' ? null : subject.kind === 'known' ? 3 : subject.kind === 'queued' ? 4 : 0 });
    expect(await rows(owner, 'student_membership_periods', `student_id=eq.${subject.studentId}`)).toEqual(initial.periods);
    expect(await rows(owner, 'gift_cards', `recipient_student_id=eq.${subject.studentId}`)).toEqual(initial.cards);
    expect(initial.periods).toHaveLength(subject.kind === 'queued' ? 2 : 0);
    expect(initial.cards).toHaveLength(['gift', 'queued'].includes(subject.kind) ? 2 : 0);
    expect(await rows(owner, 'student_manual_credit_entitlements', `student_id=eq.${subject.studentId}`)).toEqual([]);
    expect(await rows(owner, 'session_students', `student_id=eq.${subject.studentId}`)).toEqual([]);
  }
  seedBefore = await seedSnapshot();
});
test.afterAll(async () => {
  if (seedBefore) expect(await seedSnapshot(), 'Original seed, both sedes, policy history and financial observations stay unchanged').toEqual(seedBefore);
});

async function snapshot(key: string): Promise<Row> {
  const subject = manifest.subjects[key];
  const filter = `student_id=eq.${subject.studentId}`;
  const cardIds = [subject.cardId, subject.alternativeCardId].filter((id): id is string => !!id);
  const giftFilter = cardIds.length ? `or=(student_id.eq.${subject.studentId},gift_card_id.${inIds(cardIds)})` : filter;
  const roster = await rows(owner, 'session_students', filter);
  const sessionIds = [...new Set(roster.map(row => row.session_id as string))];
  const queries: Record<string, Promise<Row[]>> = {
    students: rows(owner, 'students', `id=eq.${subject.studentId}`), periods: rows(owner, 'student_membership_periods', filter),
    cards: rows(owner, 'gift_cards', `recipient_student_id=eq.${subject.studentId}`),
    adjustments: rows(owner, 'student_membership_class_adjustments', filter), gifts: rows(owner, 'gift_card_movements', giftFilter, 'ledger_order'),
    giftReceipts: rows(owner, 'gift_card_operation_receipts', giftFilter, 'request_key'),
    entitlements: rows(owner, 'student_manual_credit_entitlements', filter),
    balances: rows(owner, 'manual_credit_entitlements_with_balance', filter, 'entitlement_id'),
    profiles: rows(owner, 'student_credit_profile', filter, 'student_id'),
    incidents: rows(owner, 'session_pending_penalties', filter, 'penalty_id'),
    state: rows(owner, 'session_business_state', filter, 'session_id,student_id'),
    sessions: sessionIds.length ? rows(owner, 'sessions', `id=${inIds(sessionIds)}`) : Promise.resolve([]),
    receipts: sessionIds.length ? rows(owner, 'session_operation_receipts', `session_id=${inIds(sessionIds)}`, 'session_id,request_key') : Promise.resolve([])
  };
  for (const table of historyTables) queries[table === 'session_credit_movements' ? 'credits'
    : table === 'student_penalty_settlements' ? 'settlements' : table.replace('session_business_', '')] = rows(owner, table, filter,
    table === 'session_business_waivers' ? 'penalty_id' : table === 'session_business_billing' ? 'session_id,student_id'
      : table === 'session_credit_movements' ? 'revision,id' : 'id');
  return { roster, ...Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, query]) => [name, await query]))) };
}
const date = (days: number) => new Date(Date.parse(`${manifest.today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const approvalArgs = (key: string, mode = 'new_manual', quantity = 2): Row => ({
  p_student_id: manifest.subjects[key].studentId, p_request_key: randomUUID(), p_mode: mode, p_quantity: quantity,
  p_expected_legacy_balance: manifest.initial[key].student.classes_remaining, p_activity: 'mesa',
  p_starts_on: date(-1), p_ends_on: date(29), p_reason: `Owner ${mode} ${key} ${manifest.runId}`,
  p_evidence: `Synthetic signed source ${key} ${manifest.runId}`
});
function approvalReceipt(result: Row, args: Row, replayed = false) {
  expect(result).toEqual({ student_id: args.p_student_id, request_key: args.p_request_key,
    entitlement_id: expect.stringMatching(uuid), remaining_classes: args.p_quantity, replayed });
}
function rawUnchanged(key: string, state: Row) {
  expect(state.students).toEqual([manifest.initial[key].student]);
  expect(state.profiles).toHaveLength(1);
  expect(state.profiles[0]).toMatchObject({ student_id: manifest.subjects[key].studentId, sede_id: ownSede,
    legacy_observed_balance: manifest.initial[key].student.classes_remaining, legacy_raw_state: manifest.initial[key].student });
  expect(state.periods).toEqual(manifest.initial[key].periods);
  expect(state.adjustments).toEqual([]);
}
function approved(key: string, state: Row, args: Row, result: Row, remaining = args.p_quantity) {
  rawUnchanged(key, state);
  expect(state.entitlements).toContainEqual(expect.objectContaining({ id: result.entitlement_id,
    student_id: args.p_student_id, sede_id: ownSede, request_key: args.p_request_key, mode: args.p_mode, quantity: args.p_quantity,
    expected_legacy_balance: args.p_expected_legacy_balance, activity: args.p_activity, starts_on: args.p_starts_on,
    ends_on: args.p_ends_on, reason: args.p_reason, evidence: args.p_evidence, approved_by: owner.id,
    legacy_snapshot: manifest.initial[key].student, result }));
  expect(state.balances).toContainEqual(expect.objectContaining({ entitlement_id: result.entitlement_id, remaining_classes: remaining }));
  expect(state.profiles[0].manual_credits).toEqual(state.balances);
}
async function reserve(key: string, manualId?: string, giftId?: string): Promise<Session> {
  const id = randomUUID();
  const metadata = { date: manifest.today, start_time: `${manifest.today}T12:00:00Z`, end_time: `${manifest.today}T13:00:00Z`,
    class_type: 'mesa', capacity: 1, teacher_id: '70000000-0000-0000-0000-000000000001', session_audience: 'membresia' };
  const studentId = manifest.subjects[key].studentId;
  const args = { p_session_id: id, p_request_key: randomUUID(), p_expected_revision: 0, p_sede_id: ownSede,
    p_metadata: metadata, p_student_ids: [studentId], p_gift_card_ids: giftId ? { [studentId]: giftId } : {},
    p_manual_credit_ids: manualId ? { [studentId]: manualId } : {} };
  const result = await rpc(owner, 'save_session_reservation', args);
  expect(result).toMatchObject({ session_id: id, request_key: args.p_request_key, revision: 1, replayed: false,
    session: { attendance_policy_version: 2 }, student_ids: [studentId] });
  const initial = await snapshot(key);
  expect(initial.credits).toEqual([]);
  expect(initial.roster).toEqual([expect.objectContaining({ session_id: id, student_id: studentId, sede_id: ownSede,
    manual_credit_id: manualId || null, gift_card_id: giftId || null,
    membership_period_id: manualId || giftId ? null : manifest.subjects[key].periodId || null })]);
  expect(initial.state[0]).toMatchObject({ billing_state: 'unfinalized', funding_manual_credit_id: manualId || null,
    funding_gift_card_id: giftId || null });
  expect(await rpc(owner, 'save_session_reservation', args)).toEqual({ ...result, replayed: true });
  expect(await snapshot(key)).toEqual(initial);
  return { id, key, metadata };
}
const attendanceArgs = (s: Session, status = 'absent', revision = 1, finalize = true) => ({
  p_session_id: s.id, p_request_key: randomUUID(), p_expected_revision: revision,
  p_attendance: [{ student_id: manifest.subjects[s.key].studentId, status }], p_finalize: finalize, p_teacher_substitute_id: null
});
const settleArgs = (state: Row): Row => ({ p_penalty_id: state.penalties[0].id, p_request_key: randomUUID(),
  p_expected_revision: state.sessions[0].revision, p_reason: `Owner original-only settlement ${manifest.runId}` });
const waiveArgs = (s: Session, state: Row): Row => ({ p_session_id: s.id, p_student_id: manifest.subjects[s.key].studentId,
  p_request_key: randomUUID(), p_expected_revision: state.sessions[0].revision, p_reason: `Owner documented waiver ${manifest.runId}` });
function sessionReceipt(result: Row, args: Row, operation: string, state: Row) {
  expect(result).toMatchObject({ request_key: args.p_request_key, revision: args.p_expected_revision + 1, replayed: false });
  expect(state.receipts.filter((row: Row) => row.request_key === args.p_request_key)).toEqual([expect.objectContaining({
    session_id: state.sessions[0].id, request_key: args.p_request_key, operation, result, created_by: owner.id })]);
}
async function incident(key: string, gift = false) {
  const s = await reserve(key, undefined, gift ? manifest.subjects[key].cardId : undefined);
  const before = await snapshot(key);
  const args = attendanceArgs(s);
  const result = await rpc(owner, 'save_session_attendance', args);
  const pending = await snapshot(key);
  rawUnchanged(key, pending);
  expect(pending.cards).toEqual(before.cards);
  expect(pending.credits).toEqual([]);
  expect(pending.gifts).toEqual([]);
  expect(pending.giftReceipts).toEqual([]);
  expect(pending.penalties).toEqual([expect.objectContaining({ session_id: s.id, student_id: manifest.subjects[key].studentId,
    sede_id: ownSede, state: 'pending', kind: 'no_show', period_id: manifest.subjects[key].periodId || null,
    gift_card_id: gift ? manifest.subjects[key].cardId : null, manual_credit_id: null, debit_id: null, created_by: owner.id })]);
  expect(pending.incidents[0]).toMatchObject({ penalty_id: pending.penalties[0].id, expected_revision: 2,
    is_pending: true, is_waived: false, original_penalty_state: 'pending', settlement_id: null });
  expect(pending.state[0]).toMatchObject({ billing_state: 'incident', penalty_state: 'pending', billing_debit_id: null });
  sessionReceipt(result, args, 'attendance', pending);
  return { s, pending };
}
async function makeGiftUsable(key: string) {
  const subject = manifest.subjects[key];
  const before = await snapshot(key);
  const original = before.cards.find((card: Row) => card.id === subject.cardId);
  expect(original).toMatchObject({ payment_status: 'pending', status: 'pending', sessions_used: 0 });
  const paid = await rpc(owner, 'confirm_gift_card_payment', { p_gift_card_id: subject.cardId });
  expect(paid).toEqual({ ...original, payment_status: 'paid', status: 'active' });
  const after = await snapshot(key);
  rawUnchanged(key, after);
  expect(after.cards.find((card: Row) => card.id === subject.alternativeCardId))
    .toEqual(before.cards.find((card: Row) => card.id === subject.alternativeCardId));
  expect(after.penalties).toEqual(before.penalties);
  expect(after.credits).toEqual([]);
  expect(after.gifts).toEqual([]);
  return after;
}
function settledGift(key: string, baseline: Row, state: Row, args: Row, result: Row) {
  const subject = manifest.subjects[key];
  rawUnchanged(key, state);
  expect(state.penalties).toEqual(baseline.penalties);
  expect(state.roster).toEqual(baseline.roster);
  expect(state.credits).toEqual([expect.objectContaining({ id: expect.stringMatching(uuid), session_id: baseline.sessions[0].id,
    student_id: subject.studentId, sede_id: ownSede, revision: args.p_expected_revision + 1, period_id: null,
    gift_card_id: subject.cardId, manual_credit_id: null, delta: -1, adjustment_id: null, reverses_id: null,
    disposition: 'gift_card', created_by: owner.id })]);
  const debit = state.credits[0];
  expect(state.settlements).toEqual([expect.objectContaining({ id: result.settlement_id, penalty_id: args.p_penalty_id,
    student_id: subject.studentId, session_id: baseline.sessions[0].id, sede_id: ownSede, request_key: args.p_request_key,
    revision: args.p_expected_revision + 1, period_id: null, gift_card_id: subject.cardId, manual_credit_id: null,
    debit_id: debit.id, reason: args.p_reason, settled_by: owner.id,
    funding_snapshot: expect.objectContaining({ gift_card_id: subject.cardId, sessions_used: 0, payment_status: 'paid', status: 'active' }) })]);
  expect(state.cards.find((card: Row) => card.id === subject.cardId))
    .toEqual({ ...baseline.cards.find((card: Row) => card.id === subject.cardId), sessions_used: 1 });
  expect(state.cards.find((card: Row) => card.id === subject.alternativeCardId))
    .toEqual(baseline.cards.find((card: Row) => card.id === subject.alternativeCardId));
  expect(state.gifts).toEqual([expect.objectContaining({ gift_card_id: subject.cardId, session_id: baseline.sessions[0].id,
    student_id: subject.studentId, movement_type: 'redeem', sessions_delta: 1, reverses_movement_id: null })]);
  expect(state.giftReceipts).toEqual([expect.objectContaining({ request_key: expect.stringMatching(uuid),
    gift_card_id: subject.cardId, session_id: baseline.sessions[0].id, sede_id: ownSede,
    student_id: subject.studentId, operation: 'redeem', created_by: owner.id,
    card_snapshot: state.cards.find((card: Row) => card.id === subject.cardId) })]);
  expect(state.incidents[0]).toMatchObject({ original_penalty_state: 'pending', penalty_state: 'charged', is_pending: false,
    settlement_id: result.settlement_id, settlement_debit_id: debit.id, settled_by: owner.id });
  expect(state.state[0]).toMatchObject({ billing_state: 'charged', penalty_state: 'charged', funding_gift_card_id: subject.cardId,
    settlement_id: result.settlement_id, settlement_debit_id: debit.id, settlement_reason: args.p_reason,
    settled_by: owner.id, settlement_revision: args.p_expected_revision + 1, billing_debit_id: debit.id });
  expect(state.events.filter((event: Row) => event.event === 'penalty_settled')).toEqual([expect.objectContaining({
    actor_id: owner.id, details: { penalty_id: args.p_penalty_id, settlement_id: result.settlement_id, debit_id: debit.id, reason: args.p_reason } })]);
  sessionReceipt(result, args, 'settle_student_penalty', state);
}
function waivedPendingGift(key: string, baseline: Row, state: Row, args: Row, result: Row) {
  rawUnchanged(key, state);
  expect(state.penalties).toEqual(baseline.penalties);
  expect(state.roster).toEqual(baseline.roster);
  expect(state.entitlements).toEqual([]);
  expect(state.settlements).toEqual([]);
  expect(state.credits).toEqual([]);
  expect(state.gifts).toEqual([]);
  expect(state.giftReceipts).toEqual([]);
  expect(state.cards).toEqual(baseline.cards);
  expect(state.waivers).toEqual([expect.objectContaining({ penalty_id: baseline.penalties[0].id,
    session_id: baseline.sessions[0].id, student_id: manifest.subjects[key].studentId, sede_id: ownSede,
    revision: args.p_expected_revision + 1, reversal_id: null, reason: args.p_reason, waived_by: owner.id })]);
  expect(state.state[0]).toMatchObject({ billing_state: 'waived', penalty_state: 'waived',
    settlement_id: null, billing_debit_id: null, waiver_reason: args.p_reason, waived_by: owner.id });
  expect(state.incidents[0]).toMatchObject({ original_penalty_state: 'pending', is_pending: false, is_waived: true });
  expect(state.events.filter((event: Row) => event.event === 'penalty_waived')).toEqual([expect.objectContaining({
    actor_id: owner.id, details: { penalty_id: baseline.penalties[0].id, reversal_id: null, reason: args.p_reason } })]);
  sessionReceipt(result, args, 'waive_session_penalty', state);
}

async function loginBrowser(page: Page, email = 'staff@pottery.local') {
  await page.goto('/login');
  await page.getByLabel('Correo electr\u00f3nico', { exact: true }).fill(email);
  await page.getByLabel('Contrase\u00f1a', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Iniciar sesi\u00f3n', exact: true }).click();
  await expect(page).toHaveURL(`${frontendUrl}/dashboard`);
}
const panel = (page: Page, key: string) => page.getByTestId('student-credit-panel')
  .and(page.locator(`[data-student-id="${manifest.subjects[key].studentId}"]`));
const penaltyRow = (page: Page, key: string, penaltyId: string) => panel(page, key).locator(`[data-penalty-id="${penaltyId}"]`);
async function openProfile(page: Page, key: string) {
  await page.goto(`/students?selected=${manifest.subjects[key].studentId}`);
  await expect(panel(page, key)).toBeVisible();
  await expect(panel(page, key)).toContainText(manifest.subjects[key].studentId);
  await expect(panel(page, key)).toContainText(ownSede);
}
async function fillApproval(page: Page, key: string, args: Row) {
  const target = panel(page, key);
  await expect(target.getByRole('button', { name: 'Aprobar cr\u00e9dito manual', exact: true })).toBeDisabled();
  await target.getByLabel('Modo del cr\u00e9dito manual', { exact: true }).selectOption(args.p_mode);
  await target.getByLabel('Cantidad de clases manuales', { exact: true }).fill(String(args.p_quantity));
  await target.getByLabel('Actividad del cr\u00e9dito manual', { exact: true }).selectOption(args.p_activity);
  await target.getByLabel('Inicio del cr\u00e9dito manual', { exact: true }).fill(args.p_starts_on);
  await target.getByLabel('Fin del cr\u00e9dito manual', { exact: true }).fill(args.p_ends_on);
  await target.getByLabel('Motivo del cr\u00e9dito manual', { exact: true }).fill(args.p_reason);
  await expect(target.getByRole('button', { name: 'Aprobar cr\u00e9dito manual', exact: true })).toBeDisabled();
  await target.getByLabel('Evidencia / origen del cr\u00e9dito manual', { exact: true }).fill(args.p_evidence);
}
function uiResponse(page: Page, name: string, studentId: string, penaltyId?: string) {
  return page.waitForResponse(response => {
    if (response.url() !== `${apiUrl}/rest/v1/rpc/${name}` || response.request().method() !== 'POST') return false;
    const args = response.request().postDataJSON();
    return name === 'settle_student_penalty' ? args.p_penalty_id === penaltyId : args.p_student_id === studentId;
  });
}
async function approveUI(page: Page, key: string, proposed: Row) {
  await fillApproval(page, key, proposed);
  const responsePromise = uiResponse(page, 'approve_student_manual_credit', manifest.subjects[key].studentId);
  await panel(page, key).getByRole('button', { name: 'Aprobar cr\u00e9dito manual', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const args = response.request().postDataJSON();
  expect(args).toEqual({ ...proposed, p_request_key: expect.stringMatching(uuid) });
  const result = await response.json();
  approvalReceipt(result, args);
  await expect(panel(page, key).locator(`[data-manual-credit-id="${result.entitlement_id}"]`)).toContainText(args.p_evidence);
  return { args, result };
}

test('known legacy: exact owner reconciliation preserves raw payment/category/balance and exposes a distinct audited ledger', async ({ page }) => {
  const key = 'known';
  const before = await snapshot(key);
  expect(before.profiles[0]).toMatchObject({ can_approve_manual_credit: true, can_reconcile_legacy: true, manual_credits: [] });
  const proposed = approvalArgs(key, 'reconcile_legacy', 3);
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'approve_student_manual_credit', proposed, '42501');
  await reject(owner, 'approve_student_manual_credit', { ...proposed, p_quantity: 2 });
  await reject(owner, 'approve_student_manual_credit', { ...proposed, p_expected_legacy_balance: 2 }, '40001');
  expect(await snapshot(key)).toEqual(before);
  await loginBrowser(page);
  await openProfile(page, key);
  await expect(panel(page, key).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 3');
  const { args, result } = await approveUI(page, key, proposed);
  const after = await snapshot(key);
  approved(key, after, args, result);
  expect(after.entitlements).toHaveLength(1);
  expect(after.credits).toEqual([]);
  expect(after.profiles[0].can_reconcile_legacy).toBe(false);
  expect(await rpc(owner, 'approve_student_manual_credit', args)).toEqual({ ...result, replayed: true });
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'approve_student_manual_credit', args, '42501');
  await reject(owner, 'approve_student_manual_credit', { ...args, p_evidence: 'Changed same-key evidence' });
  await reject(owner, 'approve_student_manual_credit', { ...args, p_request_key: randomUUID() });
  expect(await snapshot(key)).toEqual(after);
  await openProfile(page, key);
  await expect(panel(page, key).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 3');
  await expect(panel(page, key).getByTestId('manual-credit-ledger')).toContainText('3 restantes / 3 aprobadas');
  await expect(panel(page, key).getByTestId('manual-credit-ledger')).toContainText(owner.id);
});

test('unknown legacy cannot reconcile; independent new_manual requires explicit evidence and never fabricates payment or source balance', async ({ page }) => {
  const key = 'unknown';
  const before = await snapshot(key);
  expect(before.profiles[0]).toMatchObject({ legacy_observed_balance: null, can_reconcile_legacy: false, can_approve_manual_credit: true });
  const proposed = approvalArgs(key);
  await reject(owner, 'approve_student_manual_credit', { ...proposed, p_mode: 'reconcile_legacy' });
  await reject(owner, 'approve_student_manual_credit', { ...proposed, p_evidence: ' \t\n' });
  await reject(owner, 'approve_student_manual_credit', { ...proposed, p_reason: '' });
  await reject(owner, 'approve_student_manual_credit', { ...proposed, p_expected_legacy_balance: 0 }, '40001');
  expect(await snapshot(key)).toEqual(before);
  await loginBrowser(page);
  await openProfile(page, key);
  await expect(panel(page, key).getByLabel('Modo del cr\u00e9dito manual').locator('option[value="reconcile_legacy"]')).toHaveJSProperty('disabled', true);
  const { args, result } = await approveUI(page, key, proposed);
  const after = await snapshot(key);
  approved(key, after, args, result);
  expect(after.entitlements).toHaveLength(1);
  expect(after.credits).toEqual([]);
  expect(after.students[0]).toMatchObject({ classes_remaining: null, payment_status: 'pending', student_category: 'temporal' });
  await openProfile(page, key);
  await expect(panel(page, key).getByTestId('legacy-credit-observation')).toContainText('Desconocido / sin observaci\u00f3n de origen');
  await expect(panel(page, key).getByTestId('manual-credit-ledger')).toContainText('2 restantes / 2 aprobadas');
  expect(await rpc(owner, 'approve_student_manual_credit', args)).toEqual({ ...result, replayed: true });
  expect(await snapshot(key)).toEqual(after);
});

test('scoped read denial and direct history/projection writes cannot bypass real owner authority, including global superadmin', async ({ page }) => {
  const key = 'known';
  const before = await snapshot(key);
  const filter = `student_id=eq.${manifest.subjects[key].studentId}`;
  for (const actor of [foreign, integration]) {
    for (const table of ['student_credit_profile', 'manual_credit_entitlements_with_balance', 'student_manual_credit_entitlements',
      'student_penalty_settlements', 'session_pending_penalties', 'session_business_state']) {
      expect(await rows(actor, table, filter, '')).toEqual([]);
    }
  }
  for (const actor of [employee, supervisor]) {
    const profiles = await rows(actor, 'student_credit_profile', filter, 'student_id');
    expect(profiles).toEqual([{ ...before.profiles[0], can_approve_manual_credit: false, can_reconcile_legacy: false }]);
  }
  for (const table of ['student_manual_credit_entitlements', 'student_penalty_settlements']) {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const denied = await http(owner, `/rest/v1/${table}?${filter}`, method,
        method === 'DELETE' ? undefined : { reason: 'Direct history bypass' });
      expect(denied.status).toBe(403);
      expect(denied.data.code).toBe('42501');
    }
  }
  const escalation = await http(supervisor, `/rest/v1/sedes?id=eq.${ownSede}`, 'PATCH', { owner_id: supervisor.id });
  expect(escalation.status).toBe(403);
  expect(escalation.data.code).toBe('42501');
  const anonymous = await http(null, `/rest/v1/student_credit_profile?${filter}`);
  expect(anonymous.status).toBe(401);
  expect(anonymous.data.code).toBe('42501');
  expect(await snapshot(key)).toEqual(before);
  await loginBrowser(page, 'employee@pottery.local');
  await openProfile(page, key);
  await expect(panel(page, key).getByRole('button', { name: 'Aprobar cr\u00e9dito manual', exact: true })).toHaveCount(0);
  await expect(panel(page, key).getByTestId('manual-credit-ledger')).toContainText(before.entitlements[0].id);
});

test('explicit manual source reservation and real attendance UI finalize one decrement only; reload/replay preserve raw state and receipt IDs', async ({ page }) => {
  const key = 'manualAttendance';
  const args = approvalArgs(key);
  const result = await rpc(owner, 'approve_student_manual_credit', args);
  const s = await reserve(key);
  const unbound = await snapshot(key);
  await reject(owner, 'save_session_attendance', attendanceArgs(s, 'present'));
  expect(await snapshot(key), 'An available manual ledger must never be selected implicitly').toEqual(unbound);
  const selectionArgs = { p_session_id: s.id, p_request_key: randomUUID(), p_expected_revision: 1, p_sede_id: ownSede,
    p_metadata: s.metadata, p_student_ids: [manifest.subjects[key].studentId], p_gift_card_ids: {},
    p_manual_credit_ids: { [manifest.subjects[key].studentId]: result.entitlement_id } };
  const selection = await rpc(owner, 'save_session_reservation', selectionArgs);
  const before = await snapshot(key);
  approved(key, before, args, result);
  expect(before.roster).toEqual([expect.objectContaining({ student_id: manifest.subjects[key].studentId,
    session_id: s.id, manual_credit_id: result.entitlement_id, membership_period_id: null, gift_card_id: null })]);
  sessionReceipt(selection, selectionArgs, 'reservation', before);
  expect(await rpc(owner, 'save_session_reservation', selectionArgs)).toEqual({ ...selection, replayed: true });
  expect(await snapshot(key)).toEqual(before);
  const patch = await http(owner, `/rest/v1/session_students?session_id=eq.${s.id}`, 'PATCH', { manual_credit_id: null });
  expect(patch.status).toBe(403);
  expect(patch.data.code).toBe('42501');
  expect(await snapshot(key)).toEqual(before);
  await loginBrowser(page);
  await page.goto(`/calendar?date=${manifest.today}&sessionId=${s.id}&attendance=1`);
  const dialog = page.getByRole('dialog', { name: 'Control de asistencia', exact: true });
  const target = dialog.locator(`[data-student-id="${manifest.subjects[key].studentId}"]`);
  await expect(target).toBeVisible();
  await target.getByRole('button', { name: /^Marcar asistencia de / }).click();
  const responsePromise = page.waitForResponse(response => response.url() === `${apiUrl}/rest/v1/rpc/save_session_attendance`
    && response.request().postDataJSON()?.p_session_id === s.id);
  await dialog.getByRole('button', { name: 'Finalizar control', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const finalArgs = response.request().postDataJSON();
  expect(finalArgs).toMatchObject({ p_session_id: s.id, p_expected_revision: 2, p_finalize: true,
    p_attendance: [{ student_id: manifest.subjects[key].studentId, status: 'present' }] });
  const finalResult = await response.json();
  await expect(dialog).toHaveCount(0);
  const charged = await snapshot(key);
  approved(key, charged, args, result, 1);
  expect(charged.credits).toEqual([expect.objectContaining({ session_id: s.id, student_id: manifest.subjects[key].studentId,
    manual_credit_id: result.entitlement_id, period_id: null, gift_card_id: null, delta: -1, adjustment_id: null,
    reverses_id: null, disposition: 'manual_credit', revision: 3, created_by: owner.id })]);
  expect(charged.gifts).toEqual([]);
  expect(charged.giftReceipts).toEqual([]);
  expect(charged.state[0]).toMatchObject({ billing_state: 'charged', funding_manual_credit_id: result.entitlement_id,
    billing_debit_id: charged.credits[0].id, penalty_id: null });
  for (const [table, body] of [['session_credit_movements', { manual_credit_id: null }],
    ['session_operation_receipts', { result: {} }]] as const) {
    const denied = await http(owner, `/rest/v1/${table}?session_id=eq.${s.id}`, 'PATCH', body);
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe('42501');
  }
  sessionReceipt(finalResult, finalArgs, 'attendance', charged);
  expect(finalResult.credit_movements).toEqual(charged.credits);
  expect(await rpc(owner, 'save_session_attendance', finalArgs)).toEqual({ ...finalResult, replayed: true });
  await page.reload();
  await page.goto(`/calendar?date=${manifest.today}&sessionId=${s.id}&attendance=1`);
  await expect(dialog).toBeVisible();
  await expect(target).toHaveAttribute('data-billing-state', 'charged');
  expect(await snapshot(key)).toEqual(charged);
  await openProfile(page, key);
  await expect(panel(page, key).getByTestId('manual-credit-ledger')).toContainText('1 restantes / 2 aprobadas');
  await expect(panel(page, key).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 0');
});

test('original pending Gift Card: confirm that exact card, then owner UI settles only its immutable source with one audited debit', async ({ page }) => {
  const key = 'giftSettlement';
  const { s, pending } = await incident(key, true);
  const proposed = settleArgs(pending);
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'settle_student_penalty', proposed, '42501');
  await reject(owner, 'settle_student_penalty', proposed);
  expect(await snapshot(key)).toEqual(pending);
  const usable = await makeGiftUsable(key);
  await loginBrowser(page);
  await openProfile(page, key);
  const target = penaltyRow(page, key, proposed.p_penalty_id);
  await expect(target).toHaveAttribute('data-penalty-state', 'pending');
  await expect(target.getByTestId('penalty-original-source')).toContainText(manifest.subjects[key].cardId!);
  await expect(target.getByRole('button', { name: 'Aplicar descuento pendiente', exact: true })).toBeDisabled();
  await target.getByLabel(`Motivo de resoluci\u00f3n ${proposed.p_penalty_id}`, { exact: true }).fill(proposed.p_reason);
  const responsePromise = uiResponse(page, 'settle_student_penalty', manifest.subjects[key].studentId, proposed.p_penalty_id);
  await target.getByRole('button', { name: 'Aplicar descuento pendiente', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const args = response.request().postDataJSON();
  expect(args).toEqual({ ...proposed, p_request_key: expect.stringMatching(uuid) });
  const result = await response.json();
  const charged = await snapshot(key);
  settledGift(key, usable, charged, args, result);
  expect(await rpc(owner, 'settle_student_penalty', args)).toEqual({ ...result, replayed: true });
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'settle_student_penalty', args, '42501');
  await reject(owner, 'settle_student_penalty', { ...args, p_reason: 'Same key different settlement' });
  await reject(owner, 'settle_student_penalty', { ...args, p_request_key: randomUUID(), p_expected_revision: 3 });
  for (const actor of [foreign, integration]) {
    for (const table of ['student_penalty_settlements', 'session_pending_penalties', 'session_business_state', ...historyTables,
      'session_students', 'session_operation_receipts']) {
      expect(await rows(actor, table, `session_id=eq.${s.id}`, '')).toEqual([]);
    }
  }
  const denied = await http(owner, `/rest/v1/student_penalty_settlements?penalty_id=eq.${args.p_penalty_id}`,
    'PATCH', { debit_id: randomUUID() });
  expect(denied.status).toBe(403);
  expect(denied.data.code).toBe('42501');
  expect(await snapshot(key)).toEqual(charged);
  await openProfile(page, key);
  await expect(penaltyRow(page, key, args.p_penalty_id)).toHaveAttribute('data-penalty-state', 'charged');
  const waiverArgs = waiveArgs(s, charged);
  const waiverResult = await rpc(owner, 'waive_session_penalty', waiverArgs);
  const waived = await snapshot(key);
  rawUnchanged(key, waived);
  expect(waived.penalties).toEqual(charged.penalties);
  expect(waived.settlements).toEqual(charged.settlements);
  expect(waived.cards).toEqual(usable.cards);
  expect(waived.roster).toEqual(charged.roster);
  expect(waived.credits).toEqual([charged.credits[0], expect.objectContaining({ id: expect.stringMatching(uuid),
    session_id: s.id, student_id: manifest.subjects[key].studentId, sede_id: ownSede, revision: 4,
    delta: 1, reverses_id: charged.credits[0].id, gift_card_id: manifest.subjects[key].cardId,
    manual_credit_id: null, period_id: null, adjustment_id: null, disposition: 'gift_card', created_by: owner.id })]);
  expect(waived.gifts).toEqual([charged.gifts[0], expect.objectContaining({ id: expect.stringMatching(uuid),
    gift_card_id: manifest.subjects[key].cardId, session_id: s.id, student_id: manifest.subjects[key].studentId,
    movement_type: 'reverse', sessions_delta: -1, reverses_movement_id: charged.gifts[0].id })]);
  expect(waived.giftReceipts).toEqual(expect.arrayContaining([charged.giftReceipts[0], expect.objectContaining({
    request_key: expect.stringMatching(uuid), gift_card_id: manifest.subjects[key].cardId, session_id: s.id,
    student_id: manifest.subjects[key].studentId, operation: 'reverse', created_by: owner.id,
    card_snapshot: usable.cards.find((card: Row) => card.id === manifest.subjects[key].cardId) })]));
  expect(waived.giftReceipts).toHaveLength(2);
  expect(waived.waivers).toEqual([expect.objectContaining({ penalty_id: charged.penalties[0].id,
    reversal_id: waived.credits[1].id, reason: waiverArgs.p_reason, waived_by: owner.id, revision: 4 })]);
  expect(waived.state[0]).toMatchObject({ billing_state: 'waived', penalty_state: 'waived', billing_debit_id: null,
    settlement_id: result.settlement_id, settlement_debit_id: charged.credits[0].id });
  sessionReceipt(waiverResult, waiverArgs, 'waive_session_penalty', waived);
  expect(await rpc(owner, 'waive_session_penalty', waiverArgs)).toEqual({ ...waiverResult, replayed: true });
  expect(await rpc(owner, 'settle_student_penalty', args)).toEqual({ ...result, replayed: true });
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'waive_session_penalty', waiverArgs, '42501');
  expect(await snapshot(key), 'Settlement receipt replay after waiver must not re-debit the original or any alternative source').toEqual(waived);
});

for (const key of ['blockedSuccessor', 'missingSource']) test(`${key}: successor/available gifts/new manual credit cannot replace a pending original; only owner waiver resolves it`, async ({ page }) => {
  const { s, pending } = await incident(key);
  const manualArgs = approvalArgs(key);
  const manualResult = await rpc(owner, 'approve_student_manual_credit', manualArgs);
  const blocked = await snapshot(key);
  approved(key, blocked, manualArgs, manualResult);
  expect(blocked.penalties).toEqual(pending.penalties);
  expect(blocked.incidents[0]).toMatchObject({ is_pending: true, original_manual_credit_id: null,
    original_gift_card_id: null, original_period_id: manifest.subjects[key].periodId || null });
  if (key === 'blockedSuccessor') {
    expect(blocked.periods).toContainEqual(expect.objectContaining({ id: manifest.subjects[key].successorId,
      predecessor_id: manifest.subjects[key].periodId, payment_status: 'paid', allocated_classes: 8, activated_at: null, outgoing_snapshot: null }));
  }
  const settlement = settleArgs(blocked);
  await reject(owner, 'settle_student_penalty', settlement);
  const forged = await http(owner, '/rest/v1/rpc/settle_student_penalty', 'POST', { ...settlement, p_manual_credit_id: manualResult.entitlement_id });
  expect(forged.status).toBe(404);
  expect(forged.data.code).toBe('PGRST202');
  const rebind = { p_session_id: s.id, p_request_key: randomUUID(), p_expected_revision: 2, p_sede_id: ownSede,
    p_metadata: s.metadata, p_student_ids: [manifest.subjects[key].studentId], p_gift_card_ids: {},
    p_manual_credit_ids: { [manifest.subjects[key].studentId]: manualResult.entitlement_id } };
  await reject(owner, 'save_session_reservation', rebind);
  expect(await snapshot(key)).toEqual(blocked);
  const proposed = waiveArgs(s, blocked);
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'waive_session_penalty', proposed, '42501');
  await loginBrowser(page);
  await openProfile(page, key);
  const target = penaltyRow(page, key, blocked.penalties[0].id);
  await target.getByLabel(`Motivo de resoluci\u00f3n ${blocked.penalties[0].id}`, { exact: true }).fill(proposed.p_reason);
  await expect(target.getByRole('button', { name: 'Aplicar descuento pendiente', exact: true })).toBeDisabled();
  const responsePromise = uiResponse(page, 'waive_session_penalty', manifest.subjects[key].studentId);
  await target.getByRole('button', { name: 'Eximir incidencia', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const args = response.request().postDataJSON();
  expect(args).toEqual({ ...proposed, p_request_key: expect.stringMatching(uuid) });
  const result = await response.json();
  const waived = await snapshot(key);
  approved(key, waived, manualArgs, manualResult);
  expect(waived.cards).toEqual(blocked.cards);
  expect(waived.penalties).toEqual(blocked.penalties);
  expect(waived.credits).toEqual([]);
  expect(waived.gifts).toEqual([]);
  expect(waived.settlements).toEqual([]);
  expect(waived.waivers).toEqual([expect.objectContaining({ penalty_id: blocked.penalties[0].id, reversal_id: null,
    waived_by: owner.id, reason: args.p_reason, revision: 3 })]);
  expect(waived.incidents[0]).toMatchObject({ is_pending: false, is_waived: true, penalty_state: 'waived', settlement_id: null });
  sessionReceipt(result, args, 'waive_session_penalty', waived);
  expect(await rpc(owner, 'waive_session_penalty', args)).toEqual({ ...result, replayed: true });
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, 'waive_session_penalty', args, '42501');
  expect(await snapshot(key)).toEqual(waived);
  await openProfile(page, key);
  await expect(penaltyRow(page, key, blocked.penalties[0].id)).toHaveAttribute('data-penalty-state', 'waived');
});

async function retainedIntent(page: Page, requestKey: string) {
  return page.evaluate(key => [sessionStorage, localStorage].flatMap((storage, index) => Object.keys(storage)
    .flatMap(name => { const value = storage.getItem(name); return value?.includes(key) ? [{ storage: index, name, value }] : []; })), requestKey);
}

for (const [key, operation, name, button] of [
  ['approvalRecovery', 'approve_manual', 'approve_student_manual_credit', 'Aprobar cr\u00e9dito manual'],
  ['settlementRecovery', 'settle_penalty', 'settle_student_penalty', 'Aplicar descuento pendiente'],
  ['waiverRecovery', 'waive_penalty', 'waive_session_penalty', 'Eximir incidencia']
] as const) test(`real ${operation}: lose delivery AFTER actual commit, full page reload, exact same-key/body retry creates no duplicate`, async ({ page, context }) => {
  let s: Session | undefined;
  let baseline: Row;
  if (operation !== 'approve_manual') {
    ({ s } = await incident(key, true));
    baseline = await makeGiftUsable(key);
  } else baseline = await snapshot(key);
  await loginBrowser(page);
  const proposal = operation === 'approve_manual' ? approvalArgs(key, 'reconcile_legacy', 3)
    : operation === 'settle_penalty' ? settleArgs(baseline) : waiveArgs(s!, baseline);
  await openProfile(page, key);
  const bodies: string[] = [];
  let committed: Row | undefined;
  await context.route(`${apiUrl}/rest/v1/rpc/${name}`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postData() || '';
    const args = JSON.parse(body);
    if (name === 'settle_student_penalty' ? args.p_penalty_id !== baseline.penalties[0].id
      : args.p_student_id !== manifest.subjects[key].studentId) return route.fallback();
    bodies.push(body);
    if (bodies.length > 1) return route.fallback();
    const headers = route.request().headers();
    if (headers.apikey !== anonKey || jwtRole(headers.authorization?.replace(/^Bearer /i, '') || '') !== 'authenticated') {
      return route.abort('blockedbyclient');
    }
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
      if (response.status() === 200) committed = await response.json();
      await response.dispose();
    } catch { /* Independent state/receipt assertions below must prove commit. */ }
    await route.abort('failed');
  });
  const target = operation === 'approve_manual' ? panel(page, key) : penaltyRow(page, key, baseline.penalties[0].id);
  if (operation === 'approve_manual') await fillApproval(page, key, proposal);
  else await target.getByLabel(`Motivo de resoluci\u00f3n ${baseline.penalties[0].id}`, { exact: true }).fill(proposal.p_reason);
  await target.getByRole('button', { name: button, exact: true }).click();
  const container = panel(page, key);
  await expect(container.getByRole('alert')).toContainText('Resultado sin confirmar');
  expect(bodies).toHaveLength(1);
  const args = JSON.parse(bodies[0]);
  expect(args).toEqual({ ...proposal, p_request_key: expect.stringMatching(uuid) });
  expect(committed).toBeDefined();
  const afterCommit = await snapshot(key);
  if (operation === 'approve_manual') {
    approvalReceipt(committed!, args);
    approved(key, afterCommit, args, committed!);
    expect(afterCommit.entitlements).toHaveLength(1);
    expect(afterCommit.credits).toEqual([]);
  } else if (operation === 'settle_penalty') settledGift(key, baseline, afterCommit, args, committed!);
  else {
    rawUnchanged(key, afterCommit);
    expect(afterCommit.penalties).toEqual(baseline.penalties);
    expect(afterCommit.settlements).toEqual([]);
    expect(afterCommit.credits).toEqual([]);
    expect(afterCommit.gifts).toEqual([]);
    expect(afterCommit.cards).toEqual(baseline.cards);
    expect(afterCommit.waivers).toEqual([expect.objectContaining({ penalty_id: baseline.penalties[0].id,
      reversal_id: null, reason: args.p_reason, waived_by: owner.id })]);
    expect(afterCommit.giftReceipts).toEqual([]);
    expect(afterCommit.state[0]).toMatchObject({ billing_state: 'waived', penalty_state: 'waived',
      settlement_id: null, waiver_reason: args.p_reason, waived_by: owner.id });
    expect(afterCommit.incidents[0]).toMatchObject({ original_penalty_state: 'pending', is_pending: false, is_waived: true });
    expect(afterCommit.events.filter((event: Row) => event.event === 'penalty_waived')).toHaveLength(1);
    sessionReceipt(committed!, args, name, afterCommit);
  }
  const retained = await retainedIntent(page, args.p_request_key);
  expect(retained).toHaveLength(1);
  expect(retained[0].value).toContain(args.p_reason);
  await page.reload();
  expect(await snapshot(key), 'Reload itself cannot regenerate or execute a pending write').toEqual(afterCommit);
  // The selected permalink also supports pages which consume the query after
  // opening the profile. Reopening may read, but must never submit the intent.
  if (new URL(page.url()).searchParams.get('selected') !== manifest.subjects[key].studentId) await openProfile(page, key);
  await expect(container).toBeVisible();
  const descriptor = container.getByTestId('pending-student-credit-operation');
  await expect(descriptor).toHaveAttribute('data-operation', operation);
  await expect(descriptor).toContainText(args.p_reason);
  expect(await retainedIntent(page, args.p_request_key)).toEqual(retained);
  expect(bodies).toHaveLength(1);
  expect(await snapshot(key), 'Full reload must not execute or regenerate the original pending write').toEqual(afterCommit);
  const responsePromise = uiResponse(page, name, manifest.subjects[key].studentId, baseline.penalties[0]?.id);
  await container.getByRole('button', { name: 'Reintentar operaci\u00f3n pendiente', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ...committed, replayed: true });
  await expect(descriptor).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  await expect.poll(() => retainedIntent(page, args.p_request_key)).toEqual([]);
  for (const actor of [employee, foreign, integration, supervisor]) await reject(actor, name, args, '42501');
  expect(await snapshot(key), 'Replay/denial must preserve actual IDs, raw snapshot, ledger and receipt byte-for-byte').toEqual(afterCommit);
});

for (const rejectedWrite of [false, true]) for (const [operation, name, button, committedKey, rejectedKey] of [
  ['approve_manual', 'approve_student_manual_credit', 'Aprobar cr\u00e9dito manual', 'approvalRefreshRecovery', 'approvalRejectedRefreshRecovery'],
  ['settle_penalty', 'settle_student_penalty', 'Aplicar descuento pendiente', 'settlementRefreshRecovery', 'settlementRejectedRefreshRecovery'],
  ['waive_penalty', 'waive_session_penalty', 'Eximir incidencia', 'waiverRefreshRecovery', 'waiverRejectedRefreshRecovery']
] as const) test(`real ${operation}: ${rejectedWrite ? 'definite SQL rejection' : 'delivered committed receipt'} followed by failed profile refresh retains intent through read-only recovery and full reload`, async ({ page, context }) => {
  const key = rejectedWrite ? rejectedKey : committedKey;
  const studentId = manifest.subjects[key].studentId;
  let s: Session | undefined;
  let baseline: Row;
  if (operation === 'approve_manual') baseline = await snapshot(key);
  else {
    ({ s } = await incident(key, true));
    baseline = await makeGiftUsable(key);
  }
  const proposal = operation === 'approve_manual' ? approvalArgs(key, 'reconcile_legacy', 3)
    : operation === 'settle_penalty' ? settleArgs(baseline) : waiveArgs(s!, baseline);
  await loginBrowser(page);
  await openProfile(page, key);
  const target = operation === 'approve_manual' ? panel(page, key) : penaltyRow(page, key, baseline.penalties[0].id);
  if (operation === 'approve_manual') await fillApproval(page, key, proposal);
  else await target.getByLabel(`Motivo de resoluci\u00f3n ${baseline.penalties[0].id}`, { exact: true }).fill(proposal.p_reason);
  await expect(target.getByRole('button', { name: button, exact: true })).toBeEnabled();

  let competingArgs: Row | undefined;
  let competingResult: Row | undefined;
  if (rejectedWrite) {
    if (operation === 'approve_manual') {
      competingArgs = { ...proposal, p_request_key: randomUUID(), p_reason: `Concurrent reconciliation ${manifest.runId}` };
      competingResult = await rpc(owner, name, competingArgs);
    } else if (operation === 'settle_penalty') {
      competingResult = await rpc(owner, 'cancel_gift_card', { p_gift_card_id: manifest.subjects[key].cardId });
      expect(competingResult).toEqual({ ...baseline.cards.find((card: Row) => card.id === manifest.subjects[key].cardId), status: 'cancelled' });
    } else {
      competingArgs = { ...proposal, p_request_key: randomUUID(), p_reason: `Concurrent owner waiver ${manifest.runId}` };
      competingResult = await rpc(owner, name, competingArgs);
    }
    // Another real Auth client changed the server, not the still-open form.
    await expect(target.getByRole('button', { name: button, exact: true })).toBeEnabled();
  }
  const serverBeforeSubmit = await snapshot(key);
  if (!rejectedWrite) expect(serverBeforeSubmit).toEqual(baseline);
  else if (operation === 'approve_manual') {
    approvalReceipt(competingResult!, competingArgs!);
    approved(key, serverBeforeSubmit, competingArgs!, competingResult!);
    expect(serverBeforeSubmit.entitlements).toHaveLength(1);
    expect(serverBeforeSubmit.profiles[0].can_reconcile_legacy).toBe(false);
    expect(serverBeforeSubmit.credits).toEqual([]);
  } else if (operation === 'settle_penalty') {
    rawUnchanged(key, serverBeforeSubmit);
    expect(serverBeforeSubmit.sessions).toEqual(baseline.sessions);
    expect(serverBeforeSubmit.penalties).toEqual(baseline.penalties);
    expect(serverBeforeSubmit.roster).toEqual(baseline.roster);
    expect(serverBeforeSubmit.receipts).toEqual(baseline.receipts);
    expect(serverBeforeSubmit.credits).toEqual([]);
    expect(serverBeforeSubmit.settlements).toEqual([]);
    expect(serverBeforeSubmit.giftReceipts).toEqual([]);
    expect(serverBeforeSubmit.gifts).toEqual([expect.objectContaining({ id: expect.stringMatching(uuid),
      gift_card_id: manifest.subjects[key].cardId, sede_id: ownSede, student_id: null, session_id: null,
      movement_type: 'cancel', sessions_delta: 0 })]);
    expect(serverBeforeSubmit.cards.find((card: Row) => card.id === manifest.subjects[key].alternativeCardId))
      .toEqual(baseline.cards.find((card: Row) => card.id === manifest.subjects[key].alternativeCardId));
    expect(serverBeforeSubmit.incidents[0]).toMatchObject({ is_pending: true, expected_revision: proposal.p_expected_revision });
  } else {
    waivedPendingGift(key, baseline, serverBeforeSubmit, competingArgs!, competingResult!);
    expect(serverBeforeSubmit.sessions[0].revision).toBe(proposal.p_expected_revision + 1);
  }

  const writes: { method: string; path: string; body: string }[] = [];
  let failProfileReads = false;
  let failedProfileReads = 0;
  let allowRetry = false;
  await context.route(`${apiUrl}/rest/v1/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/rest/v1/student_credit_profile' && failProfileReads) {
      failedProfileReads++;
      return route.abort('failed');
    }
    if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method())) return route.fallback();
    writes.push({ method: request.method(), path: url.pathname, body: request.postData() || '' });
    if (request.method() !== 'POST' || url.pathname !== `/rest/v1/rpc/${name}`) return route.abort('blockedbyclient');
    const args = request.postDataJSON();
    if (operation === 'settle_penalty' ? args.p_penalty_id !== baseline.penalties[0].id : args.p_student_id !== studentId) {
      return route.abort('blockedbyclient');
    }
    // Unexpected automatic writes are evidence of failure, not permission to
    // mutate preserved QA. Only the explicit exact-body retry may reach the DB.
    if (writes.length > 1 && (!allowRetry || writes.length !== 2 || writes[1].body !== writes[0].body)) {
      return route.abort('blockedbyclient');
    }
    const headers = request.headers();
    if (headers.apikey !== anonKey || jwtRole(headers.authorization?.replace(/^Bearer /i, '') || '') !== 'authenticated') {
      return route.abort('blockedbyclient');
    }
    // Deliver the unmodified REAL backend response. Only its subsequent
    // authoritative profile GET fails, never the write or receipt delivery.
    const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
    try {
      if (writes.length === 1) failProfileReads = true;
      await route.fulfill({ response });
    } finally { await response.dispose(); }
  });
  const rejectionCode = operation === 'waive_penalty' ? '40001' : 'P0001';
  const responsePromise = uiResponse(page, name, studentId, baseline.penalties[0]?.id);
  await target.getByRole('button', { name: button, exact: true }).click();
  const response = await responsePromise;
  if (rejectedWrite) {
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(600);
  } else expect(response.status()).toBe(200);
  const args = response.request().postDataJSON();
  expect(args).toEqual({ ...proposal, p_request_key: expect.stringMatching(uuid) });
  const delivered = await response.json();
  if (rejectedWrite) {
    expect(delivered.code).toBe(rejectionCode);
    expect(delivered.message).toContain(operation === 'approve_manual' ? 'Legacy balance is already reconciled'
      : operation === 'settle_penalty' ? 'Original incident source is not usable' : 'Stale session revision');
  }
  const reloadButton = page.getByRole('button', { name: 'Recargar datos sin repetir escrituras', exact: true });
  await expect(page.getByRole('alert').filter({ has: reloadButton })).toContainText('No se pudieron cargar los datos.');
  await expect(panel(page, key)).toHaveCount(0);
  expect(failedProfileReads).toBeGreaterThan(0);
  expect(writes).toEqual([{ method: 'POST', path: `/rest/v1/rpc/${name}`, body: response.request().postData()! }]);

  const afterWrite = await snapshot(key);
  if (rejectedWrite) {
    expect(afterWrite, 'The definite SQL rejection must roll back every UI write despite the failed read refresh').toEqual(serverBeforeSubmit);
    expect(afterWrite.entitlements.filter((row: Row) => row.request_key === args.p_request_key)).toEqual([]);
    expect(afterWrite.receipts.filter((row: Row) => row.request_key === args.p_request_key)).toEqual([]);
  } else if (operation === 'approve_manual') {
    approvalReceipt(delivered, args);
    approved(key, afterWrite, args, delivered);
    expect(afterWrite.entitlements).toHaveLength(1);
    expect(afterWrite.credits).toEqual([]);
    expect(afterWrite.profiles[0].can_reconcile_legacy).toBe(false);
  } else if (operation === 'settle_penalty') settledGift(key, baseline, afterWrite, args, delivered);
  else waivedPendingGift(key, baseline, afterWrite, args, delivered);
  const retained = await retainedIntent(page, args.p_request_key);
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ storage: 0, name: `student-credit-intent:${JSON.stringify([owner.id, studentId])}` });
  expect(JSON.parse(retained[0].value)).toEqual({ actorId: owner.id, operation, args,
    descriptor: { operation, studentId, requestKey: args.p_request_key, reason: args.p_reason,
      ...(operation === 'approve_manual' ? {} : { penaltyId: baseline.penalties[0].id, sessionId: s!.id }) } });
  if (operation !== 'approve_manual') expect(args.p_expected_revision).toBe(baseline.sessions[0].revision);

  failProfileReads = false;
  const readable = page.waitForResponse(result => {
    const url = new URL(result.url());
    return url.origin === apiUrl && url.pathname === '/rest/v1/student_credit_profile'
      && result.request().method() === 'GET' && result.status() >= 200 && result.status() < 300;
  });
  await reloadButton.click();
  await readable;
  await expect(reloadButton).toHaveCount(0);
  // Waiting for the real student row proves the entire paginated DataProvider
  // refresh completed, not just its first profile page or loadError clearing.
  await page.getByLabel('Buscar alumno por nombre o apellidos', { exact: true }).fill(studentId);
  await expect(page.locator(`button[data-student-id="${studentId}"]`)).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(await retainedIntent(page, args.p_request_key)).toEqual(retained);
  expect(await snapshot(key), 'Read-only recovery must not replay, replace or clear the original write intent').toEqual(afterWrite);
  await openProfile(page, key);
  const descriptor = panel(page, key).getByTestId('pending-student-credit-operation');
  await expect(descriptor).toHaveAttribute('data-operation', operation);
  await expect(descriptor).toContainText(args.p_reason);
  if (operation === 'approve_manual') {
    await expect(panel(page, key).getByLabel('Modo del cr\u00e9dito manual').locator('option[value="reconcile_legacy"]')).toHaveJSProperty('disabled', true);
    await expect(panel(page, key).getByTestId('manual-credit-ledger')).toContainText(afterWrite.entitlements[0].id);
  } else {
    await expect(descriptor).toContainText(baseline.penalties[0].id);
    await expect(descriptor).toContainText(s!.id);
    await expect(penaltyRow(page, key, baseline.penalties[0].id)).toHaveAttribute('data-penalty-state', afterWrite.incidents[0].penalty_state);
    if (operation === 'settle_penalty' && !rejectedWrite) {
      await expect(penaltyRow(page, key, baseline.penalties[0].id).getByTestId('penalty-settlement-audit'))
        .toContainText(delivered.settlement_id);
    }
  }
  expect(await retainedIntent(page, args.p_request_key)).toEqual(retained);
  expect(writes).toHaveLength(1);

  await page.reload();
  if (new URL(page.url()).searchParams.get('selected') !== studentId) await openProfile(page, key);
  await expect(descriptor).toHaveAttribute('data-operation', operation);
  await expect(descriptor).toContainText(args.p_reason);
  expect(await retainedIntent(page, args.p_request_key)).toEqual(retained);
  expect(writes).toHaveLength(1);
  expect(await snapshot(key), 'A full reload must retain original revision/arguments and remain strictly read-only').toEqual(afterWrite);
  const failedReadsBeforeRetry = failedProfileReads;
  const replayPromise = uiResponse(page, name, studentId, baseline.penalties[0]?.id);
  allowRetry = true;
  await panel(page, key).getByRole('button', { name: 'Reintentar operaci\u00f3n pendiente', exact: true }).click();
  const replay = await replayPromise;
  expect(replay.status()).toBe(response.status());
  const replayData = await replay.json();
  if (rejectedWrite) {
    expect(replayData.code).toBe(rejectionCode);
    expect(replayData.message).toBe(delivered.message);
    await expect(panel(page, key).getByRole('alert')).toContainText('Revisa los datos recargados');
  } else expect(replayData).toEqual({ ...delivered, replayed: true });
  await expect(descriptor).toHaveCount(0);
  await expect.poll(() => retainedIntent(page, args.p_request_key)).toEqual([]);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(failedProfileReads).toBe(failedReadsBeforeRetry);
  await expect(reloadButton).toHaveCount(0);
  expect(await snapshot(key), 'Exact retry and successful authoritative refresh must not duplicate any receipt, debit, waiver or actual ID').toEqual(afterWrite);
});
