import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// In-memory bundle of the Casa Rosier designer logic. No browser, env file, database or network.
const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export * from './bonos-designer/lib/potteryStore';
      export * from './bonos-designer/lib/giftCardDefaults';
      export * from './bonos-designer/lib/pdfLayout';
      export * from './bonos-designer/lib/voucherCode';
      export * from './bonos-designer/lib/validation';
    `,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'esm'
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const card = (overrides = {}) => ({
  ...m.giftCardCopyDefaults,
  buyerName: 'Rolando Diaz', donorName: 'Rolando Diaz', recipientName: 'Julian Diaz',
  numberOfClasses: 1, sessionDuration: '2.5', creationDate: '18/11/2026', voucherCode: 'CR-181126-RD-JD-LK',
  logoUrl: '/assets/logo.png', internalContactPhone: '+34 600 000 000', ...overrides
});

test('card geometry and copy are the bonos app ones', () => {
  const page = m.portraitCardPageMm();
  assert.equal(Math.round(page.pageWidth * 100) / 100, 120.25);
  assert.equal(page.pageHeight, 190);
  assert.equal(m.CARD_PX_WIDTH, 480);
  assert.equal(m.classesCountLabel(1), '1 clase');
  assert.equal(m.classesCountLabel(4), '4 clases');
  assert.equal(m.DEFAULT_VALIDITY_TEXT, 'Validez del bono regalo: 12 meses');
  assert.equal(m.giftCardCopyDefaults.contactTitle, 'Información de contacto');
  assert.equal(m.giftCardCopyDefaults.phone, '+34 633 788 860');
  assert.match(m.generateVoucherCode('Rolando Diaz', 'Julián Díaz', '18/11/2026'), /^CR-181126-RD-JD-[A-Z2-9]{2}$/);
  assert.deepEqual(m.validateGiftCard(card()), []);
});

test('designer row: same code, 12 months, internal phone, duration, full design without logo', () => {
  const row = m.buildPotteryCardRow(card({ mainQuote: 'Feliz cumpleaños' }), {
    voucherCode: 'cr-181126-rd-jd-lk', fileName: 'Bono-Casa-Rosier-Rolando-Diaz.pdf', paymentStatus: 'paid', type: 'torno'
  });
  assert.equal(row.code, 'CR-181126-RD-JD-LK');
  assert.equal(row.external_reference, 'CR-181126-RD-JD-LK');
  assert.equal(row.validity_months, 12);
  assert.equal(row.num_classes, 1);
  assert.equal(row.type, 'torno');
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.activated_at, '2026-11-18');
  assert.equal(row.buyer_phone, '+34 600 000 000');
  assert.equal(row.dedication, 'Feliz cumpleaños');
  assert.equal(row.extra_commentary, 'Duración de la clase: 2,5 h');
  assert.equal(row.external_metadata.source, 'pottery-designer');
  assert.equal(row.external_metadata.designerStatus, 'created');
  assert.equal(row.external_metadata.cardData.recipientName, 'Julian Diaz');
  assert.equal('logoUrl' in row.external_metadata.cardData, false);
  for (const field of ['status', 'sessions_used', 'expiry_date', 'sede_id', 'recipient_student_id']) assert.equal(field in row, false, field);
});

test('stock quote is not a dedication; 6-month text maps to 6', () => {
  const row = m.buildPotteryCardRow(card({ validityText: 'Validez de la tarjeta: 6 meses' }), { voucherCode: 'CR-1', fileName: 'x.pdf' });
  assert.equal(row.dedication, undefined);
  assert.equal(row.validity_months, 6);
  assert.equal(row.payment_status, 'pending');
  assert.equal(row.type, 'modelado');
});

test('history: designer rows reload the exact design; API rows are rebuilt', () => {
  const defaults = card({ buyerName: '', recipientName: '', donorName: '', internalContactPhone: '', voucherCode: '' });
  const row = m.buildPotteryCardRow(card({ title: 'TARJETA ESPECIAL' }), { voucherCode: 'CR-A', fileName: 'a.pdf' });
  const designer = m.mapGiftCardRow({ id: 'g1', ...row, status: 'pending', created_at: '2026-11-18T10:00:00Z' }, defaults);
  assert.equal(designer.origin, 'server');
  assert.equal(designer.voucherCode, 'CR-A');
  assert.equal(designer.data.title, 'TARJETA ESPECIAL');
  assert.equal(designer.data.logoUrl, '/assets/logo.png');
  assert.equal(designer.status, 'created');
  assert.equal(designer.fileName, 'a.pdf');

  const api = m.mapGiftCardRow({
    id: 'g2', code: 'CR-181126-RD-JD-LK', buyer: 'Rolando Diaz', recipient: 'Julian Diaz', buyer_phone: '+34600',
    num_classes: 1, status: 'consumed', payment_status: 'paid', dedication: null, validity_months: 12,
    activated_at: '2026-11-18', extra_commentary: 'Duración de la clase: 2,5 h',
    external_metadata: { source: 'gift-card-bot-api', donorName: 'Rolando', classDurationHours: 2.5 }, created_at: '2026-11-18T09:00:00Z'
  }, defaults);
  assert.equal(api.data.donorName, 'Rolando');
  assert.equal(api.data.sessionDuration, '2.5');
  assert.equal(api.data.creationDate, '18/11/2026');
  assert.equal(api.data.validityText, 'Validez del bono regalo: 12 meses');
  assert.equal(api.data.internalContactPhone, '+34600');
  assert.equal(api.status, 'redeemed');
  assert.equal(api.data.mainQuote, defaults.mainQuote);
});

test('status mapping', () => {
  assert.equal(m.designerStatusFrom('cancelled', { designerStatus: 'sent' }), 'cancelled');
  assert.equal(m.designerStatusFrom('exhausted', {}), 'redeemed');
  assert.equal(m.designerStatusFrom('active', { designerStatus: 'sent' }), 'sent');
  assert.equal(m.designerStatusFrom('pending', null), 'created');
});

const mockClient = (result) => {
  const calls = [];
  const query = (table) => {
    const call = { table, ops: [] }; calls.push(call);
    const chain = {
      insert(payload) { call.ops.push(['insert', payload]); return chain; },
      update(payload) { call.ops.push(['update', payload]); return chain; },
      select(cols) { call.ops.push(['select', cols]); return chain; },
      eq(...args) { call.ops.push(['eq', ...args]); return chain; },
      is(...args) { call.ops.push(['is', ...args]); return chain; },
      order() { return chain; }, limit() { return Promise.resolve(result); },
      single() { return Promise.resolve(result); },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); }
    };
    return chain;
  };
  return { calls, from: query, rpc(fn, args) { calls.push({ rpc: fn, args }); return Promise.resolve(result); } };
};

test('create: temporal student via the authenticated RPC, existing student via insert', async () => {
  const saved = { id: 'g1', code: 'CR-A', buyer: 'B', recipient: 'R', status: 'pending', created_at: '2026-11-18T10:00:00Z', external_metadata: {} };
  const temporal = mockClient({ data: saved, error: null });
  const record = await m.createPotteryGiftCard(temporal, 'sede-1', card(), { voucherCode: 'CR-A', fileName: 'a.pdf' }, { mode: 'temporal' });
  assert.equal(record.id, 'g1');
  assert.equal(temporal.calls[0].rpc, 'designer_create_gift_card_with_temporal_student');
  assert.equal(temporal.calls[0].args.p_sede_id, 'sede-1');
  assert.equal(temporal.calls[0].args.p_card.code, 'CR-A');
  assert.equal(temporal.calls[0].args.p_student.full_name, 'Julian Diaz');
  assert.match(temporal.calls[0].args.p_student.notes, /CR-A/);

  const existing = mockClient({ data: saved, error: null });
  await m.createPotteryGiftCard(existing, 'sede-1', card(), { voucherCode: 'CR-A', fileName: 'a.pdf' }, { mode: 'student', studentId: 'st-1' });
  const insert = existing.calls[0].ops.find(([op]) => op === 'insert')[1];
  assert.equal(existing.calls[0].table, 'gift_cards');
  assert.equal(insert.recipient_student_id, 'st-1');
  assert.equal(insert.sede_id, 'sede-1');

  const duplicate = mockClient({ data: null, error: { code: '23505', message: 'duplicate key' } });
  await assert.rejects(m.createPotteryGiftCard(duplicate, 'sede-1', card(), { voucherCode: 'CR-A', fileName: 'a.pdf' }, { mode: 'temporal' }),
    (error) => error.code === '23505');
  await assert.rejects(m.createPotteryGiftCard(duplicate, '', card(), { voucherCode: 'CR-A', fileName: 'a.pdf' }, { mode: 'temporal' }), /sede/);
});

test('cancel and designer status use the normal pottery-gym paths', async () => {
  const client = mockClient({ data: {}, error: null });
  await m.cancelPotteryGiftCard(client, 'g1');
  assert.deepEqual(client.calls[0], { rpc: 'cancel_gift_card', args: { p_gift_card_id: 'g1' } });
  await m.updateDesignerStatus(client, { id: 'g1', metadata: { source: 'pottery-designer', designerStatus: 'created' } }, 'sent');
  const update = client.calls[1].ops.find(([op]) => op === 'update')[1];
  assert.deepEqual(update, { external_metadata: { source: 'pottery-designer', designerStatus: 'sent' } });
});

test('mergeHistory: server wins for the same code, newest first', () => {
  const merged = m.mergeHistory(
    [{ id: 's1', voucherCode: 'CR-A', createdAt: '2026-11-18T10:00:00Z' }],
    [{ id: 'l1', voucherCode: 'CR-A', createdAt: '2026-11-18T11:00:00Z' }, { id: 'l2', voucherCode: 'CR-B', createdAt: '2026-11-18T12:00:00Z' }]
  );
  assert.deepEqual(merged.map((item) => item.id), ['l2', 's1']);
});
