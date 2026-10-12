import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SessionIntentStore, createSessionOperations, createSessionReservationIntent, createSessionAttendanceIntent,
  reservationInput, resolveSessionStudentIds
} from '../../context/data/sessionAttendanceOps';
import type { ClassSession, Student } from '../../types';
import { manualCreditIds as ids, manualCreditIsolationPlugin, manualCreditHarnessHtml } from '../fixtures/calendar-manual-credit-ui-harness';

const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const input = reservationInput({ studentIds: [ids.other, ids.member], giftCardIdByStudentId: { [ids.other]: ids.gift },
  manualCreditIdByStudentId: { [ids.member]: ids.original } });
const intent = (requestKey = 'original-key') => createSessionReservationIntent(ids.session, 7, ids.sede, { capacity: 4 },
  [ids.other, ids.member], { [ids.other]: ids.gift }, input, requestKey, { [ids.member]: ids.original });
const receipt = (args: Record<string, any>) => ({ data: { session_id: args.p_session_id, request_key: args.p_request_key, revision: 8 }, error: null });

test('shipped positional signature keeps requestKey and adds an explicit empty eighth RPC argument', () => {
  const oldCall = createSessionReservationIntent(ids.session, 7, ids.sede, { capacity: 4 }, [ids.member], {}, 'old-input', 'old-key');
  expect(oldCall.requestKey).toBe('old-key');
  expect(oldCall.input).toBe('old-input');
  expect(oldCall.args).toEqual({ p_session_id: ids.session, p_request_key: 'old-key', p_expected_revision: 7,
    p_sede_id: ids.sede, p_metadata: { capacity: 4 }, p_student_ids: [ids.member], p_gift_card_ids: {}, p_manual_credit_ids: {} });
});

test('manual and gift maps are separate complete frozen copies with no scalar balances or owner claims', () => {
  const manual = { [ids.member]: ids.original };
  const gift = { [ids.other]: ids.gift };
  const roster = [ids.other, ids.member];
  const result = createSessionReservationIntent(ids.session, 7, ids.sede, { capacity: 4 }, roster, gift, input, 'key', manual);
  manual[ids.member] = ids.replacement; delete gift[ids.other]; roster.pop();
  expect(result.args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original });
  expect(result.args.p_gift_card_ids).toEqual({ [ids.other]: ids.gift });
  expect(result.args.p_student_ids).toEqual([ids.member, ids.other]);
  expect(Object.isFrozen(result.args.p_manual_credit_ids)).toBe(true);
  expect(Object.isFrozen(manual)).toBe(false);
  expect(Object.keys(result.args).sort()).toEqual(['p_expected_revision', 'p_gift_card_ids', 'p_manual_credit_ids',
    'p_metadata', 'p_request_key', 'p_sede_id', 'p_session_id', 'p_student_ids']);
});

test('source maps reject names, non-roster IDs, empty sources and simultaneous gift/manual selection', () => {
  for (const map of [{ 'Alex Perez': ids.original }, { foreign: ids.original }, { [ids.member]: '' }, { [ids.member]: 3 }]) {
    expect(() => createSessionReservationIntent(ids.session, 7, ids.sede, {}, [ids.member], {}, input, 'key', map as Record<string, string>)).toThrow('IDs explicitos');
  }
  expect(() => createSessionReservationIntent(ids.session, 7, ids.sede, {}, [ids.member], { [ids.member]: ids.gift }, input,
    'key', { [ids.member]: ids.original })).toThrow('No combines');
  const homonyms = [ids.member, ids.other].map(id => ({ id, name: 'Alex', surname: 'Perez' })) as Student[];
  expect(resolveSessionStudentIds(homonyms, ['Alex Perez'], [ids.other])).toEqual([ids.other]);
  expect(() => resolveSessionStudentIds(homonyms, ['Alex Perez'])).toThrow('ambiguo');
});

test('manual map changes participate in pending identity; revision changes alone do not', () => {
  const first = { revision: 7, manualCreditIdByStudentId: { [ids.member]: ids.original, [ids.other]: 'other' } };
  expect(reservationInput(first)).toBe(reservationInput({ revision: 19, manualCreditIdByStudentId: { [ids.other]: 'other', [ids.member]: ids.original } }));
  for (const manualCreditIdByStudentId of [{}, { [ids.member]: ids.replacement }, { [ids.other]: ids.original }]) {
    expect(reservationInput({ ...first, manualCreditIdByStudentId })).not.toBe(reservationInput(first));
  }
});

