import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// In-memory bundle only. No server, browser, environment file or remote I/O.
const root = fileURLToPath(new URL('../', import.meta.url));
const mocks = fileURLToPath(new URL('./fixtures/gift-card-ops-mocks.ts', import.meta.url));
const bundled = await build({
  absWorkingDir: root, entryPoints: ['context/data/giftCardOps.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'gift-card-test-boundaries', setup(builder) {
    builder.onResolve({ filter: /supabaseClient$|\/toast$/ }, () => ({ path: mocks }));
  } }]
});
const ops = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const base = { id: 'card', buyer: 'Buyer', recipient: 'Alex Perez', recipient_student_id: 'member',
  num_classes: 2, type: 'modelado', status: 'active', payment_status: 'paid', sessions_used: 0,
  expiry_date: '2028-04-30', created_at: '2026-10-11T12:00:00Z' };
let harness;
let ctx;
let cards;
beforeEach(() => {
  cards = [{ id: 'card', buyer: 'Buyer', recipient: 'Alex Perez', recipientStudentId: 'member',
    numClasses: 2, type: 'modelado', status: 'active', sessionsUsed: 0, expiryDate: '2099-01-01' }];
  harness = {
    calls: [], errors: [], warnings: [], result: { data: base, error: null },
    from(table) {
      const call = { table, filters: [] }; this.calls.push(call);
      const query = {
        insert(payload) { call.insert = payload; return query; },
        update(payload) { call.update = payload; return query; },
        delete() { call.delete = true; return query; },
        select() { return query; },
        eq(key, value) { call.filters.push([key, value]); return query; },
        single() { return harness.respond?.() ?? Promise.resolve(harness.result); },
        maybeSingle() { return Promise.resolve(harness.result); }
      };
      return query;
    },
    rpc(name, args) { this.calls.push({ name, args }); return this.respond?.() ?? Promise.resolve(this.result); }
  };
  globalThis.__giftCardHarness = harness;
  ctx = { sedeId: 'tenant', students: [
    { id: 'member', name: 'Alex', surname: 'Perez', studentCategory: 'membresia' },
    { id: 'temporary', name: 'Alex', surname: 'Perez', studentCategory: 'temporal' }
  ], giftCards: cards, setGiftCards(update) { cards = update(cards); },
    setStudents() { throw new Error('Gift cards must never create or rewrite a person'); },
    reloads: 0, async safeReload() { this.reloads++; } };
  ctx.safeReload = ctx.safeReload.bind(ctx);
});
const newCard = updates => ({ buyer: 'Buyer', recipient: 'Alex Perez', numClasses: 2, type: 'modelado', ...updates });

