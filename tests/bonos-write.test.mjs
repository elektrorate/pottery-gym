import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the shipped handler and real authentication/serialization in memory.
// Only the Supabase transport is replaced; no env file, database or network is used.
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['supabase/functions/bonos-write/index.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'offline-supabase', setup(builder) {
    builder.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: 'supabase', namespace: 'offline' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: `
      export const createClient = () => { globalThis.__bonosHarness.clients++; return globalThis.__bonosHarness.client; };
    `, loader: 'js' }));
  } }]
});
let handler;
let env;
let harness;
globalThis.Deno = { env: { get: key => env[key] }, serve: callback => { handler = callback; } };
await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const sede = '00000000-0000-0000-0000-000000000001';
const foreign = '00000000-0000-0000-0000-000000000002';
const cardId = '10000000-0000-0000-0000-000000000001';
const studentId = '20000000-0000-0000-0000-000000000001';
const otherStudent = '20000000-0000-0000-0000-000000000002';
const sessionId = '30000000-0000-0000-0000-000000000001';
const key = '40000000-0000-0000-0000-000000000001';
const row = () => ({ id: cardId, sede_id: sede, recipient: 'Alex Perez', recipient_student_id: studentId,
  buyer: 'Buyer', buyer_phone: '555', buyer_email: 'buyer@example.test', recipient_email: 'alex@example.test',
  internal_notes: 'Legacy private note', external_metadata: { legacy: true }, num_classes: 2, type: 'modelado',
  payment_status: 'paid', status: 'active', sessions_used: 0, expiry_date: '2027-04-11', created_at: '2026-10-11T12:00:00Z' });
beforeEach(() => {
  env = { BONOS_WRITES_ENABLED: 'true', BONOS_WRITE_API_KEY: 'offline-key', BONOS_API_SEDE_ID: sede,
    SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' };
  harness = { clients: 0, calls: [], writes: [], rpcCalls: [], card: row(), active: true,
    students: new Map([[studentId, sede], [otherStudent, foreign]]) };
  harness.client = {
    from(table) {
      const call = { table, filters: [] }; harness.calls.push(call);
      const query = {
        select(columns) { call.select = columns; return query; },
        eq(column, value) { call.filters.push([column, value]); return query; },
        insert(payload) { call.insert = payload; harness.writes.push(call); return query; },
        update(payload) { call.update = payload; harness.writes.push(call); return query; },
        async maybeSingle() {
          const filter = Object.fromEntries(call.filters);
          const data = table === 'sedes' ? harness.active && filter.id === sede && filter.is_active === true ? { id: sede } : null
            : table === 'students' ? harness.students.get(filter.id) === filter.sede_id ? { id: filter.id } : null
            : filter.id === harness.card.id && filter.sede_id === harness.card.sede_id ? harness.card : null;
          return { data, error: null };
        },
        async single() {
          if (harness.writeError) return { data: null, error: harness.writeError };
          harness.card = { ...harness.card, ...(call.insert || call.update) };
          return { data: harness.card, error: null };
        }
      };
      return query;
    },
    async rpc(name, args) {
      harness.rpcCalls.push({ name, args });
      if (harness.rpcError) return { data: null, error: harness.rpcError };
      if (args.p_sede_id !== harness.card.sede_id || args.p_gift_card_id !== cardId) return { data: null, error: { message: 'No autorizado para este bono' } };
      return { data: harness.card, error: null };
    }
  };
  globalThis.__bonosHarness = harness;
});
const send = (action, data, headers = {}) => handler(new Request('http://offline.invalid/bonos-write', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'offline-key', ...headers }, body: JSON.stringify({ action, data })
}));
const create = changes => ({ buyer: 'Buyer', recipient: 'Alex Perez', recipientStudentId: studentId, numClasses: 2, ...changes });
const session = changes => ({ id: cardId, sessionId, studentId, idempotencyKey: key, ...changes });

