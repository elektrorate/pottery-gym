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
  const dir = await mkdtemp(path.join(tmpdir(), 'credit-token-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

const base = {
  id: 'alumno', name: 'Ada', phone: '', status: 'new', studentCategory: 'temporal',
  classesRemaining: 4, legacyManualBalance: 4, bonosAsignados: 4, paymentStatus: 'pending',
  canReconcileLegacy: true, manualCredits: []
};

test('the manual-credit CAS token is the raw balance, not the projected reconcile amount', async () => {
  const { dir, mod } = await bundle('utils/studentLifecycle.ts');
  try {
    const cases = [
      { ...base, studentCategory: 'membresia', status: 'membresia', effectivePeriodId: 'period',
        materializedPeriodId: 'period', membershipPeriods: [{ id: 'period', studentId: 'alumno', paymentStatus: 'pending' }] },
      { ...base, studentCategory: 'temporal', effectivePeriodId: 'period', membershipPeriods: [{ id: 'period', studentId: 'alumno' }] },
      base,
      { ...base, bonosAsignados: null, classesRemaining: 0, legacyManualBalance: 0 },
      { ...base, legacyManualBalance: null, classesRemaining: 0 },
      { ...base, legacyManualBalance: undefined }
    ];
    for (const student of cases) {
      const projected = mod.previousClassesToRegister(student);
      const token = mod.observedLegacyBalance(student);
      const raw = typeof student.legacyManualBalance === 'number' && Number.isFinite(student.legacyManualBalance)
        ? student.legacyManualBalance : null;
      assert.equal(token, raw);
      if (projected === null && raw !== null) assert.notEqual(token, projected);
    }
    assert.equal(mod.previousClassesToRegister(cases[0]), null);
    assert.equal(mod.observedLegacyBalance(cases[0]), 4);
    assert.equal(mod.previousClassesToRegister(cases[2]), null);
    assert.equal(mod.observedLegacyBalance(cases[2]), 4);
    assert.equal(mod.previousClassesMessage(cases[2]), 'No hay clases anteriores por registrar.');
    assert.equal(mod.observedLegacyBalance(cases[3]), 0);
    assert.equal(mod.previousClassesToRegister(cases[3]), null);
    assert.equal(mod.observedLegacyBalance({ legacyManualBalance: null }), null);
    assert.equal(mod.observedLegacyBalance(null), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const storage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); }
  };
};
const manual = (expectedLegacyBalance) => ({
  studentId: 'alumno', requestKey: 'request-1', mode: 'new_manual', quantity: 3,
  expectedLegacyBalance, activity: 'mesa', startsOn: '2026-10-12', endsOn: '2026-11-12',
  reason: 'Motivo', evidence: 'Origen'
});
const receipt = (args) => ({
  data: {
    student_id: args.p_student_id, request_key: args.p_request_key,
    entitlement_id: 'entitlement', remaining_classes: args.p_quantity
  },
  error: null
});

test('a stuck null token is replaced on retry and a real token is never rewritten', async () => {
  const { dir, mod } = await bundle('context/data/studentCreditOps.ts');
  try {
    const calls = [];
    const store = new mod.StudentCreditIntentStore(storage());
    let fail = true;
    const api = mod.createStudentCreditOperations({
      actorId: 'owner', store,
      rpc: async (_name, args) => {
        calls.push({ ...args });
        if (fail) return { data: null, error: { message: 'Conexion perdida' } };
        return receipt(args);
      },
      refresh: async () => {}
    });
    await assert.rejects(api.approve(manual(null)));
    assert.equal(calls[0].p_expected_legacy_balance, null);
    fail = false;
    await api.retry('alumno', 4);
    assert.equal(calls[1].p_expected_legacy_balance, 4);
    assert.equal(calls[1].p_request_key, calls[0].p_request_key);
    assert.equal(api.getPending('alumno'), null);

    const kept = [];
    const keptStore = new mod.StudentCreditIntentStore(storage());
    let keepFail = true;
    const keptApi = mod.createStudentCreditOperations({
      actorId: 'owner', store: keptStore,
      rpc: async (_name, args) => {
        kept.push(args.p_expected_legacy_balance);
        if (keepFail) return { data: null, error: { message: 'Conexion perdida' } };
        return receipt(args);
      },
      refresh: async () => {}
    });
    await assert.rejects(keptApi.approve(manual(4)));
    keepFail = false;
    await keptApi.retry('alumno', 9);
    assert.deepEqual(kept, [4, 4]);

    const replayed = [];
    const replay = new mod.StudentCreditIntentStore(storage());
    let lost = true;
    const replayApi = mod.createStudentCreditOperations({
      actorId: 'owner', store: replay,
      rpc: async (_name, args) => {
        replayed.push(args.p_expected_legacy_balance);
        if (lost) { lost = false; return { data: null, error: { message: 'Conexion perdida' } }; }
        return receipt(args);
      },
      refresh: async () => {}
    });
    await assert.rejects(replayApi.approve(manual(null)));
    await replayApi.retry('alumno');
    assert.deepEqual(replayed, [null, null]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recognized rejection notifies before refresh and a failed refresh keeps the original intent', async () => {
  const { dir, mod } = await bundle('context/data/studentCreditOps.ts');
  try {
    const store = new mod.StudentCreditIntentStore(storage());
    let refreshStarted = false;
    let seen = null;
    const api = mod.createStudentCreditOperations({
      actorId: 'owner', store,
      rpc: async () => ({ data: null, error: { code: '40001', message: 'Stale legacy balance observation' } }),
      refresh: async () => { refreshStarted = true; },
      onRecognizedRejection: (detail) => {
        seen = { ...detail, pending: api.getPending('alumno') !== null, refreshStarted };
      }
    });
    await assert.rejects(api.approve(manual(4)), error => error.code === '40001');
    assert.equal(seen.code, '40001');
    assert.equal(seen.message, 'Los datos del alumno han cambiado. Se han recargado; vuelva a intentarlo.');
    assert.equal(seen.pending, true);
    assert.equal(seen.refreshStarted, false);
    assert.equal(refreshStarted, true);
    assert.equal(api.getPending('alumno'), null);

    const kept = new mod.StudentCreditIntentStore(storage());
    const keptApi = mod.createStudentCreditOperations({
      actorId: 'owner', store: kept,
      rpc: async () => ({ data: null, error: { code: '40001', message: 'Stale legacy balance observation' } }),
      refresh: async () => { throw new Error('Rejected refresh unavailable'); },
      onRecognizedRejection: () => { throw new Error('ui'); }
    });
    await assert.rejects(keptApi.approve(manual(4)), /Rejected refresh unavailable/);
    assert.equal(keptApi.getPending('alumno')?.requestKey, 'request-1');
    assert.equal(mod.isProvedCreditRejection('40001'), true);
    assert.equal(mod.isProvedCreditRejection('08006'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
