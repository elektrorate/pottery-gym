import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  operationScopeIsolationPlugin, operationScopeHarnessHtml, scopeSession, scopeBlocks
} from '../fixtures/operation-scope-integrity-harness';

type Gate = { promise: Promise<void>; release: () => void };
const gate = (): Gate => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};
type Backend = {
  calls: any[]; mutations: any[]; rows: Record<string, any[]>; holds: Map<string, Gate>;
  failures: Map<string, any>; receipts: Map<string, any>; external: string[]; errors: string[];
};
const backends = new WeakMap<Page, Backend>();
const label = (request: any) => request.kind === 'rpc' ? request.name : request.kind === 'refresh' ? 'refresh'
  : `${request.table}.${request.action}${request.table === 'sessions' && request.action === 'update' ? `.${Object.keys(request.payload)[0]}`
    : request.table === 'session_students' && request.action === 'update' ? `.${request.payload.activity_type}` : ''}`;
const snapshot = (page: Page) => page.evaluate(() => (window as any).__operationScope.snapshot());
const configure = (page: Page, value: any) => page.evaluate(value => (window as any).__operationScope.configure(value), value);
const start = (page: Page, name: string, args: any[] = [], key?: string) =>
  page.evaluate(({ name, args, key }) => (window as any).__operationScope.start(name, args, key), { name, args, key });
const finish = async (page: Page, id: string) => {
  await expect.poll(async () => (await snapshot(page)).results[id].pending).not.toBe(true);
  return (await snapshot(page)).results[id];
};
const draft = () => { const { id, ...session } = structuredClone(scopeSession); return session; };
const movement = { item_id: 'item', type: 'entrada', quantity: 3, new_quantity: 5 };
const business = { operation: 'cancel_reservation', sessionId: 'session', studentId: 'student-mesa',
  requestKey: 'business-key', expectedRevision: 7, reason: 'Explicit correction' };
let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    cacheDir: join(tmpdir(), 'opencode', 'vite-operation-scope-integrity'),
    plugins: [operationScopeIsolationPlugin()],
    optimizeDeps: { entries: [], include: ['react'] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  const backend: Backend = { calls: [], mutations: [], holds: new Map(), failures: new Map(), receipts: new Map(), external: [], errors: [], rows: {
    inventory_items: [{ id: 'item', current_quantity: 2 }], inventory_movements: [],
    teachers: [{ id: 'teacher', name: 'Original' }], sessions: [{ id: 'session', teacher_id: 'teacher', teacher_substitute_id: 'teacher' }],
    session_activity_blocks: [{ id: 'old-block', session_id: 'session', sede_id: 'sede-a', activity_type: 'mesa' }],
    session_activity_block_students: [], session_students: [
      { session_id: 'session', student_id: 'student-mesa', gift_card_id: 'gift', activity_type: 'mesa' },
      { session_id: 'session', student_id: 'student-torno', activity_type: 'mesa' }
    ]
  } };
  backends.set(page, backend);
  page.on('pageerror', error => backend.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    backend.external.push(route.request().url()); return route.abort();
  });
  await page.route('**/__operation-scope-integrity', async route => {
    const request = route.request().postDataJSON();
    backend.calls.push(structuredClone(request));
    const error = backend.failures.get(label(request));
    let response: any = { data: null, error: error || null };
    if (!error && request.kind === 'table') {
      const rows = backend.rows[request.table];
      if (!rows) throw new Error(`Unexpected table ${request.table}`);
      const matches = (row: any) => request.filters.every(([op, column, value]: any[]) => op === 'eq' ? row[column] === value : value.includes(row[column]));
      let returned = rows.filter(matches);
      if (request.action === 'delete') {
        backend.rows[request.table] = rows.filter(row => !matches(row));
        if (request.table === 'session_activity_blocks') backend.rows.session_activity_block_students = backend.rows.session_activity_block_students
          .filter(row => !returned.some(block => block.id === row.block_id));
      } else if (request.action === 'insert') {
        returned = (Array.isArray(request.payload) ? request.payload : [request.payload]).map((row: any, index: number) =>
          request.table === 'session_activity_block_students' ? { ...row }
            : { id: `saved-${rows.length + index}`, ...row });
        rows.push(...returned);
      } else if (request.action === 'update') {
        returned.forEach(row => Object.assign(row, request.payload));
      } else if (request.action !== 'select') throw new Error(`Unexpected table action ${request.action}`);
      if (request.action !== 'select') backend.mutations.push(structuredClone(request));
      if (request.action === 'select' || request.returning) {
        const selected = returned.map(row => request.columns === '*' ? { ...row }
          : Object.fromEntries(request.columns.split(',').map((column: string) => [column, row[column]])));
        response.data = request.single ? selected[0] || null : selected;
      }
    } else if (!error && request.kind === 'rpc') {
      if (request.name === 'reverse_gift_card_session') {
        response.data = { id: request.args.p_gift_card_id, sede_id: 'sede-a', num_classes: 3, sessions_used: 0 };
        backend.mutations.push(structuredClone(request));
      } else if (['save_session_reservation', 'save_session_attendance', 'cancel_session_reservation'].includes(request.name)) {
        const replay = backend.receipts.get(request.args.p_request_key);
        if (replay) response.data = { ...replay, replayed: true };
        else {
          response.data = { session_id: request.args.p_session_id, request_key: request.args.p_request_key, revision: 8 };
          backend.receipts.set(request.args.p_request_key, response.data);
          backend.mutations.push(structuredClone(request));
        }
      } else throw new Error(`Unexpected RPC ${request.name}`);
    } else if (!error && request.kind !== 'refresh') throw new Error(`Unexpected request kind ${request.kind}`);
    // The first write can already be committed. Only its response is delayed.
    await backend.holds.get(label(request))?.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) }).catch(() => undefined);
  });
  await page.route('**/operation-scope-test', route => route.fulfill({ contentType: 'text/html', body: operationScopeHarnessHtml }));
  await page.goto(`${origin}/operation-scope-test`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
});
test.afterEach(async ({ page }) => {
  const backend = backends.get(page)!;
  for (const held of backend.holds.values()) held.release();
  expect(backend.external).toEqual([]); expect(backend.errors).toEqual([]);
});

