import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const potteryRoot = fileURLToPath(new URL('../', import.meta.url));
const bonoRoot = fileURLToPath(new URL('../../bono-gift-card/', import.meta.url));
const outDir = '/workspace/bono-pdf-compare';

const sample = {
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
};

const bundlePdf = async (entry, outfile, absWorkingDir) => {
  const result = await build({
    absWorkingDir,
    entryPoints: [entry],
    bundle: true,
    write: true,
    outfile,
    platform: 'node',
    format: 'esm',
    packages: 'external'
  });
  if (result.errors?.length) throw new Error(result.errors.map((err) => err.text).join('\n'));
  return import(pathToFileURL(outfile).href);
};

test('pottery-gym PDF pages are pixel-identical to the bono-gift-card lib PDF', async () => {
  assert.ok(existsSync(join(bonoRoot, 'lib/giftCardPdf.ts')), 'falta el repo bono-gift-card para comparar');
  await mkdir(outDir, { recursive: true });

  const original = await bundlePdf('lib/giftCardPdf.ts', join(bonoRoot, 'lib/.tmp-giftCardPdf.mjs'), bonoRoot);
  const ported = await bundlePdf(
    'supabase/functions/_shared/gift-card-pdf/giftCardPdf.ts',
    join(potteryRoot, 'supabase/functions/_shared/gift-card-pdf/.tmp-giftCardPdf.mjs'),
    potteryRoot
  );

  const originalBytes = await original.buildGiftCardPdfBytes(sample);
  const portedBytes = await ported.buildGiftCardPdfBytes(sample);
  await writeFile(join(outDir, 'bono-gift-card-lib.pdf'), originalBytes);
  await writeFile(join(outDir, 'pottery-gym.pdf'), portedBytes);

  const render = (pdf, prefix) => {
    const result = spawnSync('pdftoppm', ['-png', '-r', '150', pdf, prefix], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`pdftoppm failed for ${pdf}: ${result.stderr || result.error}`);
    }
  };
  render(join(outDir, 'bono-gift-card-lib.pdf'), join(outDir, 'bono-gift-card-lib'));
  render(join(outDir, 'pottery-gym.pdf'), join(outDir, 'pottery-gym'));

  const diff = spawnSync('python3', [join(outDir, 'diff-pages.py'), outDir], { encoding: 'utf8' });
  if (diff.stdout) process.stdout.write(diff.stdout);
  if (diff.stderr) process.stderr.write(diff.stderr);
  assert.equal(diff.status, 0, diff.stdout || 'the rendered pages differ; see /workspace/bono-pdf-compare');
  assert.ok(existsSync(join(outDir, 'side-by-side-p1.png')));
  assert.ok(existsSync(join(outDir, 'side-by-side-p2.png')));
});