test('stored pre-upgrade reservation replays unchanged missing manual arg using the backend default, not an overload', async () => {
  const store = new SessionIntentStore(storage());
  const original = JSON.parse(JSON.stringify(createSessionReservationIntent(ids.session, 7, ids.sede, {}, [ids.member], {}, 'old', 'old-key')));
  delete original.args.p_manual_credit_ids;
  store.set('legacy', original);
  const calls: unknown[] = [];
  await createSessionOperations({ store, refresh: async () => {}, rpc: async (name, args) => {
    calls.push({ name, args }); return receipt(args);
  } }).save('legacy', 'old', () => { throw new Error('Must not rebuild a shipped intent'); });
  expect(calls).toEqual([{ name: 'save_session_reservation', args: original.args }]);
  expect(store.get('legacy')).toBeNull();
});

for (const loss of ['transport', '08006', '57014']) test(`${loss} retains exact sources across store remount and blocks every source edit`, async () => {
  const persisted = storage();
  const store = new SessionIntentStore(persisted);
  const calls: any[] = [];
  let creates = 0;
  const first = createSessionOperations({ store, refresh: async () => {}, rpc: async (name, args) => {
    expect(store.get('reservation')?.args).toEqual(args);
    calls.push({ name, args });
    if (loss === 'transport') throw new Error('lost');
    return { data: null, error: { code: loss, message: 'lost' } };
  } });
  await expect(first.save('reservation', input, () => { creates++; return intent(); })).rejects.toThrow('lost');
  const retained = store.get('reservation');
  for (const changes of [{ manualCreditIdByStudentId: {} }, { manualCreditIdByStudentId: { [ids.member]: ids.replacement } },
    { manualCreditIdByStudentId: { [ids.other]: ids.original } }, { giftCardIdByStudentId: { [ids.member]: 'member-gift' } }]) {
    await expect(first.save('reservation', reservationInput(changes), () => { creates++; return intent('new-key'); })).rejects.toThrow('pendiente');
  }
  expect(calls).toHaveLength(1); expect(creates).toBe(1); expect(store.get('reservation')).toEqual(retained);
  let refreshes = 0;
  await createSessionOperations({ store: new SessionIntentStore(persisted), refresh: async () => { refreshes++; }, rpc: async (name, args) => {
    calls.push({ name, args }); return receipt(args);
  } }).save('reservation', input, () => { throw new Error('No new key, source or revision after remount'); });
  expect(calls[1]).toEqual(calls[0]); expect(refreshes).toBe(1);
});

for (const data of [null, {}, { session_id: 'wrong', request_key: 'original-key', revision: 8 },
  { session_id: ids.session, request_key: 'wrong', revision: 8 }, { session_id: ids.session, request_key: 'original-key', revision: '8' }]) {
  test(`invalid receipt ${JSON.stringify(data)} cannot clear the original manual reservation`, async () => {
    const store = new SessionIntentStore(storage());
    const operations = createSessionOperations({ store, refresh: async () => { throw new Error('Must not refresh'); }, rpc: async () => ({ data, error: null }) });
    await expect(operations.save('reservation', input, intent)).rejects.toThrow('comprobante');
    expect(store.get('reservation')).toEqual(intent());
  });
}

test('commit followed by reload loss retains source and receipt; retry is observational even after current state changes', async () => {
  const persisted = storage();
  const store = new SessionIntentStore(persisted);
  const calls: any[] = [];
  let reloadFails = true;
  let creates = 0;
  const operations = createSessionOperations({ store, refresh: async () => { if (reloadFails) throw new Error('reload lost'); }, rpc: async (name, args) => {
    calls.push({ name, args }); return receipt(args);
  } });
  await expect(operations.save('reservation', input, () => { creates++; return intent(); })).rejects.toThrow('reload lost');
  expect(store.get('reservation')?.args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original });
  reloadFails = false;
  await operations.save('reservation', input, () => { creates++; return intent('replacement-key'); });
  expect(creates).toBe(1); expect(calls[1]).toEqual(calls[0]); expect(store.get('reservation')).toBeNull();
});

