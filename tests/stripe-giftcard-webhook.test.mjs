import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['supabase/functions/_shared/stripe-giftcard.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'offline-supabase', setup(builder) {
    builder.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: 'supabase', namespace: 'offline' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: `
      export const createClient = () => ({});
    `, loader: 'js' }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const SECRET = 'whsec_test_only';
const NOW = new Date('2026-11-18T14:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const sede = '30000000-0000-0000-0000-000000000001';
const asistontoKey = randomBytes(32).toString('hex');
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const giftSession = (overrides = {}) => ({
  id: 'cs_test_gift_1',
  object: 'checkout.session',
  mode: 'payment',
  status: 'complete',
  payment_status: 'paid',
  payment_link: 'plink_1UVWN2G3M5SYIufukKlvIxEH',
  created: NOW_S - 60,
  amount_total: 7500,
  currency: 'eur',
  metadata: { amount_eur: '75', classes: '2', gift_format: 'virtual', source: 'casa_rosier_web' },
  customer_details: { name: 'Ana Compradora', email: 'ana@example.com', phone: '+34600111222' },
  custom_fields: [
    { key: 'destinatario', type: 'text', text: { value: 'Juan Pérez' } },
    { key: 'dedicatoria', type: 'text', text: { value: 'Feliz cumpleaños' } }
  ],
  ...overrides
});

const eventFor = (session, type = 'checkout.session.completed', id = 'evt_1') => ({
  id, type, data: { object: session }
});

const rowFromCard = (card, extraMeta = {}) => ({
  id: 'id-' + card.code,
  sede_id: sede,
  code: card.code,
  buyer: card.buyer,
  buyer_phone: card.buyer_phone,
  buyer_email: card.buyer_email,
  recipient: card.recipient,
  num_classes: card.num_classes,
  type: card.type,
  price: card.price,
  payment_status: card.payment_status,
  status: 'active',
  delivery_format: card.delivery_format,
  dedication: card.dedication,
  expiry_date: '2027-11-18',
  created_at: NOW.toISOString(),
  external_metadata: { ...card.external_metadata, ...extraMeta }
});

const makeStore = () => {
  const byCode = new Map();
  const store = {
    creates: [],
    updates: [],
    async createWithTemporalStudent(card, student) {
      store.creates.push({ card, student });
      if (byCode.has(card.code)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "gift_cards_code_unique_idx"' } };
      const row = rowFromCard(card);
      row.created_at = new Date(NOW.getTime() + byCode.size * 1000).toISOString();
      byCode.set(card.code, row);
      return { data: row, error: null };
    },
    async readByCode(code) {
      return { data: byCode.get(String(code).toUpperCase()) || null, error: null };
    },
    async readByStripeSessionId(sessionId) {
      const row = [...byCode.values()].find((item) => item.external_metadata?.stripeSessionId === sessionId) || null;
      return { data: row, error: null };
    },
    async listRecent() {
      return { data: [...byCode.values()].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)), error: null };
    },
    async updateMetadata(id, metadata) {
      const row = [...byCode.values()].find((item) => item.id === id);
      if (row) row.external_metadata = metadata;
      store.updates.push({ id, metadata });
      return { error: null };
    },
    seed(row) { byCode.set(row.code, row); }
  };
  return store;
};

const depsFor = (store, extra = {}) => ({
  store,
  fetchSession: async () => null,
  allowlist: api.DEFAULT_GIFT_CARD_PAYMENT_LINKS,
  now: () => NOW,
  notify: async () => ({ status: 'skipped', reason: 'no url' }),
  ...extra
});

const sendWebhook = async (event, store, secret = SECRET, signature) => {
  const raw = JSON.stringify(event);
  const header = signature === undefined ? await api.signStripePayload(raw, SECRET, NOW_S) : signature;
  return api.handleStripeWebhook(raw, header, depsFor(store), secret);
};

test('verifyStripeSignature accepts a valid v1 signature and rejects tampering', async () => {
  const raw = '{"id":"evt_1"}';
  const header = await api.signStripePayload(raw, SECRET, NOW_S);
  assert.equal(await api.verifyStripeSignature(raw, header, SECRET, NOW_S), true);
  assert.equal(await api.verifyStripeSignature(`${raw} `, header, SECRET, NOW_S), false);
  assert.equal(await api.verifyStripeSignature(raw, header, 'whsec_other', NOW_S), false);
  assert.equal(await api.verifyStripeSignature(raw, header, SECRET, NOW_S + 301), false);
  assert.equal(await api.verifyStripeSignature(raw, null, SECRET, NOW_S), false);
});

test('classifyGiftCardSession accepts the 8 gift-card links and rejects the rest', () => {
  assert.equal(api.DEFAULT_GIFT_CARD_PAYMENT_LINKS.length, 8);
  assert.deepEqual(api.classifyGiftCardSession(giftSession()), { giftCard: true, classes: 2, giftFormat: 'virtual' });
  assert.equal(api.classifyGiftCardSession(giftSession({ metadata: {} })).giftCard, false);
  assert.deepEqual(
    api.classifyGiftCardSession(giftSession({ payment_link: 'plink_1UZFlzG3M5SYIuful7LbaVAn' })),
    { giftCard: false, reason: 'payment_link' }
  );
});