test('disabled by default; only literal true opens the authenticated writer', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', ' true ']) {
    env.BONOS_WRITES_ENABLED = value;
    assert.equal((await send('create', create())).status, 403);
    for (const action of ['redeem', 'reverse']) assert.equal((await send(action, session())).status, 403);
  }
  assert.equal(harness.clients, 0);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.rpcCalls.length, 0);
  env.BONOS_WRITES_ENABLED = 'true';
  assert.equal((await send('create', create(), { 'x-api-key': 'wrong' })).status, 401);
  assert.equal(harness.clients, 0);
});
test('method/preflight do not execute writes and allow explicit key header', async () => {
  const preflight = await handler(new Request('http://offline.invalid', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 200);
  assert.match(preflight.headers.get('access-control-allow-headers'), /idempotency-key/);
  assert.equal((await handler(new Request('http://offline.invalid'))).status, 405);
  assert.equal(harness.clients, 0);
});
test('create requires explicit authorized identity without matching/creating any person', async () => {
  assert.equal((await send('create', create({ recipientStudentId: undefined }))).status, 400);
  assert.equal((await send('create', create({ recipientStudentId: otherStudent }))).status, 403);
  assert.equal(harness.writes.length, 0);
  assert.equal((await send('create', create())).status, 201);
  assert.equal(harness.writes[0].insert.recipient_student_id, studentId);
  assert.equal(harness.writes[0].insert.sede_id, sede);
  for (const field of ['sessions_used', 'status', 'expiry_date']) assert.ok(!(field in harness.writes[0].insert));
  assert.ok(harness.writes.every(call => call.table === 'gift_cards'));
  assert.ok(harness.calls.filter(call => call.table === 'students').every(call => call.select === 'id' && call.filters.some(([field]) => field === 'sede_id')));
});
test('display edit preserves recipient link; changing identity validates the same sede', async () => {
  assert.equal((await send('update', { id: cardId, recipient: 'Edited label' })).status, 200);
  assert.deepEqual(harness.writes[0].update, { recipient: 'Edited label' });
  assert.equal(harness.card.recipient_student_id, studentId);
  assert.deepEqual(harness.writes[0].filters, [['id', cardId], ['sede_id', sede]]);
  for (const id of [null, '', otherStudent]) assert.ok((await send('update', { id: cardId, recipientStudentId: id })).status >= 400);
  assert.equal(harness.writes.length, 1);
});
test('metadata edit preserves explicit recipient ID and all protected projections', async () => {
  const previous = structuredClone(harness.card);
  const metadata = { externalOrder: 'synthetic-order' };
  const response = await send('update', { id: cardId, metadata });
  assert.equal(response.status, 200);
  assert.deepEqual(harness.writes[0].update, { external_metadata: metadata });
  assert.deepEqual(harness.writes[0].filters, [['id', cardId], ['sede_id', sede]]);
  assert.deepEqual(harness.card, { ...previous, external_metadata: metadata });
  assert.equal((await response.json()).data.recipientStudentId, studentId);
  assert.equal(harness.rpcCalls.length, 0);
});
test('legacy identity is not inferred, while unrelated legacy metadata remains editable', async () => {
  harness.card.recipient_student_id = null;
  assert.equal((await send('update', { id: cardId, recipient: 'Alex' })).status, 400);
  assert.equal((await send('update', { id: cardId, dedication: 'Hello' })).status, 200);
  assert.equal(harness.card.recipient_student_id, null);
  assert.equal((await send('update', { id: cardId, recipient: 'Alex', recipientStudentId: studentId })).status, 200);
});
test('protected projections/payment and arbitrary tenant/identity payloads fail before mutations', async () => {
  for (const field of ['paymentStatus', 'status', 'sessionsUsed', 'sessionsRemaining', 'consumedAt', 'expiryDate', 'sedeId', 'sede_id', 'id']) {
    assert.equal((await send('create', create({ [field]: 'arbitrary' }))).status, 400);
    if (field !== 'id') assert.equal((await send('update', { id: cardId, [field]: 'arbitrary' })).status, 400);
  }
  assert.equal((await send('confirmPayment', { id: cardId })).status, 400);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.rpcCalls.length, 0);
});
test('invalid allocation, dates, format, numeric input, JSON shape fail closed', async () => {
  for (const changes of [{ numClasses: true }, { numClasses: 1.5 }, { numClasses: 0 }, { validityMonths: 4 },
    { activatedAt: '2026-02-30' }, { price: 'Infinity' }, { price: -1 }, { price: '' },
    { deliveryFormat: 'anything' }, { type: 'anything' }, { metadata: [] }, { paymentStatus: 'refunded' }]) {
    assert.equal((await send('create', create(changes))).status, 400);
  }
  assert.equal((await send('update', [])).status, 400);
  assert.equal((await handler(new Request('http://offline.invalid', { method: 'POST', headers: { 'x-api-key': 'offline-key' }, body: 'broken' }))).status, 400);
  assert.equal((await send(undefined, {})).status, 400);
  assert.equal(harness.writes.length, 0);
});
test('inactive sede/foreign card cannot mutate even with a valid API key', async () => {
  harness.active = false;
  assert.equal((await send('create', create())).status, 403);
  harness.active = true;
  harness.card.sede_id = foreign;
  assert.equal((await send('update', { id: cardId, dedication: 'Hello' })).status, 404);
  assert.equal((await send('cancel', { id: cardId })).status, 403);
  assert.equal(harness.writes.length, 0);
});
test('redeem/reverse always deny with normalized atomic-flow guidance even when writes are enabled', async () => {
  const previous = structuredClone(harness.card);
  for (const action of ['redeem', 'reverse']) {
    for (const data of [session(), session({ idempotencyKey: undefined }), session({ idempotencyKey: '' }),
      session({ idempotencyKey: 'not-a-uuid' }), session({ id: foreign, studentId: otherStudent }), {}, []]) {
      const response = await send(action, data);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'Standalone gift card redeem/reverse is disabled. Use the revision-aware atomic session flow.' });
    }
  }
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.rpcCalls.length, 0);
  assert.equal(harness.writes.length, 0);
  assert.deepEqual(harness.card, previous);
});
test('keys, retries and revoked RPC availability cannot re-enable standalone session mutations', async () => {
  harness.rpcError = { message: 'permission denied for function external_redeem_gift_card_session_once', code: '42501' };
  for (const action of ['redeem', 'reverse']) {
    for (const headers of [{ 'Idempotency-Key': key }, { 'Idempotency-Key': 'different' }]) {
      const first = await send(action, session(), headers);
      const retry = await send(action, session(), headers);
      assert.equal(first.status, 403);
      assert.equal(retry.status, 403);
      assert.deepEqual(await first.json(), await retry.json());
    }
  }
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.rpcCalls.length, 0);
  assert.equal(harness.writes.length, 0);
});
test('consume/cancel retain scoped lifecycle RPCs with server date, not direct balance writes', async () => {
  assert.equal((await send('consume', { giftCardId: cardId })).status, 200);
  assert.deepEqual(harness.rpcCalls[0], { name: 'external_consume_gift_card', args: { p_sede_id: sede, p_gift_card_id: cardId, p_consumed_at: null } });
  assert.equal((await send('cancel', { id: cardId })).status, 200);
  assert.deepEqual(harness.rpcCalls[1], { name: 'external_cancel_gift_card', args: { p_sede_id: sede, p_gift_card_id: cardId } });
  assert.equal(harness.writes.length, 0);
});
test('manual consume/cancel retain the same feature gate, API key, active sede and card-sede authorization', async () => {
  env.BONOS_WRITES_ENABLED = undefined;
  for (const action of ['consume', 'cancel']) assert.equal((await send(action, { id: cardId })).status, 403);
  assert.equal(harness.clients, 0);
  env.BONOS_WRITES_ENABLED = 'true';
  for (const action of ['consume', 'cancel']) assert.equal((await send(action, { id: cardId }, { 'x-api-key': 'wrong' })).status, 401);
  assert.equal(harness.clients, 0);
  harness.active = false;
  for (const action of ['consume', 'cancel']) assert.equal((await send(action, { id: cardId })).status, 403);
  assert.equal(harness.rpcCalls.length, 0);
  harness.active = true;
  harness.card.sede_id = foreign;
  for (const action of ['consume', 'cancel']) {
    assert.equal((await send(action, { id: cardId })).status, 403);
    assert.equal(harness.rpcCalls.at(-1).args.p_sede_id, sede);
  }
  assert.equal(harness.rpcCalls.length, 2);
  assert.equal(harness.writes.length, 0);
});
test('manual consume/cancel RPC failures never fall back to direct projection writes', async () => {
  harness.rpcError = { code: 'PGRST202', message: 'RPC unavailable' };
  const previous = structuredClone(harness.card);
  for (const action of ['consume', 'cancel']) {
    const response = await send(action, { id: cardId });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'RPC unavailable' });
  }
  assert.equal(harness.rpcCalls.length, 2);
  assert.equal(harness.writes.length, 0);
  assert.deepEqual(harness.card, previous);
});
test('legacy public fields stay compatible pending privacy matrix; duplicate conflicts do not retry/create another card', async () => {
  const response = await (await send('update', { id: cardId, dedication: 'Hello' })).json();
  assert.equal(response.data.buyerPhone, '555');
  assert.equal(response.data.buyerEmail, 'buyer@example.test');
  assert.equal(response.data.internalNotes, 'Legacy private note');
  assert.deepEqual(response.data.metadata, { legacy: true });
  harness.writeError = { code: '23505', message: 'duplicate code' };
  assert.equal((await send('create', create({ code: 'existing' }))).status, 409);
  assert.equal(harness.writes.length, 2);
});