for (const code of ['P0001', '42501', '40001']) test(`${code} is a proved rollback, never a funding fallback or automatic retry`, async () => {
  const store = new SessionIntentStore(storage());
  const calls: any[] = [];
  let refreshes = 0;
  await expect(createSessionOperations({ store, refresh: async () => { refreshes++; }, rpc: async (name, args) => {
    calls.push({ name, args }); return { data: null, error: { code, message: 'SQL rejected original source' } };
  } }).save('reservation', input, intent)).rejects.toMatchObject({ code });
  expect(calls).toEqual([{ name: 'save_session_reservation', args: intent().args }]);
  expect(refreshes).toBe(code === '40001' ? 1 : 0); expect(store.get('reservation')).toBeNull();
});

test('storage loss or corrupt recovery cannot launch a write with a manufactured new identity', async () => {
  for (const persisted of [
    { ...storage(), setItem: () => { throw new Error('storage unavailable'); } },
    { ...storage(), getItem: () => '{corrupt' }
  ]) {
    let writes = 0;
    const operations = createSessionOperations({ store: new SessionIntentStore(persisted), refresh: async () => {}, rpc: async (_name, args) => {
      writes++; return receipt(args);
    } });
    await expect(operations.save('reservation', input, intent)).rejects.toThrow(); expect(writes).toBe(0);
  }
});

test('attendance retains original sources outside its RPC and rejects manual funding on policy1', () => {
  const session: ClassSession = { id: ids.session, revision: 7, attendancePolicyVersion: 2, date: '2026-10-11',
    startTime: '10:00', endTime: '12:00', classType: 'mesa', students: ['Alex Perez'], studentIds: [ids.member],
    manualCreditIdByStudentId: { [ids.member]: ids.original } };
  const attendance = createSessionAttendanceIntent(session, [], { attendanceByStudentId: { [ids.member]: 'present' }, completedAt: 'now' }, 'attendance-key');
  expect(Object.keys(attendance.args).sort()).toEqual(['p_attendance', 'p_expected_revision', 'p_finalize', 'p_request_key', 'p_session_id', 'p_teacher_substitute_id']);
  expect(session.manualCreditIdByStudentId).toEqual({ [ids.member]: ids.original });
  expect(() => createSessionAttendanceIntent({ ...session, attendancePolicyVersion: 1 }, [], {})).toThrow('politica 2');
});