test('the voucher code is deterministic for the same Checkout Session', async () => {
  const a = await api.stripeVoucherCode('cs_test_gift_1', 'Ana Compradora', 'Juan Pérez', '18/11/2026');
  const b = await api.stripeVoucherCode('cs_test_gift_1', 'Ana Compradora', 'Juan Pérez', '18/11/2026');
  const c = await api.stripeVoucherCode('cs_other', 'Ana Compradora', 'Juan Pérez', '18/11/2026');
  assert.equal(a, b);
  assert.match(a, /^CR-181126-AC-JP-[A-Z2-9]{4}$/);
  assert.notEqual(a, c);
});

test('buildBonoFromSession sends type, amount, buyer and recipient', async () => {
  const built = await api.buildBonoFromSession(giftSession(), { classes: 2, giftFormat: 'virtual' }, 'evt_1', NOW);
  assert.deepEqual(built.errors, []);
  assert.equal(built.card.buyer, 'Ana Compradora');
  assert.equal(built.card.recipient, 'Juan Pérez');
  assert.equal(built.card.num_classes, 2);
  assert.equal(built.card.type, 'modelado');
  assert.equal(built.card.payment_status, 'paid');
  assert.equal(built.card.price, 75);
  assert.equal(built.card.buyer_email, 'ana@example.com');
  assert.equal(built.card.buyer_phone, '+34600111222');
  assert.equal(built.card.dedication, 'Feliz cumpleaños');
  assert.equal(built.card.delivery_format, 'digital');
  assert.equal(built.card.external_metadata.source, 'stripe-webhook');
  assert.equal(built.card.external_metadata.stripeSessionId, 'cs_test_gift_1');
  assert.equal(built.card.external_metadata.typeDefaulted, true);
  assert.equal(built.record.classType, 'modelado');
});

test('metadata.type or class_type torno is stored as torno without typeDefaulted', async () => {
  const built = await api.buildBonoFromSession(
    giftSession({ metadata: { source: 'casa_rosier_web', gift_format: 'virtual', classes: '2', type: 'torno' } }),
    { classes: 2, giftFormat: 'virtual' }, 'evt_1', NOW
  );
  assert.equal(built.card.type, 'torno');
  assert.equal(built.card.external_metadata.typeDefaulted, undefined);
});

test('classifyGiftCardSession accepts a Checkout Session without payment_link and reads num_classes', () => {
  const session = giftSession({
    payment_link: null,
    metadata: { source: 'casa_rosier_web', gift_format: 'physical', num_classes: '3', type: 'torno' }
  });
  assert.deepEqual(api.classifyGiftCardSession(session), { giftCard: true, classes: 3, giftFormat: 'physical' });
  assert.equal(
    api.classifyGiftCardSession(giftSession({ payment_link: null, metadata: { source: 'casa_rosier_web', gift_format: 'virtual' } })).giftCard,
    false
  );
});

test('buildBonoFromSession reads Checkout name, phones and recipient custom fields', async () => {
  const built = await api.buildBonoFromSession(
    giftSession({
      payment_link: null,
      metadata: { source: 'casa_rosier_web', gift_format: 'virtual', num_classes: '2', class_type: 'torno' },
      customer_details: { individual_name: 'Ferran Buyer', name: null, email: 'ferry.gon.gom@example.com', phone: '652114732' },
      custom_fields: [
        { key: 'destinatario', type: 'text', text: { value: 'Lola y Jose Luis' } },
        { key: 'dedicatoria', type: 'text', text: { value: 'Que disfrutéis de vuestro 69 aniversario' } },
        { key: 'telefono_destinatario', type: 'text', text: { value: '+34600111222' } }
      ]
    }),
    { classes: 2, giftFormat: 'virtual' }, 'evt_2', NOW
  );
  assert.deepEqual(built.errors, []);
  assert.equal(built.card.buyer, 'Ferran Buyer');
  assert.equal(built.card.buyer_phone, '652114732');
  assert.equal(built.card.buyer_email, 'ferry.gon.gom@example.com');
  assert.equal(built.card.recipient, 'Lola y Jose Luis');
  assert.equal(built.card.type, 'torno');
  assert.equal(built.student.phone, '+34600111222');
  assert.equal(built.record.recipientPhone, '+34600111222');
  assert.equal(built.card.external_metadata.recipientPhone, '+34600111222');
  assert.equal(built.card.external_metadata.typeDefaulted, undefined);
});

