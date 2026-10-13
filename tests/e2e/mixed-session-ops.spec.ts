import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mixedIds as ids, mixedSession, mixedSessionIsolationPlugin } from '../fixtures/mixed-session-ops-harness';

type Backend = { calls: any[]; writes: any[]; receipts: Map<string, any>; lose: boolean; refreshFailure: boolean;
  hold?: Promise<void>; holdKind?: 'rpc' | 'refresh'; external: string[]; errors: string[]; session?: any };
const backends = new WeakMap<Page, Backend>();
const run = (page: Page, name: string, args: any[] = []) => page.evaluate(({ name, args }) => (window as any).__mixed.run(name, args), { name, args });
const configure = (page: Page, value: any) => page.evaluate(value => (window as any).__mixed.configure(value), value);
const snapshot = (page: Page) => page.evaluate(() => (window as any).__mixed.snapshot());
const draft = () => { const { id, ...session } = structuredClone(mixedSession); return { ...session,
  activityBlocks: session.activityBlocks!.map(({ id, ...block }) => block) }; };
const blocks = () => structuredClone(mixedSession.activityBlocks!);
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    cacheDir: join(tmpdir(), 'opencode', 'vite-mixed-session-ops'), plugins: [mixedSessionIsolationPlugin(), react()],
    optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  const backend: Backend = { calls: [], writes: [], receipts: new Map(), lose: false, refreshFailure: false, external: [], errors: [] };
  backends.set(page, backend);
  page.on('pageerror', error => backend.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    backend.external.push(route.request().url()); return route.abort();
  });
  await page.route('**/__mixed-session-ops', async route => {
    const request = route.request().postDataJSON(); backend.calls.push(structuredClone(request));
    if (request.kind === 'refresh') {
      if (backend.holdKind === 'refresh') await backend.hold;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      error: backend.refreshFailure ? { message: 'Authoritative refresh failed' } : null, session: backend.session
      }) });
    }
    if (request.kind !== 'rpc') throw new Error('Standalone mixed activity access');
    let receipt = backend.receipts.get(request.args.p_request_key);
    if (!receipt) {
      receipt = { session_id: request.args.p_session_id, request_key: request.args.p_request_key, revision: 8,
        snapshot: { activity_blocks: [{ id: 'stale-receipt-block' }], remaining_classes: 999 } };
      backend.receipts.set(request.args.p_request_key, receipt); backend.writes.push(structuredClone(request));
    }
    if (backend.holdKind !== 'refresh') await backend.hold;
    return route.fulfill({ status: backend.lose ? 503 : 200, contentType: 'application/json', body: JSON.stringify({ data: receipt, error: null }) });
  });
  await page.route('**/mixed-session-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
    svg{width:20px;height:20px}.fixed{position:fixed;inset:0;background:white;overflow:auto;z-index:100}.hidden{display:none}button{min-height:30px}
    </style></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    await import('/tests/fixtures/mixed-session-ops-harness.tsx');</script></body></html>` }));
  await page.goto(`${origin}/mixed-session-test`); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
});
test.afterEach(async ({ page }) => { expect(backends.get(page)!.external).toEqual([]); expect(backends.get(page)!.errors).toEqual([]); });

for (const operation of ['add', 'update']) test(`${operation} mixed reservation uses one RPC, complete blocks and exactly one authoritative refresh`, async ({ page }) => {
  const backend = backends.get(page)!;
  const result = operation === 'add' ? await run(page, 'addSession', [draft()]) : await run(page, 'updateSession', [ids.session, { workshopName: 'Atomic edit' }]);
  expect(result.ok).toBe(true); expect(backend.calls.map(call => call.kind)).toEqual(['rpc', 'refresh']);
  expect(backend.calls[0]).toMatchObject({ name: 'save_session_reservation', args: { p_expected_revision: operation === 'add' ? 0 : 7,
    p_sede_id: ids.sede, p_metadata: { class_type: 'mixto', teacher_id: null, capacity: 6 },
    p_student_ids: [ids.mesa, ids.torno], p_manual_credit_ids: { [ids.mesa]: ids.manual }, p_gift_card_ids: { [ids.torno]: ids.gift } } });
  expect(backend.calls[0].args.p_activity_blocks).toEqual(expect.arrayContaining([
    { ...(operation === 'add' ? {} : { id: ids.mesaBlock }), activity_type: 'mesa', teacher_id: ids.mesaTeacher, capacity: 4, student_ids: [ids.mesa] },
    { ...(operation === 'add' ? {} : { id: ids.tornoBlock }), activity_type: 'torno', teacher_id: ids.tornoTeacher, capacity: 2, student_ids: [ids.torno] }
  ]));
  expect((await snapshot(page)).storage).toEqual({}); expect(backend.writes).toHaveLength(1);
  expect((await snapshot(page)).session.activityBlocks).toEqual(mixedSession.activityBlocks);
});

test('mixed intent canonically deep-copies and freezes every map, block, roster and metadata without freezing the caller', async ({ page }) => {
  const result = await page.evaluate(value => (window as any).__mixed.intent(value), {
    metadata: { class_type: 'mixto', teacher_id: null, capacity: 6 }, studentIds: [ids.torno, ids.mesa],
    gifts: { [ids.torno]: ids.gift }, manual: { [ids.mesa]: ids.manual }, blocks: blocks().reverse().map(block => ({
      id: block.id, activity_type: block.activityType, teacher_id: block.teacherId || null, capacity: block.capacity, student_ids: block.studentIds
    }))
  });
  expect(result).toMatchObject({ stable: true, callerEditable: true, frozen: true });
  expect(result.args.p_request_key).toBe('original-key'); expect(result.args.p_student_ids).toEqual([ids.mesa, ids.torno]);
  expect(backends.get(page)!.calls).toEqual([]);
});

for (const failure of ['lost-response', 'refresh-failure']) test(`${failure} preserves the complete original body through changed loaded revision and exact receipt replay`, async ({ page }) => {
  const backend = backends.get(page)!; backend.lose = failure === 'lost-response'; backend.refreshFailure = failure === 'refresh-failure';
  expect((await run(page, 'addSession', [draft()])).ok).toBe(false);
  const original = structuredClone(backend.calls[0]); const stored = (await snapshot(page)).storage;
  expect(Object.keys(stored)).toHaveLength(1);
  expect((await run(page, 'addSession', [{ ...draft(), workshopName: 'Substitution' }])).error).toContain('intento pendiente');
  await configure(page, { session: { ...mixedSession, revision: 90 } });
  backend.lose = false; backend.refreshFailure = false;
  backend.session = { ...structuredClone(mixedSession), revision: 91 };
  await page.evaluate(() => { crypto.randomUUID = () => { throw new Error('Replay must not regenerate IDs'); }; });
  expect((await run(page, 'retryPendingSessionOperation')).ok).toBe(true);
  expect(backend.calls.filter(call => call.kind === 'rpc')).toEqual([original, original]); expect(backend.writes).toHaveLength(1);
  expect(await snapshot(page)).toMatchObject({ storage: {}, session: { revision: 91 } });
});

test('pending mixed reservation cannot be substituted by attendance or a different block/source operation', async ({ page }) => {
  const backend = backends.get(page)!; backend.lose = true;
  expect((await run(page, 'updateSession', [ids.session, { workshopName: 'Original' }])).ok).toBe(false);
  const stored = (await snapshot(page)).storage;
  for (const updates of [{ attendanceByStudentId: { [ids.mesa]: 'present' } }, { activityBlocks: blocks().map(block => ({ ...block, capacity: 3 })) },
    { giftCardIdByStudentId: {} }, { workshopName: 'Other' }]) {
    expect((await run(page, 'updateSession', [ids.session, updates])).error).toContain('intento pendiente');
  }
  expect(backend.calls).toHaveLength(1); expect((await snapshot(page)).storage).toEqual(stored);
});

const invalidBlocks: Array<[string, (value: any) => void]> = [
  ['unsupported activity', value => { value.activityBlocks[0].activityType = 'mixto'; }],
  ['duplicate student', value => { value.activityBlocks[1].studentIds = [ids.mesa]; }],
  ['duplicate block ID', value => { value.activityBlocks[1].id = ids.mesaBlock; }],
  ['foreign block ID', value => { value.activityBlocks[0].id = 'foreign-block'; }],
  ['missing block roster', value => { delete value.activityBlocks[0].studentIds; }],
  ['unknown student', value => { value.activityBlocks[0].studentIds = ['Alex Same']; }],
  ['fractional capacity', value => { value.activityBlocks[0].capacity = 3.5; }],
  ['excess total capacity', value => { value.activityBlocks[0].capacity = 99; }],
  ['parent capacity mismatch', value => { value.capacity = 8; }],
  ['parent teacher', value => { value.teacherId = ids.mesaTeacher; }],
  ['missing blocks', value => { value.activityBlocks = []; }],
  ['duplicate roster', value => { value.studentIds = [ids.mesa, ids.mesa]; }]
];
for (const [name, mutate] of invalidBlocks) test(`malformed mixed ${name} fails before any RPC, standalone access or stored intent`, async ({ page }) => {
  const value: any = { ...structuredClone(mixedSession) }; mutate(value);
  const { id, ...updates } = value;
  expect((await run(page, 'updateSession', [id, updates])).ok).toBe(false);
  expect(backends.get(page)!.calls).toEqual([]); expect((await snapshot(page)).storage).toEqual({});
});

test('cancelled tombstone retains its source and block identity but is excluded from the active RPC assignments', async ({ page }) => {
  const current = structuredClone(mixedSession);
  current.businessStateByStudentId![ids.mesa].reservationState = 'cancelled';
  await configure(page, { session: current });
  expect((await run(page, 'updateSession', [ids.session, { studentIds: [ids.torno], manualCreditIdByStudentId: {}, workshopName: 'Keep history' }])).ok).toBe(true);
  const args = backends.get(page)!.calls[0].args;
  expect(args.p_student_ids).toEqual([ids.mesa, ids.torno]); expect(args.p_manual_credit_ids).toEqual({ [ids.mesa]: ids.manual });
  expect(args.p_activity_blocks.find((block: any) => block.id === ids.mesaBlock).student_ids).toEqual([]);
  expect((await snapshot(page)).session.activityBlocks).toEqual(current.activityBlocks);
});

for (const history of ['finalized', 'cancelled']) for (const field of ['teacher', 'capacity', 'assignment', 'block-id']) {
  test(`${history} original ${field} cannot be rebound by reservation edits`, async ({ page }) => {
    const current = structuredClone(mixedSession);
    if (history === 'finalized') current.completedAt = '2026-10-12T12:00:00Z';
    else current.businessStateByStudentId![ids.mesa].reservationState = 'cancelled';
    await configure(page, { session: current });
    const changed = blocks();
    if (field === 'teacher') changed[0].teacherId = ids.tornoTeacher;
    if (field === 'capacity') { changed[0].capacity = 3; changed[1].capacity = 3; }
    if (field === 'assignment') { changed[0].studentIds = [ids.torno]; changed[1].studentIds = [ids.mesa]; }
    if (field === 'block-id') delete changed[0].id;
    expect((await run(page, 'updateSession', [ids.session, { activityBlocks: changed }])).ok).toBe(false);
    expect(backends.get(page)!.calls).toEqual([]);
  });
}

for (const policy of [1, 2]) test(`classic policy ${policy} retains the shipped eight-argument call with no empty block argument`, async ({ page }) => {
  const value = { ...draft(), classType: 'mesa', attendancePolicyVersion: policy, activityBlocks: [], manualCreditIdByStudentId: {}, giftCardIdByStudentId: {} };
  expect((await run(page, 'addSession', [value])).ok).toBe(true);
  const args = backends.get(page)!.calls[0].args;
  expect(Object.keys(args).sort()).toEqual(['p_session_id', 'p_request_key', 'p_expected_revision', 'p_sede_id', 'p_metadata', 'p_student_ids', 'p_gift_card_ids', 'p_manual_credit_ids'].sort());
});

test('verified mixed manual Mesa and gift Torno incidents are usable only against their original ID-bound activity sources', async ({ page }) => {
  const penalties = await page.evaluate(() => (window as any).__mixed.availability());
  expect(penalties.map((penalty: any) => penalty.canSettle)).toEqual([true, true]);
  expect(penalties.map((penalty: any) => [penalty.originalManualCreditId, penalty.originalGiftCardId])).toEqual([[ids.manual, undefined], [undefined, ids.gift]]);
  expect(backends.get(page)!.calls).toEqual([]);
});
for (const evidence of ['unverified', 'missing-block', 'wrong-block', 'wrong-activity', 'wrong-teacher', 'wrong-capacity', 'duplicate-assignment', 'missing-projection']) {
  test(`mixed ${evidence} provenance keeps history but never enables original-source liquidation`, async ({ page }) => {
    const current = structuredClone(mixedSession); const state = current.businessStateByStudentId![ids.mesa];
    if (evidence === 'unverified') state.activitySourceVerified = false;
    if (evidence === 'missing-block') delete state.fundingActivityBlockId;
    if (evidence === 'wrong-block') state.fundingActivityBlockId = ids.tornoBlock;
    if (evidence === 'wrong-activity') state.fundingActivityType = 'torno';
    if (evidence === 'wrong-teacher') state.activityTeacherId = ids.tornoTeacher;
    if (evidence === 'wrong-capacity') state.activityCapacity = 2;
    if (evidence === 'duplicate-assignment') current.activityBlocks![1].studentIds.push(ids.mesa);
    if (evidence === 'missing-projection') { delete state.activitySourceVerified; delete state.fundingActivityType; }
    const penalties = await page.evaluate(value => (window as any).__mixed.availability(value), current);
    expect(penalties[0]).toMatchObject({ canSettle: false, originalManualCreditId: ids.manual, state: 'pending' });
    expect(backends.get(page)!.calls).toEqual([]);
  });
}

test('mixed attendance remains one ID-based batch with the existing default finalization policy', async ({ page }) => {
  expect((await run(page, 'updateSession', [ids.session, { attendanceByStudentId: { [ids.mesa]: 'present' } }])).ok).toBe(true);
  expect(backends.get(page)!.calls).toEqual([{ kind: 'rpc', name: 'save_session_attendance', args: expect.objectContaining({
    p_expected_revision: 7, p_finalize: false, p_attendance: [{ student_id: ids.mesa, status: 'present' }, { student_id: ids.torno, status: 'pending' }]
  }) }, { kind: 'refresh' }]);
});

for (const phase of ['rpc', 'refresh'] as const) test(`captured mixed scope cannot refresh or mutate activity trees after scope changes during ${phase}`, async ({ page }) => {
  const backend = backends.get(page)!;
  let release!: () => void;
  backend.holdKind = phase; backend.hold = new Promise(resolve => { release = resolve; });
  const saved = run(page, 'updateSession', [ids.session, { workshopName: 'Captured' }]);
  await expect.poll(() => backend.calls.some(call => call.kind === phase)).toBe(true);
  await configure(page, { invalidate: true }); release();
  expect((await saved).error).toContain('scope lifetime'); expect(backend.calls).toHaveLength(phase === 'rpc' ? 1 : 2);
  expect(backend.writes).toHaveLength(1); expect(Object.keys((await snapshot(page)).storage)).toHaveLength(1);
});

test('calendar mixed funding uses each block activity and retains invalid original manual selection after an explicit block move', async ({ page }) => {
  await page.evaluate(() => (window as any).__mixed.render());
  await page.locator(`[data-session-id="${ids.session}"]`).click();
  const manualSelect = page.getByLabel('Financiación de Alex Same (00000001)', { exact: true });
  const giftSelect = page.getByLabel('Financiación de Alex Same (00000002)', { exact: true });
  await expect(manualSelect).toHaveValue(`manual:${ids.manual}`); await expect(giftSelect).toHaveValue(ids.gift);
  expect(await manualSelect.locator('option').allTextContents()).toContainEqual(expect.stringContaining('Credito manual'));
  expect(await giftSelect.locator('option').allTextContents()).toContainEqual(expect.stringContaining('Bono de'));
  const mesaField = page.getByLabel('Profesor de mesa').locator('..');
  await mesaField.locator('input[type="checkbox"]').first().uncheck();
  const tornoField = page.getByLabel('Profesor de torno').locator('..');
  await tornoField.locator('input[type="checkbox"]').first().check();
  await expect(manualSelect).toHaveValue(`manual:${ids.manual}`);
  await expect(manualSelect.locator(`option[value="manual:${ids.manual}"]`)).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Corrige la seleccion explicitamente');
  expect((await snapshot(page)).uiSaves).toEqual([]); expect(backends.get(page)!.calls).toEqual([]);
});

for (const history of ['finalized', 'cancelled']) test(`calendar protects mixed ${history} block fields and original assignments`, async ({ page }) => {
  const current = structuredClone(mixedSession);
  if (history === 'finalized') current.completedAt = '2026-10-12T12:00:00Z';
  else current.businessStateByStudentId![ids.mesa].reservationState = 'cancelled';
  await configure(page, { session: current });
  await page.evaluate(() => (window as any).__mixed.render());
  await page.locator(`[data-session-id="${ids.session}"]`).click();
  for (const label of ['Tipo de sesión', 'Cupo máximo', 'Cupo mesa', 'Cupo torno', 'Profesor de mesa', 'Profesor de torno', 'Hora de inicio', 'Hora de fin']) {
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  }
  await expect(page.getByLabel('Financiación de Alex Same (00000001)', { exact: true })).toBeDisabled();
  expect((await snapshot(page)).uiSaves).toEqual([]);
});

test('calendar read-only mixed state never opens editable activity fields', async ({ page }) => {
  await page.evaluate(() => (window as any).__mixed.render(true));
  await page.locator(`[data-session-id="${ids.session}"]`).dispatchEvent('click');
  await expect(page.getByLabel('Profesor de mesa')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeDisabled();
  expect((await snapshot(page)).uiSaves).toEqual([]); expect(backends.get(page)!.calls).toEqual([]);
});
