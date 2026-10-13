import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

let server: ViteDevServer;
let origin: string;
type Gate = { promise: Promise<void>; release: () => void };
const gate = (): Gate => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const clone = <T,>(value: T): T => structuredClone(value);
const rawStudent = (id: string, category = 'temporal') => ({ id, sede_id: 'sede-a', name: 'Alex', phone: '111',
  student_category: category, classes_remaining: 2, payment_status: category === 'membresia' ? 'paid' : null,
  current_membership_period_id: category === 'membresia' ? 'period-original' : null, archived_at: null, status: 'new' });
const sessionRow = (id: string, date: string, classType = 'mesa', completed = true) => ({ id, sede_id: 'sede-a', date,
  start_time: '10:00:00', end_time: '12:00:00', class_type: classType, capacity: 6, teacher_id: 'teacher',
  attendance_policy_version: 2, revision: 7, completed_at: completed ? `${date}T12:00:00Z` : null });
const incident = (id: string, session: string, source: 'manual' | 'gift' | 'period', student = 'student-a') => ({
  penalty_id: id, student_id: student, sede_id: 'sede-a', session_id: session, expected_revision: 7, incident_revision: 5,
  kind: 'no_show', penalty_state: 'pending', original_penalty_state: 'pending', billing_state: 'incident',
  original_period_id: source === 'period' ? 'period-original' : null, original_gift_card_id: source === 'gift' ? 'gift-original' : null,
  original_manual_credit_id: source === 'manual' ? 'manual-original' : null, incident_reason: 'Original incident reason',
  is_pending: true, is_waived: false, settlement_id: null, settlement_reason: null, settled_by: null, settled_at: null, settlement_revision: null
});
const business = (session: string, student: string, penalty?: any) => ({ session_id: session, student_id: student, sede_id: 'sede-a',
  policy_version: 2, reservation_state: 'reserved', billing_state: penalty ? 'incident' : 'unfinalized',
  ...(penalty ? { penalty_id: penalty.penalty_id, penalty_state: 'pending', billing_kind: penalty.kind, finalized_revision: 5,
    funding_period_id: penalty.original_period_id, funding_gift_card_id: penalty.original_gift_card_id,
    funding_manual_credit_id: penalty.original_manual_credit_id } : {}) });
const fixture = (): Record<string, any[]> => {
  const students = [rawStudent('student-a'), rawStudent('student-member', 'membresia')];
  const manualIncident = incident('penalty-manual', 'old-manual', 'manual');
  const giftIncident = incident('penalty-gift', 'old-gift', 'gift');
  const periodIncident = incident('penalty-period', 'old-period', 'period', 'student-member');
  const roster = (session: string, student = 'student-a', attendance = 'absent', source?: string) => ({
    id: `${session}:${student}`, session_id: session, sede_id: 'sede-a', student_id: student, student_name: 'Alex', attendance,
    gift_card_id: source === 'gift' ? 'gift-original' : null, manual_credit_id: source === 'manual' ? 'manual-original' : null
  });
  return {
    students, teachers: [{ id: 'teacher', sede_id: 'sede-a', name: 'Ada' }],
    sessions: [sessionRow('recent', '2026-10-12', 'mesa', false), sessionRow('old-manual', '2026-07-04'),
      sessionRow('old-gift', '2026-07-04'), sessionRow('old-period', '2026-07-04'),
      sessionRow('mixed-history', '2026-07-03', 'mixto'), sessionRow('cancelled-history', '2026-07-02')],
    session_students: [roster('recent', 'student-a', 'pending'), roster('old-manual', 'student-a', 'absent', 'manual'),
      roster('old-gift', 'student-a', 'absent', 'gift'), roster('old-period', 'student-member'),
      roster('mixed-history', 'student-a', 'presente'), roster('mixed-history', 'student-member', 'present'),
      roster('cancelled-history', 'student-a', 'present', 'manual')],
    session_activity_blocks: [{ id: 'block-mesa', session_id: 'mixed-history', sede_id: 'sede-a', activity_type: 'mesa', teacher_id: 'teacher', capacity: 4 },
      { id: 'block-torno', session_id: 'mixed-history', sede_id: 'sede-a', activity_type: 'torno', teacher_id: 'teacher', capacity: 2 }],
    session_activity_block_students: [{ block_id: 'block-mesa', session_id: 'mixed-history', student_id: 'student-a', created_at: '2026-07-03T08:00:00Z' },
      { block_id: 'block-torno', session_id: 'mixed-history', student_id: 'student-member', created_at: '2026-07-03T08:00:00Z' }],
    session_operation_receipts: [], gift_card_operation_receipts: [],
    students_effective_membership: [{ student_id: 'student-member', sede_id: 'sede-a', materialized_period_id: 'period-original',
      effective_period_id: 'period-original', membership_tier: 'gold', allocated_classes: 4, classes_remaining: 99,
      payment_status: 'paid', starts_on: '2026-06-01', ends_on: '2026-12-31' }],
    student_membership_periods: [{ id: 'period-original', student_id: 'student-member', sede_id: 'sede-a', allocated_classes: 4,
      starts_on: '2026-06-01', ends_on: '2026-12-31', payment_status: 'paid' },
      { id: 'period-queued', student_id: 'student-member', sede_id: 'sede-a', predecessor_id: 'period-original', allocated_classes: 8,
        starts_on: '2027-01-01', ends_on: '2027-01-31', payment_status: 'pending' }],
    session_business_state: [business('recent', 'student-a'), business('old-manual', 'student-a', manualIncident),
      business('old-gift', 'student-a', giftIncident), business('old-period', 'student-member', periodIncident),
      business('mixed-history', 'student-a'), business('mixed-history', 'student-member'),
      { ...business('cancelled-history', 'student-a'), reservation_state: 'cancelled', cancelled_at: '2026-07-01T12:00:00Z',
        cancellation_kind: 'early', cancellation_reason: 'Original cancellation', funding_manual_credit_id: 'manual-original' }],
    sedes: [{ id: 'sede-a', owner_id: 'owner-a', is_active: true }],
    student_credit_profile: students.map(student => ({ student_id: student.id, sede_id: student.sede_id,
      legacy_observed_balance: student.classes_remaining, legacy_raw_state: clone(student), can_reconcile_legacy: false,
      can_approve_manual_credit: true, manual_credits: student.id === 'student-a' ? [{ entitlement_id: 'manual-original',
        student_id: student.id, sede_id: student.sede_id, mode: 'new_manual', quantity: 4, remaining_classes: 3, activity: 'mesa',
        starts_on: '2026-06-01', ends_on: '2026-12-31', reason: 'Original approval', evidence: 'Original evidence',
        approved_by: 'owner-a', approved_at: '2026-06-01T12:00:00Z' }] : [],
      penalty_incidents: student.id === 'student-a' ? [manualIncident, giftIncident] : [periodIncident] })),
    gift_cards: [{ id: 'gift-original', sede_id: 'sede-a', buyer: 'Buyer', recipient: 'Alex', recipient_student_id: 'student-a',
      num_classes: 4, sessions_used: 1, type: 'modelado', payment_status: 'paid', status: 'active',
      activated_at: '2026-06-01', expiry_date: '2026-12-31', created_at: '2026-06-01T12:00:00Z' }],
    pieces: [], gift_card_movements: [], inventory_items: [], inventory_movements: [],
    workshop_schedules: [], workshop_capacity_defaults: [], workshop_schedule_exceptions: []
  };
};
type Backend = {
  rows: Record<string, any[]>; reads: any[]; rpcs: any[]; mutations: any[]; failures: Map<string, any>; holds: Map<string, Gate>;
  rpcMode: 'success' | 'transport' | 'sql'; failAfterRpc: boolean; external: string[]; errors: string[];
};
const backends = new WeakMap<Page, Backend>();
const snapshot = (page: Page) => page.evaluate(() => window.__integrity.snapshot());
const run = (page: Page, name: string, args: any[] = [], key?: string) =>
  page.evaluate(({ name, args, key }) => window.__integrity.run(name, args, key), { name, args, key });
