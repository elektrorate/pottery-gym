import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const loaded = await (async () => {
  const result = await build({ entryPoints: ['tests/qa-admin-entry.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const dir = await mkdtemp(path.join(tmpdir(), 'qa-admin-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return { dir, mod };
})();
const { parseSpanishQuantity, findScheduleOverlaps, findTeacherOverlaps, layoutOverlapping, rangesOverlap, visibleHourRange, foldAccents, includesFolded, membershipPeriodEnd, isPaymentPendingToday, scheduledRenewals, mapUserFacingError, inventoryAlertLabel, inventoryHealth, lateCancellationOutcome, cancellationPreview, presentInitials, sessionsForStudent, positiveAmountError } = loaded.mod;
test.after(() => rm(loaded.dir, { recursive: true, force: true }));

const student = (overrides) => ({
  id: 's', name: 'Ana', phone: '', studentCategory: 'membresia', status: 'membresia',
  paymentStatus: 'paid', classesRemaining: 4, ...overrides
});

test('spanish quantities keep the decimal comma and reject junk', () => {
  assert.deepEqual(parseSpanishQuantity('2,5'), { ok: true, value: 2.5 });
  assert.deepEqual(parseSpanishQuantity('12,5'), { ok: true, value: 12.5 });
  assert.deepEqual(parseSpanishQuantity('25'), { ok: true, value: 25 });
  assert.equal(parseSpanishQuantity('-3').ok && parseSpanishQuantity('-3').value, -3);
  assert.equal(parseSpanishQuantity('2,5 kg').ok, false);
  assert.equal(positiveAmountError(-12, 'La cuota', 'f'), 'La cuota no puede ser negativa.');
});

test('membership period end matches the database month-end minus one day', () => {
  assert.equal(membershipPeriodEnd('2026-11-21'), '2026-12-20');
  assert.equal(membershipPeriodEnd('2026-01-31'), '2026-02-27');
  assert.equal(membershipPeriodEnd('2026-03-31'), '2026-04-29');
});

test('pending today ignores future renewals and archived students', () => {
  const today = '2026-11-21';
  const currentPaid = student({
    membershipPeriods: [
      { id: 'now', studentId: 's', startsOn: '2026-11-21', endsOn: '2026-12-20', paymentStatus: 'paid' },
      { id: 'next', studentId: 's', startsOn: '2026-12-21', endsOn: '2027-01-20', paymentStatus: 'pending' }
    ]
  });
  assert.equal(isPaymentPendingToday(currentPaid, today), false);
  assert.equal(scheduledRenewals(currentPaid, today).length, 1);
  const currentPending = student({ paymentStatus: 'pending' });
  assert.equal(isPaymentPendingToday(currentPending, today), true);
  assert.equal(isPaymentPendingToday(student({ archivedAt: '2026-01-01', paymentStatus: 'pending' }), today), false);
  assert.equal(isPaymentPendingToday(student({ studentCategory: 'temporal', paymentStatus: 'pending' }), today), true);
  assert.equal(isPaymentPendingToday(student({ studentCategory: 'grupo_temporal', paymentStatus: 'paid' }), today), false);
});

test('teacher overlaps and side-by-side layout', () => {
  assert.equal(rangesOverlap({ startTime: '10:00', endTime: '12:00' }, { startTime: '11:00', endTime: '13:00' }), true);
  assert.equal(rangesOverlap({ startTime: '10:00', endTime: '12:00' }, { startTime: '12:00', endTime: '13:00' }), false);
  const hits = findTeacherOverlaps(
    { id: 'new', date: '2026-11-21', startTime: '10:30', endTime: '12:00', teacherId: 'ana', label: 'Nueva' },
    [{ id: 'old', date: '2026-11-21', startTime: '10:00', endTime: '11:30', teacherId: 'ana', label: 'Torno 10:00' }]
  );
  assert.equal(hits.length, 1);
  const columns = layoutOverlapping([
    { id: 'a', startTime: '10:00', endTime: '12:00' },
    { id: 'b', startTime: '11:00', endTime: '13:00' }
  ]);
  assert.equal(columns.get('a').columns, 2);
  assert.notEqual(columns.get('a').column, columns.get('b').column);
  assert.deepEqual(visibleHourRange([{ startTime: '10:00', endTime: '12:30' }], []), { startHour: 10, endHour: 13 });
  const activityHits = findScheduleOverlaps(
    { id: 'act', date: '2026-11-21', startTime: '10:00', endTime: '11:00', label: 'Reunión', kind: 'activity' },
    [{ id: 'class', date: '2026-11-21', startTime: '10:30', endTime: '12:00', label: 'Mesa', kind: 'session' }]
  );
  assert.equal(activityHits[0].label, 'Mesa');
});

test('search ignores accents and case, including ñ', () => {
  assert.equal(includesFolded('Karen Díaz', 'diaz'), true);
  assert.equal(includesFolded('Ñandú', 'nandu'), true);
  assert.equal(foldAccents('ÁÉÍÓÚ'), 'aeiou');
});

test('rpc errors become spanish and unknown sql does not leak', () => {
  assert.match(mapUserFacingError(new Error('No-credit exception cannot bypass available credit: Original scalar pack payment is unpaid or unknown')), /pago del bono está pendiente/);
  assert.match(mapUserFacingError(new Error('violates check constraint "sessions_check"')), /No se pudo guardar/);
  assert.equal(mapUserFacingError(new Error('El nombre es obligatorio.')), 'El nombre es obligatorio.');
});

test('inventory health matches the summary bands', () => {
  assert.equal(inventoryHealth({ current_quantity: 0, min_quantity: 2 }), 'critical');
  assert.equal(inventoryAlertLabel('critical', 0), 'Agotado');
  assert.equal(inventoryHealth({ current_quantity: 1, min_quantity: 4 }), 'critical');
  assert.equal(inventoryAlertLabel('critical', 1), 'Crítico');
  assert.equal(inventoryHealth({ current_quantity: 3, min_quantity: 4 }), 'low');
  assert.equal(inventoryAlertLabel('low', 3), 'Stock bajo');
  assert.equal(inventoryHealth({ current_quantity: 8, min_quantity: 4 }), 'ok');
});

test('late cancellation copy follows the payment', () => {
  const pack = student({ studentCategory: 'temporal', paymentStatus: 'pending' });
  assert.match(lateCancellationOutcome(pack, { cancellationKind: 'late' }, '2026-11-21'), /no se descontará una clase/);
  assert.match(lateCancellationOutcome(student({ paymentStatus: 'paid' }), { cancellationKind: 'late', billingState: 'charged' }, '2026-11-21'), /se descontó una clase/);
  assert.match(cancellationPreview(9), /no se descontará/);
  assert.match(cancellationPreview(3), /menos de 8 horas/);
});

test('initials use the first two words and ignore dashes', () => {
  assert.equal(presentInitials('ignacia', 'rosas'), 'IR');
  assert.equal(presentInitials('McDonald'), 'M');
  assert.equal(presentInitials('Ana-María', 'López'), 'AM');
});

test('history sessions match by id even when the roster name differs', () => {
  const karen = student({ id: 'karen', name: 'Karen', surname: 'Díaz' });
  const sessions = [{
    id: 'class', date: '2026-11-20', startTime: '10:00', endTime: '12:00', classType: 'mesa',
    students: ['Otro nombre'], studentIds: ['karen'], attendanceByStudentId: { karen: 'present' }, completedAt: '2026-11-20T12:00:00Z'
  }];
  assert.equal(sessionsForStudent(sessions, karen).length, 1);
});