const initialActions: Array<[string, any[]]> = [
  ['addInventoryItem', [{ id: 'item', name: 'Clay', category: 'clay' }]],
  ['updateInventoryItem', ['item', { name: 'Updated' }]], ['archiveInventoryItem', ['item']], ['deleteInventoryItem', ['item']],
  ['addInventoryMovement', [movement]], ['addTeacher', [{ name: 'New teacher' }]],
  ['updateTeacher', ['teacher', { name: 'Updated' }]], ['deleteTeacher', ['teacher']],
  ['reverseGiftCardSession', ['', 'session', 'student-mesa']], ['reverseGiftCardSession', ['gift', 'session', 'student-mesa']],
  ['addSession', [draft()]], ['updateSession', ['session', { capacity: 7 }]],
  ['updateSession', ['session', { attendanceByStudentId: { 'student-mesa': 'present' } }]],
  ['applySessionBusinessOperation', [business]]
];
for (const invalid of ['not-ready', 'stale-lifetime']) test(`${invalid} prevents every initial helper write, optimistic setter and pending intent`, async ({ page }) => {
  await page.evaluate(() => (window as any).__operationScope.capture('old'));
  if (invalid === 'not-ready') await configure(page, { ready: false });
  else { await configure(page, { actor: 'actor-b' }); await configure(page, { actor: 'actor-a' }); }
  const before = await snapshot(page);
  for (const [name, args] of initialActions) {
    const result = await finish(page, await start(page, name, args, 'old'));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(invalid === 'not-ready' ? 'not ready' : 'lifetime') });
  }
  const after = await snapshot(page);
  expect(after.sdkCalls).toEqual([]); expect(backends.get(page)!.calls).toEqual([]);
  expect(after.setters).toEqual([]); expect(after.reloads).toEqual([]);
  expect(after.state).toEqual(before.state); expect(after.storage).toEqual({});
});

