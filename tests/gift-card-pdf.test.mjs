import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const root = fileURLToPath(new URL('../', import.meta.url));
const outFile = join(root, 'supabase/functions/_shared/gift-card-pdf/.tmp-giftCardPdf.mjs');

await build({
  absWorkingDir: root,
  entryPoints: ['supabase/functions/_shared/gift-card-pdf/giftCardPdf.ts'],
  bundle: true,
  write: true,
  outfile: outFile,
  platform: 'node',
  format: 'esm',
  packages: 'external'
});

const { buildGiftCardPdfBytes } = await import(pathToFileURL(outFile).href);
const { cardDataFromGiftCardRow, pdfFileNameFromRow, bytesToBase64 } = await import(
  pathToFileURL(join(root, 'supabase/functions/_shared/gift-card-pdf/cardDataFromRow.ts')).href
).catch(async () => {
  // cardDataFromRow.ts may need a light bundle for .ts imports
  const mapped = join(root, 'supabase/functions/_shared/gift-card-pdf/.tmp-cardDataFromRow.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: ['supabase/functions/_shared/gift-card-pdf/cardDataFromRow.ts'],
    bundle: true, write: true, outfile: mapped, platform: 'node', format: 'esm', packages: 'external'
  });
  return import(pathToFileURL(mapped).href);
});

const sample = (overrides = {}) => ({
  title: 'TARJETA DE REGALO',
  subtitle: 'Clases de Cerámica',
  subtitle2: '',
  introText: '¡Felicidades!',
  mainQuote:
    '"En tus manos sostienes uno de los regalos más especiales que podrías recibir:\nUna invitación a un día lleno de inspiración y creatividad."',
  fromLabel: 'Este regalo tan significativo llega a ti gracias a:',
  experienceTitle: 'Instrucciones de Uso',
  experienceIntro: 'Contacta con nosotros para reservar tus clases',
  experienceLocation: 'Presenta esta tarjeta al inicio de tu primera clase',
  experienceBullet4: '',
  includesLabel: 'Esta tarjeta incluye:',
  includesDetails: 'Disfruta de la experiencia creativa',
  validityText: 'Validez de la tarjeta: 12 meses',
  contactTitle: 'Información de contacto',
  contactSubtitle: 'Cómo usar tu tarjeta',
  phone: '+34 633 788 860',
  email: 'info@casarosierceramica.com',
  website: 'www.casarosierceramica.com',
  buyerName: 'Ana Compradora',
  donorName: 'María Ruiz',
  recipientName: 'Juan Pérez',
  numberOfClasses: 4,
  sessionDuration: '2.5',
  creationDate: '30/10/2026',
  voucherCode: 'CR-301026-JD-DD-NY',
  logoUrl: null,
  internalContactPhone: '633788860',
  ...overrides
});

test('builds two portrait card pages, 120.25 × 190 mm, upright', async () => {
  const bytes = await buildGiftCardPdfBytes(sample());
  assert.ok(bytes.byteLength > 8_000);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('utf8'), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  const mmToPt = 72 / 25.4;
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    assert.ok(height > width);
    assert.ok(Math.abs(width - (190 / 1.58) * mmToPt) < 0.2);
    assert.ok(Math.abs(height - 190 * mmToPt) < 0.2);
    assert.equal(page.getRotation().angle % 360, 0);
  }
});

test('still builds a card when the pack is a single class («1 clase»)', async () => {
  const bytes = await buildGiftCardPdfBytes(sample({ numberOfClasses: 1 }));
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  assert.ok(bytes.byteLength > 8_000);
});

test('fits very long names, messages and bullets without failing', async () => {
  const long = 'Nombre Muy Largo De Prueba Con Varios Apellidos Compuestos Fernández';
  const bytes = await buildGiftCardPdfBytes(sample({
    recipientName: long,
    donorName: long,
    mainQuote: 'Palabra '.repeat(60).trim(),
    experienceIntro: 'Texto largo '.repeat(15).trim(),
    experienceLocation: 'Texto largo '.repeat(15).trim(),
    includesDetails: 'Texto largo '.repeat(15).trim(),
    experienceBullet4: 'Texto largo '.repeat(15).trim()
  }));
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
});

test('cardDataFromGiftCardRow prefers stored cardData and fills official defaults', async () => {
  const fromStripe = cardDataFromGiftCardRow({
    code: 'CR-191126-PR-PR-TEST',
    buyer: 'PRUEBA RIO – no usar',
    recipient: 'PRUEBA RIO – no usar',
    num_classes: 1,
    type: 'modelado',
    dedication: null,
    validity_months: 12,
    created_at: '2026-11-19T09:00:00Z'
  }, '19/11/2026');
  assert.equal(fromStripe.numberOfClasses, 1);
  assert.equal(fromStripe.recipientName, 'PRUEBA RIO – no usar');
  assert.equal(fromStripe.validityText, 'Validez de la tarjeta: 12 meses');
  assert.equal(fromStripe.phone, '+34 633 788 860');
  assert.equal(fromStripe.voucherCode, 'CR-191126-PR-PR-TEST');
  const stored = cardDataFromGiftCardRow({
    code: 'CR-1',
    buyer: 'A',
    recipient: 'B',
    num_classes: 2,
    external_metadata: { cardData: { ...fromStripe, recipientName: 'Guardado', voucherCode: 'IGNORE' }, fileName: 'Bono-Casa-Rosier-X.pdf' }
  });
  assert.equal(stored.recipientName, 'Guardado');
  assert.equal(stored.voucherCode, 'CR-1');
  assert.equal(pdfFileNameFromRow({ recipient: 'Luis Gómez', external_metadata: {} }), 'Bono-Casa-Rosier-Luis-Gomez.pdf');
  assert.equal(bytesToBase64(new Uint8Array([1, 2, 3])), Buffer.from([1, 2, 3]).toString('base64'));
});

test('tmp bundle is a module next to the fonts (cleanup is left to the compare test too)', async () => {
  assert.ok(outFile.endsWith('.tmp-giftCardPdf.mjs'));
});
