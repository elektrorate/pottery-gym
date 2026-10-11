import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const memberId = '20000000-0000-0000-0000-000000000001';
const temporaryId = '20000000-0000-0000-0000-000000000002';
const oldCardId = '40000000-0000-0000-0000-000000000001';
const newCardId = '40000000-0000-0000-0000-000000000002';
const sessionId = '30000000-0000-0000-0000-000000000001';
let server: ViteDevServer;
let origin: string;

// Interaction-only CSS replaces the production CDN styling/fonts. The actual
// CalendarView and atomic receipt store are mounted, never the application entry.
test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    plugins: [react(), {
      name: 'calendar-no-supabase',
      resolveId(source) { if (/supabase/i.test(source)) return '\0calendar-forbidden-supabase'; },
      load(id) { if (id === '\0calendar-forbidden-supabase') return "throw new Error('Calendar harness must not import Supabase');"; }
    }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  const externalRequests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.route('**/calendar-atomic-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      * { box-sizing: border-box; } body { margin: 0; font: 14px system-ui; } svg { width: 1em; height: 1em; }
      button, input, select { font: inherit; max-width: 100%; } button { cursor: pointer; } button:disabled { cursor: not-allowed; }
      input, select { width: 100%; } p { overflow-wrap: anywhere; } label { display: block; min-width: 0; }
      fieldset { min-width: 0; margin: 0; border: 0; padding: 12px; } .flex { display: flex; } .flex-col { flex-direction: column; }
      .flex-wrap { flex-wrap: wrap; } .flex-1 { flex: 1; } .shrink-0 { flex-shrink: 0; } .min-h-0 { min-height: 0; }
      .min-w-0 { min-width: 0; } .grid { display: grid; gap: 12px; } .grid-cols-2 { grid-template-columns: 1fr 1fr; }
      .grid-cols-3 { grid-template-columns: repeat(3, 1fr); } .h-full { height: 100%; } .w-full { width: 100%; }
      .overflow-hidden { overflow: hidden; } .overflow-y-auto { overflow-y: auto; } .overflow-x-auto { overflow-x: auto; }
      .fixed { position: fixed; inset: 0; z-index: 100; background: #eee; justify-content: center; }
      [role="dialog"] { width: 100%; max-width: 768px; height: 100dvh; min-height: 0; background: white; }
      [role="dialog"] > header, [role="dialog"] > footer { padding: 12px; gap: 12px; align-items: center; }
      [role="dialog"] > header { justify-content: space-between; } [role="dialog"] > footer { justify-content: flex-end; }
      [role="dialog"] > [role="alert"] { padding: 12px; flex-shrink: 0; }
      [data-session-id] { position: relative; width: 100% !important; min-height: 0 !important; margin-bottom: 12px; padding: 12px; }
      [data-student-id] { gap: 8px; padding: 6px; } [class~="max-h-[230px]"] { max-height: 230px; }
      [class~="max-h-40"] { max-height: 240px; } [class~="truncate"] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      @media(min-width:768px) { [class~="md:grid-cols-[0.9fr_1.1fr]"] { grid-template-columns: 0.9fr 1.1fr; } }
    </style></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/calendar-atomic-harness.tsx');
    </script></body></html>` }));
  await page.goto(`${origin}/calendar-atomic-test`);
  await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
  // These arrays keep accumulating during the interaction, not just initial load.
  await page.exposeFunction('calendarTestAssertIsolation', () => {
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => (window as any).calendarTestAssertIsolation());
  expect(await output(page, 'forbidden-calls')).toEqual([]);
});

const output = async (page: Page, id: string) => JSON.parse((await page.getByTestId(id).textContent())!);
const mode = (page: Page, value: string) => page.evaluate(value => window.dispatchEvent(new CustomEvent('calendar-test-mode', { detail: value })), value);
const fixture = (page: Page, value: string) => page.evaluate(value => window.dispatchEvent(new CustomEvent('calendar-test-fixture', { detail: value })), value);
const attendanceDialog = (page: Page) => page.getByRole('dialog', { name: 'Control de asistencia', exact: true });
const sessionDialog = (page: Page) => page.getByRole('dialog', { name: /^(Nueva|Editar) sesión$/ });
const attendanceRow = (page: Page, id: string) => attendanceDialog(page).locator(`[data-student-id="${id}"]`);
const mark = (page: Page, id: string, present: boolean) => attendanceRow(page, id).getByRole('button', { name: present ? /Marcar asistencia/ : /Marcar falta/ }).click();
const openAttendance = (page: Page) => page.getByRole('button', { name: 'Abrir control de asistencia', exact: true }).click();
const newReservation = async (page: Page) => {
  await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
  await page.getByLabel('Hora de inicio').fill('14:00');
  await page.getByLabel('Hora de fin').fill('16:00');
  await page.getByLabel('Profesor', { exact: false }).selectOption('teacher');
  await sessionDialog(page).getByRole('button', { name: 'Ambos', exact: true }).click();
};
const selectStudent = (page: Page, id: string) => sessionDialog(page).locator(`button[data-student-id="${id}"]`).click();
const funding = (page: Page, id: string) => sessionDialog(page).getByRole('combobox', { name: `Financiación de Alex Perez (${id.slice(-8)})`, exact: true });

test('homonyms reserve separate IDs and await persistence before closing', async ({ page }) => {
  await newReservation(page);
  await selectStudent(page, temporaryId);
  await expect(sessionDialog(page).locator(`button[data-student-id="${memberId}"]`)).toHaveAttribute('aria-pressed', 'false');
  await selectStudent(page, memberId);
  await expect(funding(page, memberId)).toHaveValue('');
  await expect(funding(page, temporaryId)).toHaveValue('');
  await mode(page, 'waiting');
  await sessionDialog(page).getByRole('button', { name: 'Crear sesión', exact: true }).click();
  await expect(sessionDialog(page).getByRole('button', { name: /Guardando/ })).toBeDisabled();
  await expect(sessionDialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  await sessionDialog(page).getByRole('button', { name: /Guardando/ }).evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await output(page, 'calls')).toHaveLength(1);
  expect(await output(page, 'sessions')).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event('calendar-test-release')));
  await expect(sessionDialog(page)).toHaveCount(0);
  const saved = (await output(page, 'calls'))[0];
  expect(saved.action).toBe('add');
  expect(saved.data.studentIds).toEqual([temporaryId, memberId]);
  expect(saved.data.students).toEqual(['Alex Perez', 'Alex Perez']);
  expect(saved.data.giftCardIdByStudentId).toEqual({});
  expect((await output(page, 'rpc-calls'))[0]).toMatchObject({ name: 'save_session_reservation', args: { p_student_ids: [memberId, temporaryId], p_gift_card_ids: {} } });
});

test('funding requires an explicit recipient-ID match and never chooses the latest card', async ({ page }) => {
  await newReservation(page);
  await selectStudent(page, temporaryId);
  const selector = funding(page, temporaryId);
  await expect(selector).toHaveValue('');
  await expect(selector.locator('option')).toHaveCount(3);
  expect(await selector.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['', newCardId, oldCardId]);
  await expect(selector.locator(`option[value="${oldCardId}"]`)).toHaveText('Bono de Alex Perez (00000001)');
  await selector.selectOption(oldCardId);
  await sessionDialog(page).getByRole('button', { name: 'Crear sesión', exact: true }).click();
  await expect(sessionDialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[0].data.giftCardIdByStudentId).toEqual({ [temporaryId]: oldCardId });
  const added = page.locator('[data-session-id="30000000-0000-0000-0000-000000000002"]');
  await added.getByRole('button', { name: 'Abrir control de asistencia' }).click();
  await mark(page, temporaryId, true);
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls')).map((call: any) => call.name)).toEqual(['save_session_reservation', 'save_session_attendance']);
});

test('finalization submits one full ID batch with exact revision and no standalone debits', async ({ page }) => {
  await openAttendance(page);
  await mark(page, memberId, true);
  await expect(attendanceRow(page, temporaryId)).toHaveAttribute('data-attendance-status', 'pending');
  await mark(page, temporaryId, true);
  await page.getByLabel('Reemplazo', { exact: true }).selectOption('substitute');
  expect(await output(page, 'calls')).toEqual([]);
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
  const callbacks = await output(page, 'calls');
  expect(callbacks).toHaveLength(1);
  expect(callbacks[0]).toMatchObject({ action: 'update', id: sessionId, data: {
    attendanceByStudentId: { [memberId]: 'present', [temporaryId]: 'present' }, revision: 7, teacherSubstituteId: 'substitute'
  } });
  expect(Object.keys(callbacks[0].data).sort()).toEqual(['attendanceByStudentId', 'completedAt', 'revision', 'teacherSubstituteId']);
  expect(callbacks[0].data.completedAt).toBe('2026-10-11T12:00:00.000Z');
  expect((await output(page, 'rpc-calls'))[0]).toMatchObject({ name: 'save_session_attendance', args: {
    p_expected_revision: 7, p_attendance: [{ student_id: memberId, status: 'present' }, { student_id: temporaryId, status: 'present' }], p_finalize: true, p_teacher_substitute_id: 'substitute'
  } });
  await expect(page.locator(`[data-session-id="${sessionId}"] [data-student-id="${temporaryId}"]`)).toHaveAttribute('data-attendance-status', 'present');
});

test('correction reverses by full ID batch, retains completion history and has no deletion action', async ({ page }) => {
  await fixture(page, 'completed');
  await openAttendance(page);
  await expect(attendanceRow(page, temporaryId).getByRole('button', { name: /Marcar falta/ })).toBeDisabled();
  await attendanceDialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  await mark(page, temporaryId, false);
  await attendanceDialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
  const saved = (await output(page, 'calls'))[0];
  expect(saved.data).toEqual({ attendanceByStudentId: { [temporaryId]: 'absent', [memberId]: 'present' }, revision: 12, teacherSubstituteId: '' });
  expect((await output(page, 'rpc-calls'))[0].args.p_finalize).toBe(true);
  expect((await output(page, 'sessions'))[0].completedAt).toBe('2026-10-11T08:00:00Z');
  await openAttendance(page);
  await expect(attendanceRow(page, temporaryId)).toHaveAttribute('data-attendance-status', 'absent');
  await attendanceDialog(page).getByRole('button', { name: 'Cerrar', exact: true }).click();
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await expect(sessionDialog(page).getByRole('button', { name: /Eliminar/ })).toHaveCount(0);
  await expect(sessionDialog(page)).toContainText('Las sesiones no se pueden eliminar');
  await expect(funding(page, temporaryId)).toHaveValue(oldCardId);
  await expect(funding(page, temporaryId)).toBeDisabled();
});

test('failed attendance keeps the modal and same frozen target until an exact receipt retry succeeds', async ({ page }) => {
  await openAttendance(page);
  await mark(page, memberId, false);
  await mark(page, temporaryId, true);
  await mode(page, 'lost-response');
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page).getByRole('alert')).toContainText('respuesta perdida');
  await expect(attendanceDialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  await expect(attendanceRow(page, memberId).getByRole('button', { name: /Marcar asistencia/ })).toBeDisabled();
  await expect(page.getByLabel('Reemplazo', { exact: true })).toBeDisabled();
  expect(await output(page, 'calls')).toHaveLength(1);
  const retained = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`atomic-session-intent:local:${id}`)!), sessionId);
  expect(retained.args.p_expected_revision).toBe(7);
  await fixture(page, 'roll-forward');
  await mode(page, 'success');
  await attendanceDialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
  const callbacks = await output(page, 'calls');
  expect(callbacks[1].data).toEqual(callbacks[0].data);
  expect(callbacks[1].sameObjectAsPrevious).toBe(true);
  const writes = await output(page, 'rpc-calls');
  expect(writes[1]).toEqual(writes[0]);
  expect((await output(page, 'sessions'))[0].revision).toBe(20);
  expect(await page.evaluate(id => sessionStorage.getItem(`atomic-session-intent:local:${id}`), sessionId)).toBeNull();
});

test('failed reservation retains IDs, funding and metadata; retries the same object without background saves', async ({ page }) => {
  await newReservation(page);
  await selectStudent(page, temporaryId);
  await funding(page, temporaryId).selectOption(oldCardId);
  await mode(page, 'transport');
  await sessionDialog(page).getByRole('button', { name: 'Crear sesión', exact: true }).click();
  await expect(sessionDialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await expect(page.getByLabel('Hora de inicio')).toBeDisabled();
  await expect(funding(page, temporaryId)).toHaveValue(oldCardId);
  await expect(sessionDialog(page).getByRole('button', { name: 'Cancelar', exact: true })).toBeDisabled();
  expect(await output(page, 'sessions')).toHaveLength(1);
  expect(await output(page, 'calls')).toHaveLength(1);
  await mode(page, 'success');
  await sessionDialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click();
  await expect(sessionDialog(page)).toHaveCount(0);
  const saved = await output(page, 'calls');
  expect(saved[1].data).toEqual(saved[0].data);
  expect(saved[1].sameObjectAsPrevious).toBe(true);
  const writes = await output(page, 'rpc-calls');
  expect(writes[1]).toEqual(writes[0]);
});

test('known SQL balance rejection leaves attendance editable and offers no bypass confirmation', async ({ page }) => {
  await fixture(page, 'zero-balance');
  await openAttendance(page);
  await mark(page, memberId, true);
  await mark(page, temporaryId, false);
  await mode(page, 'rollback');
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page).getByRole('alert')).toContainText('Saldo insuficiente');
  await expect(attendanceRow(page, memberId).getByRole('button', { name: /Marcar falta/ })).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /igualmente|habilitar nuevos intentos/i })).toHaveCount(0);
  expect((await output(page, 'sessions'))[0]).not.toHaveProperty('completedAt');
  expect(await page.evaluate(id => sessionStorage.getItem(`atomic-session-intent:local:${id}`), sessionId)).toBeNull();
  await mark(page, memberId, false);
  await mode(page, 'success');
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
});

test('40001 reloads the attendance view and requires review before a new revision is submitted', async ({ page }) => {
  await openAttendance(page);
  await mark(page, memberId, true);
  await mark(page, temporaryId, false);
  await mode(page, 'stale');
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page).getByRole('alert')).toContainText('Revisa los datos recargados');
  await expect(attendanceRow(page, memberId)).toHaveAttribute('data-attendance-status', 'absent');
  await expect(attendanceRow(page, temporaryId)).toHaveAttribute('data-attendance-status', 'present');
  await expect(page.getByLabel('Reemplazo', { exact: true })).toHaveValue('substitute');
  expect(await output(page, 'calls')).toHaveLength(1);
  expect(await output(page, 'refreshes')).toBe(1);
  await mark(page, memberId, true);
  await mode(page, 'success');
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[1].data.revision).toBe(8);
  expect((await output(page, 'rpc-calls'))[1].args.p_expected_revision).toBe(8);
});

test('edited reservation uses persisted IDs and refreshes its baseline after a stale rollback', async ({ page }) => {
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await expect(sessionDialog(page).locator('button[data-student-id][aria-pressed="true"]')).toHaveCount(2);
  await page.getByLabel('Cupo máximo').fill('6');
  await mode(page, 'stale');
  await sessionDialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(sessionDialog(page).getByRole('alert')).toContainText('Revision obsoleta');
  await expect(page.getByLabel('Hora de inicio')).toHaveValue('10:30');
  await expect(page.getByLabel('Cupo máximo')).toHaveValue('5');
  expect((await output(page, 'calls'))[0].data.studentIds).toEqual([temporaryId, memberId]);
  expect((await output(page, 'calls'))[0].data.revision).toBe(7);
  await mode(page, 'success');
  await sessionDialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(sessionDialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[1].data.revision).toBe(8);
});

for (const invalid of ['legacy', 'misaligned']) test(`${invalid} roster cannot be guessed from homonym display names`, async ({ page }) => {
  await fixture(page, invalid);
  await openAttendance(page);
  await expect(page.getByRole('alert')).toContainText('IDs persistidos y alineados');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await expect(page.getByRole('alert')).toContainText('no se identificarán alumnos por nombre');
  expect(await output(page, 'calls')).toEqual([]);
});

test('pending statuses and missing revisions fail before callbacks', async ({ page }) => {
  await openAttendance(page);
  await mark(page, memberId, true);
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page).getByRole('alert')).toContainText('Completa la asistencia');
  expect(await output(page, 'calls')).toEqual([]);
  await attendanceDialog(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  await fixture(page, 'missing-revision');
  await openAttendance(page);
  await mark(page, memberId, true);
  await mark(page, temporaryId, false);
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page).getByRole('alert')).toContainText('revisión');
  expect(await output(page, 'calls')).toEqual([]);
});

test('an explicit false callback keeps a correction modal and retries the same target', async ({ page }) => {
  await fixture(page, 'completed');
  await openAttendance(page);
  await attendanceDialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  await mark(page, temporaryId, false);
  await mode(page, 'false');
  await attendanceDialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(attendanceDialog(page).getByRole('alert')).toContainText('No se confirmó');
  await expect(attendanceDialog(page).getByRole('button', { name: 'Cancelar edición', exact: true })).toBeDisabled();
  await mode(page, 'success');
  await attendanceDialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[1].sameObjectAsPrevious).toBe(true);
});

test('mobile homonyms, explicit funding and aligned snapshots remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await newReservation(page);
  await selectStudent(page, temporaryId);
  await selectStudent(page, memberId);
  await funding(page, temporaryId).selectOption(oldCardId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await sessionDialog(page).getByRole('button', { name: 'Crear sesión', exact: true }).click();
  await expect(sessionDialog(page)).toHaveCount(0);
  await fixture(page, 'remove-students');
  await openAttendance(page);
  await expect(attendanceRow(page, memberId)).toContainText('alex perez');
  await expect(attendanceRow(page, temporaryId)).toContainText('ID 00000002');
  await mark(page, memberId, false);
  await mark(page, temporaryId, true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await attendanceDialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(attendanceDialog(page)).toHaveCount(0);
});
