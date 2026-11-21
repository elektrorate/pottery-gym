import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = async (entry) => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external'
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'reason-labels-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

test('penalty and funding reasons never surface raw English codes in Spanish UI', async () => {
  const { dir, mod } = await bundle('utils/businessReasonLabels.ts');
  try {
    assert.equal(mod.businessReasonLabel('One class: no_show'), 'Una clase consumida · Falta sin aviso');
    assert.equal(mod.businessReasonLabel('One class: late_cancellation'), 'Una clase consumida · Cancelación tardía');
    assert.equal(mod.penaltyKindLabel('no_show'), 'Falta sin aviso');
    assert.equal(mod.penaltyKindLabel('late_cancellation'), 'Cancelación tardía');
    assert.equal(mod.billingKindLabel('no_show'), 'Falta sin aviso');
    assert.equal(
      mod.businessReasonLabel('Unsupported temporal/manual funding: legacy balance requires attributable funding or reconciliation'),
      'Hay clases anteriores sin un bono o una membresía. Regístrelas antes de descontar.'
    );
    // Cosmetic: "not usable" must not appear as English even when the pack was usable.
    const notUsable = mod.businessReasonLabel('Original scalar pack is not usable');
    assert.match(notUsable, /bono|utilizable|condiciones/i);
    assert.doesNotMatch(notUsable, /not usable/i);
    assert.doesNotMatch(notUsable, /One class/i);
    assert.equal(mod.businessReasonLabel('no_show'), 'Falta sin aviso');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('attendance errors stay in Spanish, including the owner-only unusable membership exception', async () => {
  const { dir, mod } = await bundle('utils/recordPresentation.ts');
  try {
    const finalized = mod.sessionBusinessErrorMessage(new Error(
      'Presence requires valid original credit or an explicit current session exception: Original membership is unpaid, expired, archived or does not cover the session'));
    assert.match(finalized, /No se puede finalizar la asistencia/);
    assert.doesNotMatch(finalized, /Presence requires/);
    assert.equal(
      mod.sessionBusinessErrorMessage(new Error('Only this workshop owner may approve an exception when the original membership is unpaid, expired or does not cover the session')),
      'Solo el propietario del taller puede aprobar esta excepción cuando la membresía está pendiente, vencida o no cubre la sesión.'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('studentCategoryLabel never returns raw grupal / grupo_temporal codes', async () => {
  const { dir, mod } = await bundle('utils/classTypeLabels.ts');
  try {
    assert.equal(mod.studentCategoryLabel('grupal'), 'Grupal');
    assert.equal(mod.studentCategoryLabel('grupo_temporal'), 'Grupo temporal');
    assert.equal(mod.studentCategoryLabel('temporal'), 'Bonos de clases');
    assert.equal(mod.studentCategoryLabel('membresia'), 'Membresía');
    assert.equal(mod.studentCategoryLabel('weird_code_x'), 'Weird Code X');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy settle SQL script is dry-run by default and documents safety rails', async () => {
  const sql = await readFile('scripts/sql/settle_legacy_unattributed_incidence.sql', 'utf8');
  assert.match(sql, /\\set dry_run 1/);
  assert.match(sql, /Regularización falta previa a fix26/);
  assert.match(sql, /session_business_adjust_scalar/);
  assert.match(sql, /Unsupported temporal\/manual funding/);
  assert.match(sql, /DRY-RUN/);
  assert.match(sql, /ROLLBACK/);
  assert.match(sql, /no se descuenta dos veces/);
  assert.match(sql, /NO ES UNA MIGRACIÓN/);
  assert.match(sql, /ilkrcakrduibgsfqfzti/);
  assert.doesNotMatch(sql, /supabase db push/i);
  // Apply path only when dry_run=0
  assert.match(sql, /\\if :dry_run[\s\S]*ROLLBACK[\s\S]*\\else[\s\S]*COMMIT/);
});