test('handleStripeWebhook: 400 bad signature, 503 without secret, 200 created', async () => {
  const store = makeStore();
  const raw = JSON.stringify(eventFor(giftSession()));
  assert.equal((await api.handleStripeWebhook(raw, `t=${NOW_S},v1=${'a'.repeat(64)}`, depsFor(store), SECRET)).status, 400);
  assert.equal((await api.handleStripeWebhook(raw, await api.signStripePayload(raw, SECRET, NOW_S), depsFor(store), '')).status, 503);
  const created = await sendWebhook(eventFor(giftSession()), store);
  assert.equal(created.status, 200);
  assert.equal(created.body.result, 'created');
  assert.equal(created.body.bonos, 'saved');
  assert.equal(store.creates.length, 1);
  assert.equal(store.creates[0].card.type, 'modelado');
  assert.equal(store.creates[0].card.price, 75);
  assert.equal(store.creates[0].student.full_name, 'Juan Pérez');
});

test('a repeated event or an existing bono for the same session is a duplicate, never a second insert', async () => {
  const store = makeStore();
  const first = await sendWebhook(eventFor(giftSession()), store);
  const second = await sendWebhook(eventFor(giftSession()), store);
  assert.equal(first.body.result, 'created');
  assert.equal(second.status, 200);
  assert.equal(second.body.result, 'duplicate');
  assert.equal(second.body.notify, 'not_sent');
  assert.equal(store.creates.length, 1);
});

test('a non-gift-card payment is ignored and creates nothing', async () => {
  const store = makeStore();
  const result = await sendWebhook(eventFor(giftSession({ metadata: { source: 'course' } })), store);
  assert.deepEqual(result, { status: 200, body: { ok: true, result: 'ignored', reason: 'not_gift_card:metadata.source' } });
  assert.equal(store.creates.length, 0);
});

test('an unpaid session is ignored; missing recipient is 422', async () => {
  const store = makeStore();
  const unpaid = await sendWebhook(eventFor(giftSession({ payment_status: 'unpaid' })), store);
  assert.equal(unpaid.body.reason, 'payment_status:unpaid');
  const invalid = await sendWebhook(eventFor(giftSession({ custom_fields: [] })), store);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error, 'invalid_session_data');
  assert.equal(store.creates.length, 0);
});

test('a failed notify never rolls back the bono', async () => {
  const store = makeStore();
  const result = await api.processStripeEvent(eventFor(giftSession()), depsFor(store, {
    notify: async () => ({ status: 'error', error: 'HTTP 502' })
  }));
  assert.equal(result.body.result, 'created');
  assert.equal(result.body.notify, 'error');
  assert.equal(store.creates.length, 1);
});

test('pending: lists oldest first, returns type, acknowledges, 401 without key, 404 unknown code', async () => {
  const store = makeStore();
  const first = await sendWebhook(eventFor(giftSession()), store);
  const laterSession = giftSession({
    id: 'cs_test_gift_2',
    created: NOW_S + 60,
    custom_fields: [
      { key: 'destinatario', type: 'text', text: { value: 'Luis Gomez' } },
      { key: 'dedicatoria', type: 'text', text: { value: '' } }
    ]
  });
  await api.processStripeEvent(eventFor(laterSession, 'checkout.session.completed', 'evt_2'), depsFor(store, { now: () => new Date('2026-11-18T15:00:00Z') }));

  const listed = await api.listPendingStripeGiftCards(store);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].voucherCode, first.body.voucherCode);
  assert.equal(listed[0].type, 'modelado');
  assert.equal(listed[0].amount, 75);
  assert.equal(listed[0].buyerName, 'Ana Compradora');
  assert.equal(listed[0].recipientName, 'Juan Pérez');
  assert.equal(listed[1].recipientName, 'Luis Gomez');

  const stubPdf = async () => new Uint8Array([37, 80, 68, 70]); // %PDF
  const one = await api.getPendingStripeGiftCard(store, first.body.voucherCode, stubPdf);
  assert.equal(one.giftCard.voucherCode, first.body.voucherCode);
  assert.equal(one.pdfBase64, Buffer.from([37, 80, 68, 70]).toString('base64'));
  assert.equal(one.pdfError, undefined);
  assert.equal(await api.getPendingStripeGiftCard(store, 'CR-NOPE'), null);

  const ack = await api.acknowledgeStripeGiftCards(store, [first.body.voucherCode, 'CR-MISSING'], 'asistonto', NOW);
  assert.deepEqual(ack, { acknowledged: [first.body.voucherCode], notFound: ['CR-MISSING'] });
  const remaining = await api.listPendingStripeGiftCards(store);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].recipientName, 'Luis Gomez');

  const env = {
    SUPABASE_URL: 'https://offline.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
    BONOS_API_SEDE_ID: sede,
    ASISTONTO_KEY_SHA256: sha(asistontoKey)
  };
  const factory = () => store;
  const unauthorized = await api.handlePendingRequest(new Request('https://edge.invalid/stripe-giftcard-pending'), (name) => env[name], factory);
  assert.equal(unauthorized.status, 401);
  const ok = await api.handlePendingRequest(new Request('https://edge.invalid/stripe-giftcard-pending', {
    headers: { 'x-api-key': asistontoKey }
  }), (name) => env[name], factory);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 1);
});