const changes = ['actor-same-sede', 'sede', 'actor-return', 'sede-return', 'not-ready', 'remount'];
const invalidate = async (page: Page, change: string) => {
  if (change.startsWith('actor')) {
    await configure(page, { actor: 'actor-b' });
    if (change === 'actor-return') await configure(page, { actor: 'actor-a' });
  } else if (change.startsWith('sede')) {
    await configure(page, { sede: 'sede-b' });
    if (change === 'sede-return') await configure(page, { sede: 'sede-a' });
  } else await configure(page, change === 'not-ready' ? { ready: false } : { remount: true });
};
const staleAfter = async (page: Page, name: string, args: any[], heldLabel: string, change: string) => {
  const backend = backends.get(page)!;
  const held = gate(); backend.holds.set(heldLabel, held);
  const id = await start(page, name, args);
  await expect.poll(() => backend.calls.some(call => label(call) === heldLabel)).toBe(true);
  if (name === 'deleteTeacher' && heldLabel.startsWith('sessions.')) {
    await expect.poll(() => backend.calls.filter(call => call.table === 'sessions').length).toBe(2);
  }
  expect((await snapshot(page)).results[id]).toEqual({ pending: true });
  await invalidate(page, change);
  const before = await snapshot(page);
  const calls = structuredClone(backend.calls);
  const mutations = structuredClone(backend.mutations);
  held.release();
  const result = await finish(page, id);
  const after = await snapshot(page);
  const observable = [result.error || '', ...after.errors.slice(before.errors.length)].join(' ');
  expect(observable).toContain(change === 'not-ready' ? 'not ready' : 'lifetime');
  expect(result.value).not.toBe(false);
  expect(after.sdkCalls).toEqual(before.sdkCalls);
  expect(backend.calls).toEqual(calls); expect(backend.mutations).toEqual(mutations);
  expect(after.setters).toEqual(before.setters); expect(after.state).toEqual(before.state);
  expect(after.reloads.filter((item: any) => item.phase === 'start')).toEqual(before.reloads.filter((item: any) => item.phase === 'start'));
  expect(after.storage).toEqual(before.storage);
};

const delayed: Array<[string, any[], string]> = [
  ['addInventoryMovement', [movement], 'inventory_movements.insert'],
  ['deleteTeacher', ['teacher'], 'sessions.update.teacher_id'],
  ['reverseGiftCardSession', ['', 'session', 'student-mesa'], 'session_students.select'],
  ['addSession', [draft()], 'save_session_reservation'],
  ['updateSession', ['session', { capacity: 7 }], 'save_session_reservation']
];
for (const [name, args, heldLabel] of delayed) for (const change of changes) {
  test(`${name} delayed ${heldLabel} cannot continue after ${change}`, async ({ page }) => {
    await staleAfter(page, name, args, heldLabel, change);
  });
}

for (const heldLabel of ['refresh', 'session_activity_blocks.select', 'session_activity_blocks.delete',
  'session_activity_blocks.insert', 'session_activity_block_students.insert', 'session_students.update.mesa', 'session_students.update.torno']) {
  test(`mixed session cannot continue after actor return during ${heldLabel}`, async ({ page }) => {
    await staleAfter(page, 'updateSession', ['session', { capacity: 7 }], heldLabel, 'actor-return');
  });
}
for (const [name, args, heldLabel] of [
  ['addInventoryMovement', [movement], 'inventory_items.update'],
  ['deleteInventoryItem', ['item'], 'inventory_items.delete'],
  ['deleteTeacher', ['teacher'], 'sessions.update.teacher_substitute_id'],
  ['deleteTeacher', ['teacher'], 'teachers.delete'],
  ['reverseGiftCardSession', ['gift', 'session', 'student-mesa'], 'reverse_gift_card_session'],
  ['updateSession', ['session', { attendanceByStudentId: { 'student-mesa': 'present' } }], 'save_session_attendance'],
  ['applySessionBusinessOperation', [business], 'cancel_session_reservation']
] as Array<[string, any[], string]>) {
  test(`${name} late ${heldLabel} cannot publish or reload another actor scope`, async ({ page }) => {
    await staleAfter(page, name, args, heldLabel, 'actor-same-sede');
  });
}

test('valid scope preserves inventory quantity and parallel teacher unlink/delete behavior', async ({ page }) => {
  const backend = backends.get(page)!;
  expect(await finish(page, await start(page, 'addInventoryMovement', [movement]))).toMatchObject({ ok: true });
  expect(backend.rows.inventory_items[0].current_quantity).toBe(5);
  expect((await snapshot(page)).state.inventory[0].current_quantity).toBe(5);
  expect(await finish(page, await start(page, 'deleteTeacher', ['teacher']))).toMatchObject({ ok: true });
  expect(backend.rows.teachers).toEqual([]);
  expect(backend.rows.sessions[0]).toMatchObject({ teacher_id: null, teacher_substitute_id: null });
  expect(backend.calls.map(label)).toEqual(['inventory_movements.insert', 'inventory_items.update', 'refresh',
    'sessions.update.teacher_id', 'sessions.update.teacher_substitute_id', 'teachers.delete']);
});