const configure = (page: Page, value: any) => page.evaluate(value => window.__integrity.configure(value), value);
const ready = (page: Page) => expect.poll(async () => (await snapshot(page)).ready).toBe(true);
const responseCount = async (page: Page, table: string) => (await snapshot(page)).responses.filter((item: any) => item.table === table).length;
const paint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const approval = () => ({ studentId: 'student-a', requestKey: 'credit-request-original', mode: 'new_manual', quantity: 3,
  expectedLegacyBalance: 2, activity: 'mesa', startsOn: '2026-10-12', endsOn: '2026-12-31', reason: 'Explicit approval', evidence: 'Original document' });
const settlement = () => ({ studentId: 'student-a', penaltyId: 'penalty-manual', requestKey: 'settlement-request-original',
  expectedRevision: 7, reason: 'Explicit settlement' });
const attendance = () => ({ attendanceByStudentId: { 'student-a': 'present' }, revision: 7, completedAt: '2026-10-12T12:00:00Z' });
const pendingKey = (kind: string) => kind === 'session' ? 'atomic-session-intent:sede-a:recent' : 'student-credit-intent:["owner-a","student-a"]';

test.beforeAll(async () => {
  const mock = fileURLToPath(new URL('../fixtures/data-provider-integrity-mocks.tsx', import.meta.url));
  server = await createServer({ configFile: false, envDir: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    cacheDir: fileURLToPath(new URL('../../node_modules/.cache/data-provider-integrity-vite', import.meta.url)),
    resolve: { alias: [{ find: /^.*(?:supabaseClient|AuthContext)(?:\.[jt]sx?)?$/, replacement: mock }], dedupe: ['react', 'react-dom'] },
    optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom'] },
    plugins: [react(), { name: 'isolated-data-provider-client',
      resolveId(source) {
        if (/supabase/i.test(source)) return '\0data-provider-forbidden-backend';
      },
      load(id) { if (id === '\0data-provider-forbidden-backend') return "throw new Error('Real backend forbidden in provider integrity harness');"; }
    }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  const backend: Backend = { rows: fixture(), reads: [], rpcs: [], mutations: [], failures: new Map(), holds: new Map(),
    rpcMode: 'success', failAfterRpc: false, external: [], errors: [] };
  backends.set(page, backend);
  page.on('pageerror', error => backend.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    backend.external.push(route.request().url()); return route.abort();
  });
  const receipts = new Map<string, any>();
  await page.route('**/__data-provider-integrity', async route => {
    const request = route.request().postDataJSON();
    const respond = async (response: any) => { await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) }).catch(() => undefined); };
    if (request.table) {
      backend.reads.push(request);
      const label = request.table === 'sessions' && !request.filters.some((filter: any[]) => filter[0] === 'gte') ? 'full-sessions' : request.table;
      const error = backend.failures.get(label) ?? backend.failures.get(request.table);
      let rows = clone(backend.rows[request.table]);
      if (!rows) throw new Error(`Unexpected table ${request.table}`);
      if (request.table === 'session_activity_block_students') {
        const columns = new Set(['block_id', 'session_id', 'student_id', 'created_at']);
        const joined = request.columns === '*,session_activity_blocks!session_activity_block_students_block_id_fkey!inner(sede_id)';
        const invalid = request.filters.find(([, key]: any[]) => !columns.has(key) && !(joined && key === 'session_activity_blocks.sede_id'))
          ?? request.orders.find(([key]: any[]) => !columns.has(key));
        if (invalid) return respond({ data: null, error: { code: '42703', message: `Column ${invalid[0] === 'eq' ? invalid[1] : invalid[0]} does not exist on activity roster` }, count: null });
        if (request.columns !== '*' && !joined) return respond({ data: null, error: { code: 'PGRST201', message: 'Explicit parent FK join required' }, count: null });
        if (rows.some(row => Object.keys(row).some(key => !columns.has(key)))) throw new Error('Activity roster fixture invented a database column');
        if (joined) rows = rows.flatMap(row => {
          const parent = backend.rows.session_activity_blocks.find(block => block.id === row.block_id);
          return parent ? [{ ...row, session_activity_blocks: { sede_id: parent.sede_id } }] : [];
        });
      }
      for (const [op, key, value] of request.filters) rows = rows.filter(row => {
        const field = key === 'session_activity_blocks.sede_id' ? row.session_activity_blocks?.sede_id : row[key];
        return op === 'eq' ? field === value : op === 'gte' ? field >= value : field <= value;
      });
      for (const [key, ascending] of [...request.orders].reverse()) rows.sort((a, b) => (String(a[key]).localeCompare(String(b[key]))) * (ascending ? 1 : -1));
      const count = rows.length;
      const start = request.start ?? 0;
      // Deliberately cap pages below readAllRows' requested size.
      rows = rows.slice(start, request.limit !== undefined ? start + request.limit : Math.min((request.end ?? count) + 1, start + 2));
      const response = error ? { data: null, error, count: null } : { data: rows, error: null, count };
      await backend.holds.get(label)?.promise;
      return respond(response);
    }
    backend.rpcs.push(clone(request));
    if (backend.failAfterRpc) backend.failures.set('student_credit_profile', { code: '42501', message: 'Financial read denied after RPC' });
    if (backend.rpcMode !== 'success') return respond({ data: null, error: { code: backend.rpcMode === 'sql' ? '40001' : '08006', message: 'Synthetic write rejection' } });
    const args = request.args;
    if (receipts.has(args.p_request_key)) return respond({ data: receipts.get(args.p_request_key), error: null });
    let receipt: any;
    if (request.name === 'approve_student_manual_credit') {
      backend.rows.student_credit_profile[0].manual_credits.push({ entitlement_id: 'new-entitlement', student_id: args.p_student_id,
        sede_id: 'sede-a', mode: args.p_mode, quantity: args.p_quantity, remaining_classes: args.p_quantity, activity: args.p_activity,
        starts_on: args.p_starts_on, ends_on: args.p_ends_on, reason: args.p_reason, evidence: args.p_evidence,
        approved_by: 'owner-a', approved_at: '2026-10-12T08:00:00Z' });
      receipt = { student_id: args.p_student_id, request_key: args.p_request_key, entitlement_id: 'new-entitlement', remaining_classes: args.p_quantity };
    } else if (request.name === 'settle_student_penalty') {
      const penalty = backend.rows.student_credit_profile[0].penalty_incidents.find(item => item.penalty_id === args.p_penalty_id);
      if (penalty.original_gift_card_id && backend.rows.gift_cards.find(card => card.id === penalty.original_gift_card_id)?.payment_status !== 'paid') {
        return respond({ data: null, error: { code: 'P0001', message: 'El bono original no esta pagado' } });
      }
      const session = backend.rows.sessions.find(item => item.id === penalty.session_id);
      const business = backend.rows.session_business_state.find(item => item.session_id === session.id);
      session.revision++;
      const audit = { settlement_id: 'settlement-original', settlement_reason: args.p_reason, settled_by: 'owner-a', settled_at: '2026-10-12T08:00:00Z', settlement_revision: 8 };
      Object.assign(penalty, audit, { expected_revision: 8, penalty_state: 'charged', billing_state: 'charged', is_pending: false });
      Object.assign(business, audit, { penalty_state: 'charged', billing_state: 'charged', settlement_debit_id: 'original-debit' });
      backend.rows.student_credit_profile[0].manual_credits[0].remaining_classes--;
      receipt = { student_id: 'student-a', session_id: session.id, penalty_id: penalty.penalty_id, request_key: args.p_request_key, revision: 8, settlement_id: 'settlement-original' };
    } else if (request.name === 'save_session_attendance') {
      const session = backend.rows.sessions.find(item => item.id === args.p_session_id);
      session.revision++;
      if (args.p_finalize) session.completed_at = '2026-10-12T12:00:00Z';
      for (const item of args.p_attendance) backend.rows.session_students.find(row => row.session_id === session.id && row.student_id === item.student_id).attendance = item.status;
      receipt = { session_id: session.id, request_key: args.p_request_key, revision: session.revision };
    } else throw new Error(`Unexpected RPC ${request.name}`);
    receipts.set(args.p_request_key, receipt); backend.mutations.push(clone(request));
    return respond({ data: receipt, error: null });
  });
  await page.route('**/data-provider-integrity-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><head><style>body{font:14px system-ui}svg{width:20px;height:20px}button{min-height:36px}.hidden{display:none}.fixed{position:fixed;inset:0;background:white;overflow:auto;z-index:100}.absolute{position:absolute}.relative{position:relative}</style></head>
    <body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/data-provider-integrity-harness.tsx');
    </script></body></html>` }));
});
test.afterEach(async ({ page }) => {
  const backend = backends.get(page)!;
  for (const held of backend.holds.values()) held.release();
  expect(backend.external).toEqual([]); expect(backend.errors).toEqual([]);
});
const open = async (page: Page) => { await page.goto(`${origin}/data-provider-integrity-test`); await expect(page.getByTestId('calendar')).toBeVisible(); };

for (const admin of [false, true]) test(`${admin ? 'superadmin' : 'owner'} loads an empty activity roster using real composite columns and the parent tenant contract`, async ({ page }) => {
  const backend = backends.get(page)!;
  backend.rows.session_activity_blocks = []; backend.rows.session_activity_block_students = [];
  await open(page); await ready(page);
  if (admin) {
    await configure(page, { admin });
    await expect.poll(() => backend.reads.filter(read => read.table === 'session_activity_block_students').at(-1)?.filters).toEqual([]);
    await ready(page);
  }
  const query = backend.reads.filter(read => read.table === 'session_activity_block_students').at(-1)!;
  expect(query.columns).toBe('*,session_activity_blocks!session_activity_block_students_block_id_fkey!inner(sede_id)');
  expect(query.orders).toEqual([['block_id', true], ['student_id', true]]);
  expect(query.filters).toEqual(admin ? [] : [['eq', 'session_activity_blocks.sede_id', 'sede-a']]);
  expect((await snapshot(page))).toMatchObject({ ready: true, error: null });
  expect((await snapshot(page)).sessions.every((session: any) => session.activityBlocks.length === 0)).toBe(true);
  expect(backend.rpcs).toEqual([]);
});

test('activity roster schema rejects missing filter and order columns even when there are no rows', async ({ page }) => {
  const backend = backends.get(page)!;
  backend.rows.session_activity_blocks = []; backend.rows.session_activity_block_students = [];
  await open(page); await ready(page);
  for (const column of ['id', 'sede_id']) for (const operation of ['filter', 'order'] as const) {
    const result = await page.evaluate(({ column, operation }) => window.__integrity.probeRosterColumn(column, operation), { column, operation });
    expect(result).toMatchObject({ data: null, error: { code: '42703' } });
  }
  expect((await snapshot(page))).toMatchObject({ ready: true, error: null });
  expect(backend.rpcs).toEqual([]);
});

for (const view of ['owner', 'superadmin', 'other-sede']) test(`${view} activity roster joins preserve only the intended parent-scoped student IDs across pagination`, async ({ page }) => {
  const backend = backends.get(page)!;
  const student = { ...rawStudent('student-b'), sede_id: 'sede-b' };
  backend.rows.students.push(student);
  backend.rows.student_credit_profile.push({ student_id: student.id, sede_id: student.sede_id, legacy_observed_balance: 2,
    legacy_raw_state: clone(student), can_reconcile_legacy: false, can_approve_manual_credit: false, manual_credits: [], penalty_incidents: [] });
  backend.rows.teachers.push({ id: 'teacher-b', sede_id: 'sede-b', name: 'Bea' });
  backend.rows.sessions.push({ ...sessionRow('mixed-other-sede', '2026-10-12', 'mixto', false), sede_id: 'sede-b', teacher_id: null });
  backend.rows.session_students.push({ id: 'mixed-other-sede:student-b', session_id: 'mixed-other-sede', sede_id: 'sede-b',
    student_id: 'student-b', student_name: 'Alex', attendance: 'pending', gift_card_id: null, manual_credit_id: null });
  backend.rows.session_business_state.push({ ...business('mixed-other-sede', 'student-b'), sede_id: 'sede-b' });
  backend.rows.session_activity_blocks.push({ id: 'block-other-mesa', session_id: 'mixed-other-sede', sede_id: 'sede-b',
    activity_type: 'mesa', teacher_id: 'teacher-b', capacity: 4 }, { id: 'block-other-torno', session_id: 'mixed-other-sede', sede_id: 'sede-b',
    activity_type: 'torno', teacher_id: 'teacher-b', capacity: 2 });
  backend.rows.session_activity_block_students.push({ block_id: 'block-other-mesa', session_id: 'mixed-other-sede',
    student_id: 'student-b', created_at: '2026-10-12T08:00:00Z' });
  await open(page); await ready(page);
  const start = backend.reads.length;
  if (view !== 'owner') {
    await configure(page, view === 'superadmin' ? { admin: true } : { sede: 'sede-b' });
    await expect.poll(async () => (await snapshot(page)).sessions.some((session: any) => session.id === 'mixed-other-sede')).toBe(true);
    await ready(page);
  }
  const state = await snapshot(page);
  const blocks = state.sessions.flatMap((session: any) => session.activityBlocks);
  expect(blocks.flatMap((block: any) => block.studentIds).sort()).toEqual(view === 'superadmin'
    ? ['student-a', 'student-b', 'student-member'] : view === 'owner' ? ['student-a', 'student-member'] : ['student-b']);
  if (view !== 'other-sede') expect(state.sessions.find((session: any) => session.id === 'mixed-history').activityBlocks)
    .toEqual([{ id: 'block-mesa', activityType: 'mesa', teacherId: 'teacher', capacity: 4, studentIds: ['student-a'] },
      { id: 'block-torno', activityType: 'torno', teacherId: 'teacher', capacity: 2, studentIds: ['student-member'] }]);
  if (view !== 'owner') expect(state.sessions.find((session: any) => session.id === 'mixed-other-sede').activityBlocks)
    .toEqual([{ id: 'block-other-mesa', activityType: 'mesa', teacherId: 'teacher-b', capacity: 4, studentIds: ['student-b'] },
      { id: 'block-other-torno', activityType: 'torno', teacherId: 'teacher-b', capacity: 2, studentIds: [] }]);
  const queries = backend.reads.slice(view === 'owner' ? 0 : start).filter(read => read.table === 'session_activity_block_students');
  expect(queries.every(query => JSON.stringify(query.orders) === JSON.stringify([['block_id', true], ['student_id', true]]))).toBe(true);
  expect(queries.every(query => JSON.stringify(query.filters) === JSON.stringify(view === 'superadmin' ? []
    : [['eq', 'session_activity_blocks.sede_id', view === 'other-sede' ? 'sede-b' : 'sede-a']]))).toBe(true);
  if (view === 'superadmin') expect(queries.map(query => query.start)).toEqual([0, 2]);
  expect(state).toMatchObject({ ready: true, error: null }); expect(backend.rpcs).toEqual([]);
});

test('activity roster parent/session mismatch rejects refresh visibly rather than dropping a child row', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page);
  backend.rows.session_activity_block_students[0].session_id = 'recent';
  expect(await run(page, 'loadAllData')).toMatchObject({ ok: false, error: expect.stringContaining('roster de actividades') });
  expect(await snapshot(page)).toMatchObject({ ready: false, error: expect.any(String) });
  expect(backend.rpcs).toEqual([]);
});

test('bounded calendar paints before held financial and inventory reads; financial pages and all writes stay gated', async ({ page }) => {
  const backend = backends.get(page)!;
  const financial = gate(); backend.holds.set('student_credit_profile', financial);
  backend.holds.set('inventory_items', gate());
  await open(page);
  await expect(page.locator('[data-session-id="recent"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Abrir control de asistencia' })).toBeDisabled();
  await expect(page.getByTestId('students')).toContainText('Cargando datos');
  expect((await snapshot(page))).toMatchObject({ loading: false, ready: false, owner: false });
  await page.locator('[data-session-id="recent"]').dispatchEvent('click');
  await expect(page.getByRole('button', { name: 'Crear sesión', exact: true })).toHaveCount(0);
  for (const [name, args] of [
    ['renewStudent', [{ studentId: 'student-member', membershipTier: 'gold', allocatedClasses: 4, requestKey: 'blocked-renewal' }]],
    ['activateMembership', ['student-member']], ['confirmMembershipPayment', ['student-member', 'period-original']],
    ['initializeLegacyMemberships', []], ['approveStudentManualCredit', [approval()]], ['settlePendingStudentPenalty', [settlement()]],
    ['waiveStudentPenalty', [{ operation: 'waive_penalty', studentId: 'student-a', sessionId: 'old-manual' }]],
    ['approveSessionException', [{ operation: 'approve_exception', studentId: 'student-a', sessionId: 'recent' }]],
    ['cancelSessionReservation', [{ operation: 'cancel_reservation', studentId: 'student-a', sessionId: 'recent' }]],
    ['waiveSessionPenalty', [{ operation: 'waive_penalty', studentId: 'student-a', sessionId: 'old-manual' }]],
    ['addSession', [{}]], ['updateSession', ['recent', attendance()]], ['retryPendingSessionOperation', ['recent']],
    ['retryPendingStudentCreditOperation', ['student-a']], ['confirmGiftCardPayment', ['gift-original']]
  ] as Array<[string, any[]]>) {
    expect(await run(page, name, args)).toMatchObject({ ok: false, error: expect.stringContaining('datos de negocio') });
  }
  expect(backend.rpcs).toEqual([]); expect((await snapshot(page)).storage).toEqual({});
  financial.release(); await ready(page);
  await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeEnabled();
  expect((await snapshot(page)).inventory).toEqual([]);
});

test('full paginated history hydrates 100-day-old incidents with the exact usable original manual, gift and period rights', async ({ page }) => {
  await open(page); await ready(page);
  const state = await snapshot(page);
  expect(state.sessions).toHaveLength(6); expect(state.owner).toBe(true); expect(state.creditOwner).toEqual([true, true]);
  const penalties = state.students.flatMap((student: any) => student.pendingPenalties);
  expect(penalties).toHaveLength(3);
  expect(penalties.every((item: any) => item.sessionDate === '2026-07-04' && item.canSettle === true)).toBe(true);
  expect(penalties.map((item: any) => [item.originalManualCreditId, item.originalGiftCardId, item.originalPeriodId]))
    .toEqual([['manual-original', undefined, undefined], [undefined, 'gift-original', undefined], [undefined, undefined, 'period-original']]);
  expect(state.students[1]).toMatchObject({ classesRemaining: 99, legacyManualBalance: 2, effectivePeriodId: 'period-original', materializedPeriodId: 'period-original' });
  expect(backends.get(page)!.reads.filter(read => read.table === 'sessions' && read.filters.some((item: any[]) => item[0] === 'gte'))[0].filters)
    .toEqual([['eq', 'sede_id', 'sede-a'], ['gte', 'date', '2026-08-11'], ['lte', 'date', '2026-12-13']]);
  await page.getByRole('button', { name: 'Mes', exact: true }).click();
  for (let month = 0; month < 3; month++) await page.getByRole('button', { name: 'Mes anterior', exact: true }).click();
  await page.getByRole('button', { name: /4 de julio, 3/ }).click();
  await expect(page.locator('[data-session-id="old-manual"]')).toBeVisible();
  await expect(page.locator('[data-session-id="old-gift"]')).toBeVisible();
});

test('known legacy NULL gift payment loads as unknown without changing raw state or enabling the original gift penalty', async ({ page }) => {
  const backend = backends.get(page)!;
  const legacyId = '40000000-0000-0000-0000-000000000008';
  // Match the preserved NULL-payment case in gift_card_integrity.fixture.psql, scoped to this harness student.
  Object.assign(backend.rows.gift_cards[0], { id: legacyId, buyer: 'fixture buyer', recipient: 'Alex Perez', num_classes: 2,
    sessions_used: 0, validity_months: 3, activated_at: '2020-01-01', expiry_date: '2099-01-01', payment_status: null });
  backend.rows.session_students.find(row => row.session_id === 'old-gift').gift_card_id = legacyId;
  backend.rows.session_business_state.find(row => row.session_id === 'old-gift').funding_gift_card_id = legacyId;
  backend.rows.student_credit_profile[0].penalty_incidents.find(row => row.penalty_id === 'penalty-gift').original_gift_card_id = legacyId;
  const originalRows = clone(backend.rows);
  await open(page); await ready(page);
  const state = await snapshot(page);
  expect(state).toMatchObject({ ready: true, error: null, owner: true });
  expect(state.giftCards).toEqual([{ id: legacyId, sedeId: 'sede-a', code: 'CR-4000000000', buyer: 'fixture buyer',
    recipient: 'Alex Perez', recipientStudentId: 'student-a', numClasses: 2, type: 'modelado', validityMonths: 3,
    activatedAt: '2020-01-01', expiryDate: '2099-01-01', paymentStatus: null, status: 'active', sessionsUsed: 0,
    sessionsRemaining: 2, deliveryFormat: 'digital', createdAt: '2026-06-01T12:00:00Z', movements: [] }]);
  expect(state.sessions.find((session: any) => session.id === 'old-gift')).toMatchObject({
    giftCardIdByStudentId: { 'student-a': legacyId }, businessStateByStudentId: { 'student-a': { fundingGiftCardId: legacyId } } });
  const penalties = state.students.flatMap((student: any) => student.pendingPenalties);
  expect(penalties.find((penalty: any) => penalty.id === 'penalty-gift')).toMatchObject({ originalGiftCardId: legacyId, canSettle: false, state: 'pending' });
  expect(penalties.filter((penalty: any) => penalty.id !== 'penalty-gift').every((penalty: any) => penalty.canSettle === true)).toBe(true);
  expect(backend.rows).toEqual(originalRows); expect(backend.rpcs).toEqual([]);

  await page.getByTestId('students').locator('button[data-student-id="student-a"]').click();
  const giftPenalty = page.locator('[data-penalty-id="penalty-gift"]');
  await giftPenalty.getByLabel('Motivo de resolución penalty-gift', { exact: true }).fill('Review of the unknown original payment');
  await expect(giftPenalty.getByRole('button', { name: 'Aplicar descuento pendiente', exact: true })).toBeDisabled();
  expect(backend.rpcs).toEqual([]);

  // The availability hint is not authority: a direct callback still submits only the exact original penalty to the server.
  expect(await run(page, 'settlePendingStudentPenalty', [{ ...settlement(), penaltyId: 'penalty-gift', requestKey: 'unknown-gift-request' }]))
    .toMatchObject({ ok: false, code: 'P0001' });
  await ready(page);
  expect(backend.rpcs).toEqual([{ name: 'settle_student_penalty', args: { p_penalty_id: 'penalty-gift',
    p_request_key: 'unknown-gift-request', p_expected_revision: 7, p_reason: settlement().reason } }]);
  const reloaded = await snapshot(page);
  expect({ students: reloaded.students, sessions: reloaded.sessions, giftCards: reloaded.giftCards })
    .toEqual({ students: state.students, sessions: state.sessions, giftCards: state.giftCards });
  expect(reloaded).toMatchObject({ ready: true, error: null, storage: {} });
  expect(backend.rows).toEqual(originalRows); expect(backend.mutations).toEqual([]);
});

test('business state precedes attendance history; mixed activity ID maps and cancellation tombstones remain intact', async ({ page }) => {
  await open(page); await ready(page);
  const state = await snapshot(page);
  const mixed = state.sessions.find((item: any) => item.id === 'mixed-history');
  expect(mixed.activityBlocks).toEqual([{ id: 'block-mesa', activityType: 'mesa', teacherId: 'teacher', capacity: 4, studentIds: ['student-a'] },
    { id: 'block-torno', activityType: 'torno', teacherId: 'teacher', capacity: 2, studentIds: ['student-member'] }]);
  expect(mixed.attendanceByStudentId).toEqual({ 'student-a': 'present', 'student-member': 'present' });
  const cancelled = state.sessions.find((item: any) => item.id === 'cancelled-history');
  expect(cancelled).toMatchObject({ studentIds: ['student-a'], manualCreditIdByStudentId: { 'student-a': 'manual-original' },
    businessStateByStudentId: { 'student-a': { reservationState: 'cancelled', cancellationReason: 'Original cancellation' } } });
  expect(state.students[0].assignedClasses.map((item: any) => item.date)).toEqual(['2026-07-03', '2026-07-04', '2026-07-04']);
  expect(state.students[1].assignedClasses).toHaveLength(2);
});

test('a due projected successor preserves raw period identity and balance without retargeting an older incident', async ({ page }) => {
  const backend = backends.get(page)!;
  Object.assign(backend.rows.students_effective_membership[0], { effective_period_id: 'period-queued', classes_remaining: 8, payment_status: 'pending' });
  Object.assign(backend.rows.student_membership_periods[1], { starts_on: '2026-10-01', ends_on: '2026-10-31' });
  await open(page); await ready(page);
  const member = (await snapshot(page)).students[1];
  expect(member).toMatchObject({ effectivePeriodId: 'period-queued', materializedPeriodId: 'period-original', classesRemaining: 8, legacyManualBalance: 2, paymentStatus: 'pending' });
  expect(member.pendingPenalties[0]).toMatchObject({ originalPeriodId: 'period-original', canSettle: false });
  expect(backend.rpcs).toEqual([]);
});

for (const table of ['student_credit_profile', 'students_effective_membership', 'student_membership_periods', 'session_business_state',
  'sedes', 'gift_cards', 'session_operation_receipts', 'gift_card_operation_receipts', 'full-sessions']) {
  test(`critical ${table} denial rejects refresh, displays loadError and preserves the stored credit key`, async ({ page }) => {
    const backend = backends.get(page)!;
    await open(page); await ready(page);
    backend.rpcMode = 'transport'; expect(await run(page, 'approveStudentManualCredit', [approval()])).toMatchObject({ ok: false });
    const original = (await snapshot(page)).storage;
    backend.failures.set(table, { code: '42501', message: 'Critical projection denied' });
    expect(await run(page, 'loadAllData')).toMatchObject({ ok: false });
    const state = await snapshot(page);
    expect(state).toMatchObject({ ready: false, owner: false, students: [], giftCards: [], error: expect.any(String), storage: original });
    await expect(page.getByTestId('students').getByRole('alert')).toBeVisible();
    expect(state.pendingCredit.requestKey).toBe(approval().requestKey);
    expect(backend.rpcs).toHaveLength(1);
  });
}

for (const malformed of ['profile-revision', 'business-roster', 'membership-period', 'gift-balance', 'gift-payment', 'gift-payment-invalid', 'owner-id']) {
  test(`malformed ${malformed} fails closed without publishing a partial financial snapshot`, async ({ page }) => {
    const backend = backends.get(page)!;
    await open(page); await ready(page);
    backend.rpcMode = 'transport';
    expect(await run(page, 'approveStudentManualCredit', [approval()])).toMatchObject({ ok: false });
    const original = (await snapshot(page)).storage;
    if (malformed === 'profile-revision') backend.rows.student_credit_profile[0].penalty_incidents[0].expected_revision = 6;
    if (malformed === 'business-roster') backend.rows.session_business_state[0].student_id = 'foreign';
    if (malformed === 'membership-period') backend.rows.students_effective_membership[0].materialized_period_id = 'other';
    if (malformed === 'gift-balance') backend.rows.gift_cards[0].sessions_used = -1;
    if (malformed === 'gift-payment') delete backend.rows.gift_cards[0].payment_status;
    if (malformed === 'gift-payment-invalid') backend.rows.gift_cards[0].payment_status = 'unknown';
    if (malformed === 'owner-id') backend.rows.sedes[0].id = null;
    expect(await run(page, 'loadAllData')).toMatchObject({ ok: false });
    expect(await snapshot(page)).toMatchObject({ ready: false, owner: false, students: [], giftCards: [], error: expect.any(String), storage: original });
    expect(backend.rpcs).toHaveLength(1); expect(backend.mutations).toEqual([]);
  });
}

for (const kind of ['approval', 'settlement', 'session']) {
  test(`${kind} commit followed by financial GET failure retains the exact durable intent through remount, read-only reload and receipt replay`, async ({ page }) => {
    const backend = backends.get(page)!;
    await open(page); await ready(page); backend.failAfterRpc = true;
    const result = kind === 'session' ? await run(page, 'updateSession', ['recent', attendance()])
      : kind === 'settlement' ? await run(page, 'settlePendingStudentPenalty', [settlement()])
        : await run(page, 'approveStudentManualCredit', [approval()]);
    expect(result).toMatchObject({ ok: false });
    const original = (await snapshot(page)).storage[pendingKey(kind)]; expect(original).toBeTruthy();
    const firstRpc = clone(backend.rpcs[0]); const mutations = clone(backend.mutations);
    await configure(page, { remount: true });
    await expect.poll(async () => (await snapshot(page)).error).toBeTruthy();
    expect((await snapshot(page)).storage[pendingKey(kind)]).toBe(original);
    expect((await snapshot(page))[kind === 'session' ? 'pendingSession' : 'pendingCredit']).toBeTruthy();
    const retryName = kind === 'session' ? 'retryPendingSessionOperation' : 'retryPendingStudentCreditOperation';
    const retryArgs = [kind === 'session' ? 'recent' : 'student-a'];
    expect(await run(page, retryName, retryArgs)).toMatchObject({ ok: false, error: expect.stringContaining('datos de negocio') });
    expect((await snapshot(page)).storage[pendingKey(kind)]).toBe(original); expect(backend.rpcs).toHaveLength(1);
    backend.failAfterRpc = false; backend.failures.clear();
    expect(await run(page, 'loadAllData')).toMatchObject({ ok: true }); await ready(page);
    expect((await snapshot(page)).storage[pendingKey(kind)]).toBe(original); expect(backend.rpcs).toHaveLength(1);
    await page.evaluate(() => { crypto.randomUUID = () => { throw new Error('Replay cannot mint a new request identity'); }; });
    expect(await run(page, retryName, retryArgs)).toMatchObject({ ok: true });
    expect(backend.rpcs).toEqual([firstRpc, firstRpc]); expect(backend.mutations).toEqual(mutations);
    expect((await snapshot(page)).storage).toEqual({});
  });
}

test('SQL-rejected credit intent stays pending when authoritative refresh fails and only clears after successful recovery', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page); backend.rpcMode = 'sql'; backend.failAfterRpc = true;
  expect(await run(page, 'settlePendingStudentPenalty', [settlement()])).toMatchObject({ ok: false });
  const state = await snapshot(page); const original = state.storage[pendingKey('credit')];
  expect(original).toBeTruthy(); expect(state.pendingCredit.requestKey).toBe(settlement().requestKey); expect(backend.mutations).toEqual([]);
  await configure(page, { remount: true }); await expect.poll(async () => (await snapshot(page)).error).toBeTruthy();
  expect((await snapshot(page)).storage[pendingKey('credit')]).toBe(original);
  backend.failAfterRpc = false; backend.failures.clear();
  expect(await run(page, 'loadAllData')).toMatchObject({ ok: true });
  expect((await snapshot(page)).storage[pendingKey('credit')]).toBe(original);
  expect(await run(page, 'retryPendingStudentCreditOperation', ['student-a'])).toMatchObject({ ok: false, code: '40001' });
  expect(backend.rpcs[1]).toEqual(backend.rpcs[0]); expect(backend.mutations).toEqual([]); expect((await snapshot(page)).storage).toEqual({});
});

test('SQL-rejected session intent stays exact through financial refresh failure, remount and read-only reload until validated retry', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page); backend.rpcMode = 'sql'; backend.failAfterRpc = true;
  expect(await run(page, 'updateSession', ['recent', attendance()])).toMatchObject({ ok: false });
  const state = await snapshot(page); const original = state.storage[pendingKey('session')];
  expect(original).toBeTruthy(); expect(state.pendingSession).toMatchObject({ sessionId: 'recent', expectedRevision: 7, operation: 'attendance' });
  expect(backend.mutations).toEqual([]);
  await configure(page, { remount: true }); await expect.poll(async () => (await snapshot(page)).error).toBeTruthy();
  expect((await snapshot(page)).storage[pendingKey('session')]).toBe(original);
  expect(await run(page, 'retryPendingSessionOperation', ['recent'])).toMatchObject({ ok: false, error: expect.stringContaining('datos de negocio') });
  expect(backend.rpcs).toHaveLength(1);
  backend.failAfterRpc = false; backend.failures.clear();
  expect(await run(page, 'loadAllData')).toMatchObject({ ok: true });
  expect((await snapshot(page)).storage[pendingKey('session')]).toBe(original);
  expect(await run(page, 'retryPendingSessionOperation', ['recent'])).toMatchObject({ ok: false, code: '40001' });
  expect(backend.rpcs[1]).toEqual(backend.rpcs[0]); expect(backend.mutations).toEqual([]); expect((await snapshot(page)).storage).toEqual({});
});

test('financial completion waits for a late profile failure rather than resolving at first calendar paint', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page);
  const held = gate(); backend.holds.set('student_credit_profile', held);
  backend.failures.set('student_credit_profile', { code: '42501', message: 'Late profile error' });
  let finished = false;
  const refresh = run(page, 'loadAllData').then(result => { finished = true; return result; });
  await expect.poll(() => backend.reads.filter(read => read.table === 'student_credit_profile').length).toBeGreaterThan(1);
  expect(finished).toBe(false); expect((await snapshot(page)).ready).toBe(false);
  held.release(); expect(await refresh).toMatchObject({ ok: false });
  expect((await snapshot(page)).error).toBeTruthy();
});

test('held inventory never delays successful financial refresh or clearing a confirmed credit intent', async ({ page }) => {
  const backend = backends.get(page)!;
  backend.holds.set('inventory_items', gate());
  await open(page); await ready(page);
  expect(await run(page, 'approveStudentManualCredit', [approval()])).toMatchObject({ ok: true });
  expect((await snapshot(page))).toMatchObject({ ready: true, storage: {}, inventory: [] });
  expect(backend.mutations).toHaveLength(1);
});

test('stored credit and session descriptors remain read-only during remount hydration without readiness or replacement writes', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page); backend.rpcMode = 'transport';
  expect(await run(page, 'approveStudentManualCredit', [approval()])).toMatchObject({ ok: false });
  expect(await run(page, 'updateSession', ['recent', attendance()])).toMatchObject({ ok: false });
  const original = (await snapshot(page)).storage;
  const held = gate(); backend.holds.set('student_credit_profile', held);
  await configure(page, { remount: true });
  await expect(page.getByRole('status')).toBeVisible();
  const state = await snapshot(page);
  expect(state).toMatchObject({ ready: false, storage: original, pendingCredit: { requestKey: approval().requestKey },
    pendingSession: { sessionId: 'recent', operation: 'attendance' } });
  expect(await run(page, 'retryPendingStudentCreditOperation', ['student-a'])).toMatchObject({ ok: false });
  expect(await run(page, 'retryPendingSessionOperation', ['recent'])).toMatchObject({ ok: false });
  expect((await snapshot(page)).storage).toEqual(original); expect(backend.rpcs).toHaveLength(2);
  held.release(); await ready(page);
  expect((await snapshot(page)).storage).toEqual(original);
});

test('calendar range follows the Madrid date across browser midnight and a DST boundary', async ({ page }) => {
  const backend = backends.get(page)!;
  await page.clock.setFixedTime(new Date('2026-10-24T22:30:00Z'));
  await open(page); await ready(page);
  const query = backend.reads.find(read => read.table === 'sessions' && read.filters.some((item: any[]) => item[0] === 'gte'));
  expect(query.filters).toEqual([['eq', 'sede_id', 'sede-a'], ['gte', 'date', '2026-08-24'], ['lte', 'date', '2026-12-26']]);
});

test('critical timeouts are visible and reject refresh; the optional timeout cannot declare finance ready', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page);
  await page.clock.install({ time: new Date('2026-10-12T08:00:00Z') });
  backend.holds.set('student_credit_profile', gate()); backend.holds.set('inventory_items', gate());
  const previous = backend.reads.filter(read => read.table === 'student_credit_profile').length;
  const refresh = run(page, 'loadAllData');
  await expect.poll(() => backend.reads.filter(read => read.table === 'student_credit_profile').length).toBeGreaterThan(previous);
  await page.clock.fastForward(4501); expect((await snapshot(page)).ready).toBe(false);
  await page.clock.fastForward(24001);
  expect(await refresh).toMatchObject({ ok: false });
  expect((await snapshot(page))).toMatchObject({ ready: false, error: expect.any(String) });
});

for (const change of [{ actor: 'owner-b' }, { sede: 'sede-b' }, { admin: true }]) {
  test(`scope change ${JSON.stringify(change)} hides old finance immediately and rejects captured callbacks without queries or writes`, async ({ page }) => {
    const backend = backends.get(page)!;
    await open(page); await ready(page);
    await page.evaluate(() => window.__integrity.capture('old'));
    backend.holds.set('students', gate());
    await configure(page, change);
    await expect.poll(async () => (await snapshot(page)).loading).toBe(true);
    expect((await snapshot(page))).toMatchObject({ ready: false, students: [], sessions: [], giftCards: [], owner: false });
    const count = backend.reads.filter(read => read.table === 'students').length;
    expect(await run(page, 'loadAllData', [], 'old')).toMatchObject({ ok: false, error: expect.stringContaining('identidad') });
    expect(await run(page, 'approveStudentManualCredit', [approval()], 'old')).toMatchObject({ ok: false });
    expect(await run(page, 'updateSession', ['recent', attendance()], 'old')).toMatchObject({ ok: false });
    expect(backend.reads.filter(read => read.table === 'students')).toHaveLength(count); expect(backend.rpcs).toEqual([]);
  });
}

test('superseded refresh and token refresh cannot publish an older background financial snapshot', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page);
  const old = gate(); backend.holds.set('student_credit_profile', old);
  const previous = backend.reads.filter(read => read.table === 'student_credit_profile').length;
  const stale = run(page, 'loadAllData');
  await expect.poll(() => backend.reads.filter(read => read.table === 'student_credit_profile').length).toBeGreaterThan(previous);
  backend.holds.delete('student_credit_profile');
  backend.rows.students[0].classes_remaining = 1;
  backend.rows.student_credit_profile[0].legacy_observed_balance = 1;
  backend.rows.student_credit_profile[0].legacy_raw_state.classes_remaining = 1;
  await configure(page, { token: 'token-refreshed' }); await ready(page);
  expect((await snapshot(page)).students[0].legacyManualBalance).toBe(1);
  old.release(); expect(await stale).toMatchObject({ ok: false });
  expect((await snapshot(page))).toMatchObject({ ready: true, error: null });
  expect((await snapshot(page)).students[0].legacyManualBalance).toBe(1);
});

test('an old actor financial response cannot publish into a newly loaded actor scope', async ({ page }) => {
  const backend = backends.get(page)!;
  const old = gate(); backend.holds.set('student_credit_profile', old);
  await open(page);
  await expect.poll(() => backend.reads.some(read => read.table === 'student_credit_profile')).toBe(true);
  backend.holds.delete('student_credit_profile');
  backend.rows.students[0].classes_remaining = 1;
  backend.rows.student_credit_profile[0].legacy_observed_balance = 1;
  backend.rows.student_credit_profile[0].legacy_raw_state.classes_remaining = 1;
  await configure(page, { actor: 'owner-b' }); await ready(page);
  expect((await snapshot(page))).toMatchObject({ owner: false });
  expect((await snapshot(page)).students[0].legacyManualBalance).toBe(1);
  const before = await responseCount(page, 'student_credit_profile');
  old.release();
  await expect.poll(() => responseCount(page, 'student_credit_profile')).toBeGreaterThan(before);
  await paint(page);
  expect((await snapshot(page)).students[0].legacyManualBalance).toBe(1);
  expect((await snapshot(page))).toMatchObject({ ready: true, owner: false, error: null });
});

test('returning to the same actor does not revive callbacks retained from an earlier scope lifetime', async ({ page }) => {
  const backend = backends.get(page)!;
  await open(page); await ready(page);
  await page.evaluate(() => window.__integrity.capture('original-actor'));
  await configure(page, { actor: 'owner-b' });
  await expect.poll(async () => (await snapshot(page)).owner).toBe(false); await ready(page);
  await configure(page, { actor: 'owner-a' });
  await expect.poll(async () => (await snapshot(page)).owner).toBe(true); await ready(page);
  expect(await run(page, 'loadAllData', [], 'original-actor')).toMatchObject({ ok: false });
  expect(await run(page, 'approveStudentManualCredit', [approval()], 'original-actor')).toMatchObject({ ok: false });
  expect(backend.rpcs).toEqual([]); expect((await snapshot(page))).toMatchObject({ ready: true, owner: true });
});

test('stale optional responses cannot overwrite optional rows belonging to a newer actor load', async ({ page }) => {
  const backend = backends.get(page)!;
  const old = gate(); backend.holds.set('inventory_items', old);
  backend.rows.inventory_items = [{ id: 'old-inventory', sede_id: 'sede-a', name: 'Old stock' }];
  await open(page); await ready(page);
  await expect.poll(() => backend.reads.some(read => read.table === 'inventory_items')).toBe(true);
  backend.holds.delete('inventory_items');
  backend.rows.inventory_items = [{ id: 'new-inventory', sede_id: 'sede-a', name: 'New stock' }];
  await configure(page, { actor: 'owner-b' }); await ready(page);
  await expect.poll(async () => (await snapshot(page)).inventory.map((item: any) => item.id)).toEqual(['new-inventory']);
  const before = await responseCount(page, 'inventory_items');
  old.release();
  await expect.poll(() => responseCount(page, 'inventory_items')).toBeGreaterThan(before);
  await paint(page);
  expect((await snapshot(page)).inventory.map((item: any) => item.id)).toEqual(['new-inventory']);
  expect((await snapshot(page))).toMatchObject({ ready: true, owner: false, error: null });
});
