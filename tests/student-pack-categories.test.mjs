import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'pack-cat-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

test('Europe/Madrid expiry mapping keeps the selected calendar day', async () => {
  const { dir, mod } = await bundle('utils/studentLifecycle.ts');
  try {
    assert.equal(mod.toWorkshopDateKey('2026-12-20'), '2026-12-20');
    assert.equal(mod.toWorkshopDateKey('2026-12-19T23:00:00.000Z'), '2026-12-20');
    assert.equal(mod.workshopDateToTimestamptz('2026-12-20'), '2026-12-20T12:00:00.000Z');
    assert.equal(mod.toWorkshopDateKey(mod.workshopDateToTimestamptz('2026-12-20')), '2026-12-20');
    assert.equal(
      mod.mapStudentRowToModel({
        id: 's1', name: 'Ada', phone: '', student_category: 'temporal',
        expiry_date: '2026-12-19T23:00:00.000Z', classes_remaining: 2
      }).expiryDate,
      '2026-12-20'
    );
    assert.equal(mod.isNonMembershipCategory('grupal'), true);
    assert.equal(mod.isNonMembershipCategory('membresia'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dashboard remaining classes prefer linked gift cards over zeroed student columns', async () => {
  const { dir, mod } = await bundle('utils/studentPresentation.ts');
  try {
    const student = {
      id: 'paula', name: 'Paula', phone: '', status: 'active',
      studentCategory: 'temporal', classesRemaining: 0, bonosAsignados: 0
    };
    const cards = [{
      id: 'c1', recipientStudentId: 'paula', numClasses: 3, sessionsUsed: 0,
      sessionsRemaining: 3, status: 'active', type: 'modelado', paymentStatus: 'paid'
    }];
    assert.equal(mod.studentEffectiveRemainingClasses(student, cards), 3);
    assert.equal(mod.studentEffectiveRemainingClasses(student, []), 0);
    assert.equal(mod.studentBalanceLabel(student, cards), '3 clases');
    const grupal = { ...student, id: 'g1', studentCategory: 'grupal', classesRemaining: 2, bonosAsignados: 4 };
    assert.equal(mod.studentEffectiveRemainingClasses(grupal, []), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('canonical Spanish labels for categories and session types', async () => {
  const { dir, mod } = await bundle('utils/classTypeLabels.ts');
  try {
    assert.equal(mod.STUDENT_CATEGORY_LABELS.temporal, 'Bonos temporales');
    assert.equal(mod.STUDENT_CATEGORY_LABELS.grupal, 'Grupal');
    assert.equal(mod.STUDENT_CATEGORY_LABELS.grupo_temporal, 'Grupo temporal');
    assert.equal(mod.studentCategoryLabel('grupal'), 'Grupal');
    assert.equal(mod.studentCategoryLabel('grupo_temporal'), 'Grupo temporal');
    assert.equal(mod.sessionTypeLabel('mesa'), 'Modelado/Mesa');
    assert.equal(mod.sessionTypeLabel('torno'), 'Torno');
    assert.equal(mod.sessionTypeLabel('coworking'), 'Coworking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