test('valid mixed session keeps shipping block replacement, roster links and per-student activity writes', async ({ page }) => {
  const backend = backends.get(page)!;
  expect(await finish(page, await start(page, 'updateSession', ['session', { capacity: 7 }]))).toEqual({ ok: true, value: true });
  expect(backend.calls.map(label)).toEqual(['save_session_reservation', 'refresh', 'session_activity_blocks.select',
    'session_activity_blocks.delete', 'session_activity_blocks.insert', 'session_activity_block_students.insert',
    'session_students.update.mesa', 'session_students.update.torno', 'refresh']);
  const rpc = backend.calls[0];
  expect(rpc.args).toMatchObject({ p_expected_revision: 7, p_sede_id: 'sede-a', p_student_ids: ['student-mesa', 'student-torno'],
    p_gift_card_ids: { 'student-torno': 'gift' }, p_manual_credit_ids: { 'student-mesa': 'manual' } });
  expect(backend.rows.session_activity_blocks).toEqual(scopeBlocks.slice(0, 2).map((block, index) => ({
    id: `saved-${index}`, session_id: 'session', sede_id: 'sede-a', activity_type: block.activityType,
    teacher_id: block.teacherId, capacity: block.capacity
  })));
  expect(backend.rows.session_activity_block_students).toEqual([
    { block_id: 'saved-0', session_id: 'session', student_id: 'student-mesa' },
    { block_id: 'saved-1', session_id: 'session', student_id: 'student-torno' }
  ]);
  expect(backend.rows.session_students.map(row => row.activity_type)).toEqual(['mesa', 'torno']);
  expect((await snapshot(page)).storage).toEqual({});
});

test('empty activity blocks keep the allowlisted read without any standalone block DML', async ({ page }) => {
  const backend = backends.get(page)!;
  backend.rows.session_activity_blocks = [];
  expect(await finish(page, await start(page, 'addSession', [{ ...draft(), activityBlocks: [] }]))).toMatchObject({ ok: true });
  expect(backend.calls.map(label)).toEqual(['save_session_reservation', 'refresh', 'session_activity_blocks.select', 'refresh']);
  expect(backend.calls[2]).toMatchObject({ columns: 'id', filters: [['eq', 'session_id', backend.calls[0].args.p_session_id]] });
});

test('gift reverse lookup keeps its resolved identity and missing link remains a real no-op', async ({ page }) => {
  const backend = backends.get(page)!;
  expect(await finish(page, await start(page, 'reverseGiftCardSession', ['', 'session', 'student-mesa']))).toEqual({ ok: true, value: true });
  expect(backend.calls[1]).toMatchObject({ name: 'reverse_gift_card_session', args: {
    p_gift_card_id: 'gift', p_session_id: 'session', p_student_id: 'student-mesa'
  } });
  expect(await finish(page, await start(page, 'reverseGiftCardSession', ['', 'session', 'unknown']))).toEqual({ ok: true, value: false });
  expect(backend.mutations).toHaveLength(1);
});

test('stale reservation response retains its exact financial intent; only explicit ready retry replays its receipt', async ({ page }) => {
  const backend = backends.get(page)!;
  await staleAfter(page, 'updateSession', ['session', { capacity: 7 }], 'save_session_reservation', 'actor-return');
  const original = structuredClone(backend.calls[0]);
  const pending = (await snapshot(page)).storage;
  await configure(page, { ready: false });
  expect(await finish(page, await start(page, 'retryPendingSessionOperation', ['session']))).toMatchObject({ ok: false, error: expect.stringContaining('not ready') });
  expect(backend.calls).toHaveLength(1); expect((await snapshot(page)).storage).toEqual(pending);
  await configure(page, { ready: true });
  expect(await finish(page, await start(page, 'retryPendingSessionOperation', ['session']))).toMatchObject({ ok: true });
  expect(backend.calls.filter(call => call.kind === 'rpc').map(call => ({ name: call.name, args: call.args })))
    .toEqual([{ name: original.name, args: original.args }, { name: original.name, args: original.args }]);
  expect(backend.mutations).toHaveLength(1);
  expect(backend.calls.map(label)).toEqual(['save_session_reservation', 'save_session_reservation', 'refresh']);
  expect((await snapshot(page)).storage).toEqual({});
});

test('late teacher delete rejection cannot trigger recovery reload in the new actor', async ({ page }) => {
  backends.get(page)!.failures.set('teachers.delete', { code: '42501', message: 'Synthetic denied delete' });
  await staleAfter(page, 'deleteTeacher', ['teacher'], 'teachers.delete', 'actor-return');
});

test('late SQL reservation rejection cannot refresh or clear the old intent in the new actor', async ({ page }) => {
  backends.get(page)!.failures.set('save_session_reservation', { code: '40001', message: 'Synthetic revision rejection' });
  await staleAfter(page, 'updateSession', ['session', { capacity: 7 }], 'save_session_reservation', 'actor-return');
});
