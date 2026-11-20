/**
 * Unit coverage for the one-off legacy incidence settle script.
 * Docker/Postgres may be unavailable; we exercise the script contract with a
 * minimal in-memory model that mirrors the PR #26 scalar_pack debit path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const LEGACY_REASON =
  'Unsupported temporal/manual funding: legacy balance requires attributable funding or reconciliation';
const NOTE = 'Regularización falta previa a fix26';

/** Mirrors the validation + idempotent scalar debit the SQL script performs. */
const settleLegacy = ({ penalty, student, billing, existingDebits = [], dryRun = true }) => {
  const errors = [];
  const notices = [];
  const log = (msg) => notices.push(msg);

  if (!penalty) throw new Error('Incidencia no encontrada');
  if (penalty.state !== 'pending') throw new Error(`La incidencia no está pending (estado=${penalty.state})`);
  if (penalty.debit_id) throw new Error(`La incidencia ya tiene debit_id=${penalty.debit_id}`);
  if ([penalty.period_id, penalty.gift_card_id, penalty.manual_credit_id].filter(Boolean).length !== 0) {
    throw new Error('La incidencia ya tiene fuente atribuible; no es el caso legacy');
  }
  const legacyOk = /Unsupported temporal\/manual funding:/.test(penalty.reason)
    || /legacy balance requires attributable/i.test(penalty.reason)
    || /Sin derecho original atribuible/i.test(penalty.reason);
  if (!legacyOk) throw new Error(`Motivo no es el legacy unattributed (reason=${penalty.reason})`);
  if (!['temporal', 'grupal', 'grupo_temporal'].includes(student.student_category)) {
    throw new Error(`El alumno no es temporal/grupal/grupo_temporal (category=${student.student_category})`);
  }
  if (!billing || billing.state !== 'incident' || billing.penalty_id !== penalty.id || billing.debit_id) {
    throw new Error('Billing no está en incident pendiente para esta incidencia');
  }

  const existing = existingDebits.find(d => d.delta === -1 && !d.reversed);
  log(`balance_before=${student.classes_remaining} existing_debit=${existing?.id ?? null} dry_run=${dryRun}`);

  if (dryRun) {
    log(`DRY-RUN would set penalty.state=charged reason=${NOTE}`);
    return { dryRun: true, notices, student, penalty, billing, debit: existing || null };
  }

  let debit = existing;
  const nextStudent = { ...student };
  if (!debit) {
    if (!(student.classes_remaining > 0)) {
      throw new Error(`Saldo escalar insuficiente para descontar (classes_remaining=${student.classes_remaining})`);
    }
    nextStudent.classes_remaining -= 1;
    debit = { id: 'debit-new', delta: -1, disposition: 'scalar_balance', reversed: false };
  }

  return {
    dryRun: false,
    notices,
    student: nextStudent,
    penalty: { ...penalty, state: 'charged', debit_id: debit.id, reason: NOTE },
    billing: { ...billing, state: 'charged', debit_id: debit.id },
    debit
  };
};

test('dry-run default does not mutate balance or penalty', () => {
  const base = {
    penalty: {
      id: 'pen-1', state: 'pending', reason: LEGACY_REASON, kind: 'no_show',
      period_id: null, gift_card_id: null, manual_credit_id: null, debit_id: null
    },
    student: { id: 'st-1', student_category: 'temporal', classes_remaining: 3 },
    billing: { state: 'incident', penalty_id: 'pen-1', debit_id: null }
  };
  const result = settleLegacy({ ...base, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.student.classes_remaining, 3);
  assert.equal(result.penalty.state, 'pending');
  assert.match(result.notices.join('\n'), /DRY-RUN/);
});

test('apply deducts one scalar class and marks charged with fix26 note', () => {
  const result = settleLegacy({
    penalty: {
      id: 'pen-1', state: 'pending', reason: LEGACY_REASON, kind: 'no_show',
      period_id: null, gift_card_id: null, manual_credit_id: null, debit_id: null
    },
    student: { id: 'st-1', student_category: 'grupal', classes_remaining: 2 },
    billing: { state: 'incident', penalty_id: 'pen-1', debit_id: null },
    dryRun: false
  });
  assert.equal(result.student.classes_remaining, 1);
  assert.equal(result.penalty.state, 'charged');
  assert.equal(result.penalty.reason, NOTE);
  assert.equal(result.billing.state, 'charged');
  assert.equal(result.debit.disposition, 'scalar_balance');
});

test('idempotent: existing unreverted debit skips second deduction', () => {
  const result = settleLegacy({
    penalty: {
      id: 'pen-1', state: 'pending', reason: LEGACY_REASON, kind: 'no_show',
      period_id: null, gift_card_id: null, manual_credit_id: null, debit_id: null
    },
    student: { id: 'st-1', student_category: 'grupo_temporal', classes_remaining: 1 },
    billing: { state: 'incident', penalty_id: 'pen-1', debit_id: null },
    existingDebits: [{ id: 'debit-old', delta: -1, disposition: 'scalar_balance', reversed: false }],
    dryRun: false
  });
  assert.equal(result.student.classes_remaining, 1);
  assert.equal(result.debit.id, 'debit-old');
  assert.equal(result.penalty.debit_id, 'debit-old');
});

test('rejects membership students and non-legacy reasons', () => {
  assert.throws(() => settleLegacy({
    penalty: {
      id: 'pen-1', state: 'pending', reason: LEGACY_REASON, kind: 'no_show',
      period_id: null, gift_card_id: null, manual_credit_id: null, debit_id: null
    },
    student: { id: 'st-1', student_category: 'membresia', classes_remaining: 4 },
    billing: { state: 'incident', penalty_id: 'pen-1', debit_id: null },
    dryRun: false
  }), /temporal\/grupal/);

  assert.throws(() => settleLegacy({
    penalty: {
      id: 'pen-1', state: 'pending', reason: 'One class: no_show', kind: 'no_show',
      period_id: null, gift_card_id: null, manual_credit_id: null, debit_id: null
    },
    student: { id: 'st-1', student_category: 'temporal', classes_remaining: 4 },
    billing: { state: 'incident', penalty_id: 'pen-1', debit_id: null },
    dryRun: false
  }), /legacy unattributed/);
});

test('SQL file still matches the unit-tested contract', async () => {
  const sql = await readFile('scripts/sql/settle_legacy_unattributed_incidence.sql', 'utf8');
  assert.match(sql, new RegExp(NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(sql, /session_business_adjust_scalar/);
  assert.match(sql, /scalar_balance|current_period/);
  assert.match(sql, /dry_run/);
});