test.describe('production sessionOps wiring with isolated transport', () => {
  let server: ViteDevServer;
  let origin: string;
  test.beforeAll(async () => {
    server = await createServer({ configFile: false, envDir: false, root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir: join(tmpdir(), 'opencode', 'vite-session-manual-credit-ops'), plugins: [react(), manualCreditIsolationPlugin()],
      optimizeDeps: { entries: ['tests/fixtures/calendar-manual-credit-ui-harness.tsx'],
        include: ['react', 'react-dom/client', 'react-router-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
      server: { host: '127.0.0.1', port: 0, hmr: false } });
    await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
  });
  test.afterAll(async () => { await server?.close(); });
  test.beforeEach(async ({ page }) => {
    const violations: string[] = [];
    page.on('pageerror', error => violations.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      violations.push(route.request().url()); return route.abort();
    });
    await page.route('**/session-manual-credit-test', route => route.fulfill({ contentType: 'text/html', body: manualCreditHarnessHtml }));
    await page.exposeFunction('assertManualCreditIsolation', () => expect(violations).toEqual([]));
    await page.goto(`${origin}/session-manual-credit-test`);
    await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeVisible();
  });
  test.afterEach(async ({ page }) => { await page.evaluate(() => (window as any).assertManualCreditIsolation()); });
  const configure = (page: Page, value: Record<string, string>) => page.evaluate(value => window.dispatchEvent(new CustomEvent('manual-credit-configure', { detail: value })), value);
  const output = async (page: Page, id: string) => JSON.parse((await page.getByTestId(id).textContent())!);
  const invoke = (page: Page, action: string, data: Partial<ClassSession> = {}, id = ids.session) => page.evaluate(async ({ action, data, id }) => {
    try { await (window as any).__manualCreditHarness.call(action, data, id); return null; }
    catch (error: any) { return { message: error.message, code: error.code }; }
  }, { action, data, id });

  test('create sends explicit IDs/maps in one atomic RPC; absence never auto-selects loaded credits or legacy balance', async ({ page }) => {
    const draft = { date: '2026-10-11', startTime: '14:00', endTime: '16:00', classType: 'mesa' as const, students: ['Alex Perez'], studentIds: [ids.member], teacherId: 'teacher' };
    expect(await invoke(page, 'add', draft)).toBeNull();
    expect((await output(page, 'rpc-calls'))[0]).toMatchObject({ name: 'save_session_reservation', args: { p_student_ids: [ids.member], p_gift_card_ids: {}, p_manual_credit_ids: {} } });
    expect(await invoke(page, 'add', { ...draft, startTime: '16:00', endTime: '18:00', manualCreditIdByStudentId: { [ids.member]: ids.original } })).toBeNull();
    const calls = await output(page, 'rpc-calls');
    expect(calls).toHaveLength(2); expect(calls[1].args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original });
    expect(Object.keys(calls[1].args.p_metadata).sort()).toEqual(['capacity', 'class_type', 'date', 'end_time', 'start_time', 'teacher_id']);
    expect((await output(page, 'students'))[0]).toMatchObject({ classesRemaining: 91, legacyManualBalance: 87 });
  });

  test('partial reservation update preserves both complete loaded source maps without consulting availability', async ({ page }) => {
    await configure(page, { fixture: 'unavailable' });
    expect(await invoke(page, 'update', { capacity: 5 })).toBeNull();
    expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({ p_expected_revision: 7, p_gift_card_ids: { [ids.other]: ids.gift }, p_manual_credit_ids: { [ids.member]: ids.original } });
    expect((await output(page, 'sessions'))[0].manualCreditIdByStudentId).toEqual({ [ids.member]: ids.original });
  });

  test('roster removal prunes its source maps; cancellation tombstones keep ID and original source', async ({ page }) => {
    expect(await invoke(page, 'update', { studentIds: [ids.other], students: ['Alex Perez'] })).toBeNull();
    expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({ p_student_ids: [ids.other], p_manual_credit_ids: {}, p_gift_card_ids: { [ids.other]: ids.gift } });
    await configure(page, { fixture: 'cancelled' });
    expect(await invoke(page, 'update', { studentIds: [ids.other], students: ['Alex Perez'] })).toBeNull();
    expect((await output(page, 'rpc-calls'))[1].args).toMatchObject({ p_student_ids: [ids.member, ids.other], p_manual_credit_ids: { [ids.member]: ids.original } });
  });

  for (const fixture of ['completed', 'cancelled']) test(`${fixture} original source cannot be deleted, replaced or switched to gift`, async ({ page }) => {
    await configure(page, { fixture });
    for (const data of [{ manualCreditIdByStudentId: {} }, { manualCreditIdByStudentId: { [ids.member]: ids.replacement } },
      { manualCreditIdByStudentId: {}, giftCardIdByStudentId: { [ids.member]: 'member-gift' } }]) {
      expect((await invoke(page, 'update', data))?.message).toContain('inmutable');
    }
    expect(await output(page, 'rpc-calls')).toEqual([]);
    expect(await invoke(page, 'update', { capacity: 5 })).toBeNull();
    expect((await output(page, 'rpc-calls'))[0].args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original });
  });

  test('policy1 rejects manual create, update and attendance without touching the RPC', async ({ page }) => {
    await configure(page, { fixture: 'policy1-manual' });
    expect((await invoke(page, 'update', { capacity: 5 }))?.message).toContain('politica 2');
    expect((await invoke(page, 'update', { attendanceByStudentId: { [ids.member]: 'present' } }))?.message).toContain('politica 2');
    expect((await invoke(page, 'add', { attendancePolicyVersion: 1, studentIds: [ids.member], students: ['Alex Perez'], manualCreditIdByStudentId: { [ids.member]: ids.original } }))?.message).toContain('politica 2');
    expect(await output(page, 'rpc-calls')).toEqual([]);
  });

  test('homonym names cannot retarget reservation or map; gift/manual replacement must clear the other complete map', async ({ page }) => {
    expect((await invoke(page, 'update', { students: ['Alex Perez'] }))?.message).toContain('ambiguo');
    expect((await invoke(page, 'update', { manualCreditIdByStudentId: { 'Alex Perez': ids.original } }))?.message).toContain('fuera del roster');
    expect((await invoke(page, 'update', { giftCardIdByStudentId: { [ids.member]: 'member-gift' } }))?.message).toContain('No combines');
    expect(await output(page, 'rpc-calls')).toEqual([]);
    expect(await invoke(page, 'update', { giftCardIdByStudentId: { [ids.member]: 'member-gift', [ids.other]: ids.gift }, manualCreditIdByStudentId: {} })).toBeNull();
    expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({ p_manual_credit_ids: {}, p_gift_card_ids: { [ids.member]: 'member-gift', [ids.other]: ids.gift } });
  });

  for (const behavior of ['transport', 'lost-response', 'refresh-failure']) test(`${behavior} update recovery blocks source and operation changes and never advances its frozen revision`, async ({ page }) => {
    await configure(page, { behavior });
    expect(await invoke(page, 'update', { capacity: 5, manualCreditIdByStudentId: { [ids.member]: ids.replacement } })).not.toBeNull();
    const original = (await output(page, 'rpc-calls'))[0];
    expect(original.args).toMatchObject({ p_expected_revision: 7, p_manual_credit_ids: { [ids.member]: ids.replacement }, p_gift_card_ids: { [ids.other]: ids.gift } });
    expect((await invoke(page, 'update', { manualCreditIdByStudentId: { [ids.member]: ids.original } }))?.message).toContain('pendiente');
    expect((await invoke(page, 'update', { attendanceByStudentId: { [ids.member]: 'present' } }))?.message).toContain('pendiente');
    const descriptor = await page.evaluate(id => {
      const api = (window as any).__manualCreditHarness; return api.ops.getPendingSessionOperation(api.context(), id);
    }, ids.session);
    expect(descriptor).toMatchObject({ requestKey: original.args.p_request_key, expectedRevision: 7, operation: 'reservation' });
    expect(await output(page, 'rpc-calls')).toHaveLength(1);
    await configure(page, { behavior: 'success', fixture: 'roll-forward' });
    const retried = await invoke(page, 'retry');
    if (behavior === 'transport') expect(retried?.code).toBe('40001');
    else expect(retried).toBeNull();
    const writes = await output(page, 'rpc-calls'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(original);
    expect(await output(page, 'commits')).toHaveLength(behavior === 'transport' ? 0 : 1);
    expect(await page.evaluate(id => sessionStorage.getItem(`atomic-session-intent:${(window as any).__manualCreditHarness.context().sedeId}:${id}`), ids.session)).toBeNull();
  });

  for (const behavior of ['transport', 'lost-response', 'refresh-failure']) test(`${behavior} production recovery keeps exact create key, source and metadata across newer state`, async ({ page }) => {
    await configure(page, { behavior });
    const draft = { date: '2026-10-11', startTime: '14:00', endTime: '16:00', classType: 'mesa' as const,
      studentIds: [ids.member], students: ['Alex Perez'], teacherId: 'teacher', manualCreditIdByStudentId: { [ids.member]: ids.original } };
    expect(await invoke(page, 'add', draft)).not.toBeNull();
    const original = (await output(page, 'rpc-calls'))[0];
    const descriptor = await page.evaluate(() => { const api = (window as any).__manualCreditHarness; return api.ops.getPendingSessionOperation(api.context()); });
    expect(descriptor).toMatchObject({ requestKey: original.args.p_request_key, sessionId: original.args.p_session_id, isNewSession: true });
    expect((await invoke(page, 'add', { ...draft, manualCreditIdByStudentId: { [ids.member]: ids.replacement } }))?.message).toContain('pendiente');
    await configure(page, { fixture: 'roll-forward', behavior: 'success' });
    expect(await invoke(page, 'retry', {}, '')).toBeNull();
    const writes = await output(page, 'rpc-calls'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(original);
    expect(await output(page, 'commits')).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem(`atomic-session-intent:${(window as any).__manualCreditHarness.context().sedeId}:new-session`))).toBeNull();
  });
});
