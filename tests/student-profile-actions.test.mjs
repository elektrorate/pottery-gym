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
  const dir = await mkdtemp(path.join(tmpdir(), 'profile-actions-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

test('pending payment selection reuses the current period and ignores legacy placeholders', async () => {
  const { dir, mod } = await bundle('utils/studentLifecycle.ts');
  try {
    const member = {
      id: 'm', name: 'Ada', phone: '', studentCategory: 'membresia', paymentStatus: 'pending',
      effectivePeriodId: 'current', membershipPeriods: [
        { id: 'current', studentId: 'm', paymentStatus: 'pending' },
        { id: 'next', studentId: 'm', paymentStatus: 'pending' }
      ]
    };
    assert.equal(mod.studentHasPendingPayment(member), true);
    assert.equal(mod.selectConfirmablePaymentPeriodId(member), 'current');
    assert.equal(mod.selectConfirmablePaymentPeriodId({ ...member, paymentStatus: 'paid', membershipPeriods: [
      { id: 'current', studentId: 'm', paymentStatus: 'paid' },
      { id: 'next', studentId: 'm', paymentStatus: 'pending' }
    ] }), 'next');
    assert.equal(mod.studentHasPendingPayment({ ...member, paymentStatus: 'paid', membershipPeriods: [
      { id: 'current', studentId: 'm', paymentStatus: 'paid' }
    ] }), false);
    const pack = { ...member, studentCategory: 'grupal', membershipPeriods: undefined, effectivePeriodId: undefined };
    assert.equal(mod.studentHasPendingPayment(pack), true);
    assert.equal(mod.selectConfirmablePaymentPeriodId(pack), null);
    assert.equal(mod.studentHasPendingPayment({ ...pack, paymentStatus: 'paid' }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing scalar adjustment function is distinguishable from a rejected adjustment', async () => {
  const { dir, mod } = await bundle('utils/classAdjustmentAudit.ts');
  try {
    assert.equal(mod.isMissingScalarAdjustmentRpc({ code: 'PGRST202', message: 'Could not find the function public.adjust_student_scalar_classes in the schema cache' }), true);
    assert.equal(mod.isMissingScalarAdjustmentRpc({ code: '42883', message: 'function public.adjust_student_scalar_classes does not exist' }), true);
    assert.equal(mod.isMissingScalarAdjustmentRpc({ code: '40001', message: 'Stale class balance' }), false);
    assert.equal(mod.isMissingScalarAdjustmentRpc({ code: '42501', message: 'Student not accessible' }), false);
    assert.equal(mod.isMissingScalarAdjustmentRpc(null), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