test('explicit member survives duplicate names/category without any student query', async () => {
  await ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member', expiryDate: '2099-01-01' }));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].table, 'gift_cards');
  assert.equal(harness.calls[0].insert.recipient_student_id, 'member');
  assert.ok(!('expiry_date' in harness.calls[0].insert));
  assert.ok(!('activated_at' in harness.calls[0].insert));
  assert.ok(!('sessions_used' in harness.calls[0].insert));
  assert.equal(cards[0].expiryDate, '2028-04-30');
});
test('missing identity never resolves even unique legacy names or auto-creates duplicates', async () => {
  for (const students of [ctx.students, ctx.students.slice(0, 1), []]) {
    ctx.students = students;
    await assert.rejects(ops.addGiftCard(ctx, newCard()), /Selecciona la sede y el destinatario/);
  }
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.errors.length, 3);
});
test('missing sede and invented consumption fail before any write', async () => {
  ctx.sedeId = null;
  await assert.rejects(ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member' })), /Selecciona la sede/);
  ctx.sedeId = 'tenant';
  await assert.rejects(ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member', sessionsUsed: 1 })), /historial de consumo/);
  assert.equal(harness.calls.length, 0);
});
test('display-name edit preserves explicit identity and uses authoritative RETURNING', async () => {
  harness.result.data = { ...base, recipient: 'display changed' };
  await ops.updateGiftCard(ctx, 'card', { recipient: 'display changed' }, cards);
  assert.deepEqual(harness.calls[0].update, { recipient: 'display changed' });
  assert.equal(cards[0].recipientStudentId, 'member');
  assert.equal(cards[0].expiryDate, '2028-04-30');
});
test('clearing identity or editing a legacy name without explicit identity is rejected', async () => {
  await assert.rejects(ops.updateGiftCard(ctx, 'card', { recipientStudentId: undefined }, cards), /identidad explicita/);
  cards[0].recipientStudentId = undefined;
  await assert.rejects(ops.updateGiftCard(ctx, 'card', { recipient: 'Alex' }, cards), /Selecciona el destinatario/);
  assert.equal(harness.calls.length, 0);
});
test('expiry-only override is rejected; validity edit sends no client expiry drift', async () => {
  await assert.rejects(ops.updateGiftCard(ctx, 'card', { expiryDate: '2099-02-01' }, cards), /caducidad se calcula/);
  assert.equal(harness.calls.length, 0);
  await ops.updateGiftCard(ctx, 'card', { validityMonths: 3, activatedAt: '2028-01-31', expiryDate: '2028-05-01' }, cards);
  assert.deepEqual(harness.calls[0].update, { validity_months: 3, activated_at: '2028-01-31' });
  assert.equal(cards[0].expiryDate, '2028-04-30');
});
test('failed update cannot optimistically change recipient/category/balance', async () => {
  const original = structuredClone(cards);
  harness.result = { data: null, error: { code: '23514', message: 'foreign recipient' } };
  await assert.rejects(ops.updateGiftCard(ctx, 'card', { recipientStudentId: 'foreign' }, cards),
    { code: '23514', message: 'foreign recipient' });
  assert.deepEqual(cards, original);
  assert.equal(harness.errors.length, 1);
});
// Pre-rollout operation units only. Standalone gift session RPCs are revoked
// by the atomic attendance migration and are not exercised as live UI writers.
test('legacy reverse lookup failure is not silently treated as a missing link', async () => {
  harness.result = { data: null, error: { message: 'lookup unavailable' } };
  await assert.rejects(ops.reverseGiftCardSession(ctx, '', 'session', 'member'), /lookup unavailable/);
  assert.equal(harness.calls.length, 1);
});
test('delete uses cancellation and never erases card or ledger history', async () => {
  harness.result.data = { ...base, status: 'cancelled' };
  await ops.deleteGiftCard(ctx, 'card');
  assert.deepEqual(harness.calls, [{ name: 'cancel_gift_card', args: { p_gift_card_id: 'card' } }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'cancelled');
});
test('manual consumption defaults to the server date, not a client clock', async () => {
  await ops.consumeGiftCard(ctx, 'card');
  assert.equal(harness.calls[0].args.p_consumed_at, null);
});
test('validation rejects awaited UI saves instead of falsely closing the form', async () => {
  for (const save of [() => ops.addGiftCard(ctx, newCard()),
    () => ops.updateGiftCard(ctx, 'card', { recipientStudentId: undefined }, cards),
    () => ops.updateGiftCard(ctx, '', { buyer: 'Edited' }, cards),
    () => ops.updateGiftCard(ctx, 'card', { sessionsUsed: 1 }, cards)]) {
    let closed = false;
    await assert.rejects(async () => { await save(); closed = true; }, error => error instanceof Error);
    assert.equal(closed, false);
  }
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.errors.length, 4);
});
test('backend failures retain the original SQL error and keep awaited add/update forms open', async () => {
  const failure = { code: '23514', message: 'gift card invariant rejected', details: 'recipient mismatch', hint: 'Select an explicit ID' };
  harness.result = { data: null, error: failure };
  const original = structuredClone(cards);
  for (const save of [() => ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member' })),
    () => ops.updateGiftCard(ctx, 'card', { buyer: 'Edited' }, cards)]) {
    let closed = false;
    await assert.rejects(async () => { await save(); closed = true; }, error => error === failure);
    assert.equal(closed, false);
  }
  assert.deepEqual(cards, original);
  assert.equal(ctx.reloads, 0);
  assert.equal(harness.errors.length, 2);
});
test('uncertain timeout rejects add/update without pretending reload confirmed the write', async () => {
  const failure = Object.assign(new Error('write timeout; outcome unknown'), { code: '57014' });
  harness.respond = async () => { throw failure; };
  const original = structuredClone(cards);
  for (const save of [() => ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member' })),
    () => ops.updateGiftCard(ctx, 'card', { buyer: 'Edited' }, cards)]) {
    let closed = false;
    await assert.rejects(async () => { await save(); closed = true; }, error => error === failure);
    assert.equal(closed, false);
  }
  assert.deepEqual(cards, original);
  assert.equal(ctx.reloads, 0);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.errors.length, 2);
  assert.equal(harness.warnings.length, 0);
});
test('successful add/update stay pending until authoritative reload finishes', async () => {
  for (const save of [() => ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member' })),
    () => ops.updateGiftCard(ctx, 'card', { buyer: 'Edited' }, cards)]) {
    let release;
    let reloadStarted = false;
    let closed = false;
    const gate = new Promise(resolve => { release = resolve; });
    ctx.safeReload = async () => { reloadStarted = true; await gate; };
    const saving = (async () => { await save(); closed = true; })();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reloadStarted, true);
    assert.equal(closed, false);
    release();
    await saving;
    assert.equal(closed, true);
  }
});
test('reload failure rejects completed writes without reverting authoritative rows or closing the form', async () => {
  const failure = new Error('authoritative reload failed');
  ctx.safeReload = async () => { throw failure; };
  harness.result = { data: { ...base, id: 'created-card' }, error: null };
  let closed = false;
  await assert.rejects(async () => {
    await ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member' })); closed = true;
  }, error => error === failure);
  assert.equal(closed, false);
  assert.equal(cards[0].id, 'created-card');
  harness.result = { data: { ...base, buyer: 'Server buyer', recipient: 'Server display' }, error: null };
  await assert.rejects(async () => {
    await ops.updateGiftCard(ctx, 'card', { buyer: 'Submitted buyer' }, cards); closed = true;
  }, error => error === failure);
  assert.equal(closed, false);
  assert.equal(cards.find(card => card.id === 'card').buyer, 'Server buyer');
  assert.equal(cards.find(card => card.id === 'card').recipientStudentId, 'member');
  assert.equal(harness.errors.length, 2);
});
test('missing returned rows reject add/update rather than report unconfirmed success', async () => {
  harness.result = { data: null, error: null };
  await assert.rejects(ops.addGiftCard(ctx, newCard({ recipientStudentId: 'member' })), /no devolvio/);
  await assert.rejects(ops.updateGiftCard(ctx, 'card', { buyer: 'Edited' }, cards), /no devolvio/);
  assert.equal(ctx.reloads, 0);
  assert.equal(harness.errors.length, 2);
});
// The following keyed-wrapper units also describe pre-rollout behavior only.
test('keyed intent is immutable, validates identities and reuses exact args after timeout', async () => {
  assert.throws(() => ops.createGiftCardSessionIntent('', 'session', 'member'));
  const intent = ops.createGiftCardSessionIntent('card', 'session', 'member');
  assert.ok(Object.isFrozen(intent));
  let attempts = 0;
  harness.respond = async () => { if (++attempts === 1) throw new Error('timeout'); return harness.result; };
  await assert.rejects(ops.applyGiftCardSessionIntent(ctx, intent), /timeout/);
  await ops.applyGiftCardSessionIntent(ctx, intent);
  assert.deepEqual(harness.calls[0], harness.calls[1]);
  assert.equal(harness.calls[1].name, 'redeem_gift_card_session_once');
  assert.equal(harness.calls[1].args.p_request_key, intent.requestKey);
});
test('historical receipt is returned but never overwrites current card state', async () => {
  harness.result.data = { ...base, sessions_used: 1 };
  ctx.safeReload = async () => { cards[0].sessionsUsed = 0; };
  const intent = ops.createGiftCardSessionIntent('card', 'session', 'member', true);
  const receipt = await ops.applyGiftCardSessionIntent(ctx, intent);
  assert.equal(receipt.sessionsUsed, 1);
  assert.equal(cards[0].sessionsUsed, 0);
  assert.equal(harness.calls[0].name, 'reverse_gift_card_session_once');
});
test('missing RPC/receipt and refresh failure fail closed with no direct-write fallback', async () => {
  const intent = ops.createGiftCardSessionIntent('card', 'session', 'member');
  harness.result = { data: null, error: { code: 'PGRST202', message: 'RPC unavailable' } };
  await assert.rejects(ops.applyGiftCardSessionIntent(ctx, intent), { code: 'PGRST202', message: 'RPC unavailable' });
  harness.result = { data: null, error: null };
  await assert.rejects(ops.applyGiftCardSessionIntent(ctx, intent), /recibo/);
  harness.result = { data: base, error: null };
  ctx.safeReload = async () => { throw new Error('reload failed'); };
  await assert.rejects(ops.applyGiftCardSessionIntent(ctx, intent), /reload failed/);
  assert.ok(harness.calls.every(call => call.name === 'redeem_gift_card_session_once'));
});
