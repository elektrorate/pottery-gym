import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetRoot = join(root, 'supabase/functions/_shared/gift-card-pdf');

const ASSETS = [
  'assets/fonts/Montserrat-Regular.ttf',
  'assets/fonts/Montserrat-Medium.ttf',
  'assets/fonts/Montserrat-SemiBold.ttf',
  'assets/fonts/Montserrat-Italic.ttf',
  'assets/fonts/CormorantGaramond-Regular.ttf',
  'assets/logos/logo-casa-rosier.png'
];

test('embeddedAssets.ts matches the committed font and logo files', async () => {
  const check = spawnSync('node', ['scripts/embed-gift-card-pdf-assets.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const mapped = join(assetRoot, '.tmp-embeddedAssets.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: ['supabase/functions/_shared/gift-card-pdf/embeddedAssets.ts'],
    bundle: true,
    write: true,
    outfile: mapped,
    platform: 'node',
    format: 'esm'
  });
  const { embeddedAssets } = await import(pathToFileURL(mapped).href);
  for (const relative of ASSETS) {
    const expected = await readFile(join(assetRoot, relative));
    const actual = embeddedAssets[relative];
    assert.ok(actual, `missing embedded asset ${relative}`);
    assert.equal(actual.byteLength, expected.byteLength, `${relative} length`);
    assert.equal(
      createHash('sha256').update(actual).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
      `${relative} digest`
    );
  }
});

test('PDF generation uses embedded bytes even if Deno.readFile is missing', async () => {
  const previous = globalThis.Deno;
  globalThis.Deno = {
    readFile: async () => {
      throw new Error('Deno.readFile must not be used after the assets were embedded');
    }
  };
  try {
    const outFile = join(assetRoot, '.tmp-giftCardPdf.mjs');
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
    const { buildGiftCardPdfBytes } = await import(`${pathToFileURL(outFile).href}?embedded=${Date.now()}`);
    const bytes = await buildGiftCardPdfBytes({
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
      buyerName: 'PRUEBA RIO – no usar',
      donorName: 'PRUEBA RIO – no usar',
      recipientName: 'PRUEBA RIO – no usar',
      numberOfClasses: 1,
      sessionDuration: '2.5',
      creationDate: '19/11/2026',
      voucherCode: 'CR-191126-PR-PR-TEST',
      logoUrl: null,
      internalContactPhone: '633788860'
    });
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('utf8'), '%PDF-');
    assert.ok(bytes.byteLength > 8_000);
  } finally {
    if (previous === undefined) delete globalThis.Deno;
    else globalThis.Deno = previous;
  }
});
