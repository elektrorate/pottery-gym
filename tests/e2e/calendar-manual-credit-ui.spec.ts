import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manualCreditIds as ids, manualCreditIsolationPlugin, manualCreditHarnessHtml } from '../fixtures/calendar-manual-credit-ui-harness';

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    cacheDir: join(tmpdir(), 'opencode', 'vite-calendar-manual-credit-ui'), plugins: [react(), manualCreditIsolationPlugin()],
    optimizeDeps: { entries: ['tests/fixtures/calendar-manual-credit-ui-harness.tsx'],
      include: ['react', 'react-dom/client', 'react-router-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  const violations: string[] = [];
  page.on('pageerror', error => violations.push(error.message));
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    violations.push(route.request().url()); return route.abort();
  });
  await page.route('**/calendar-manual-credit-test', route => route.fulfill({ contentType: 'text/html', body: manualCreditHarnessHtml }));
  await page.exposeFunction('assertManualCreditIsolation', () => expect(violations).toEqual([]));
  await page.goto(`${origin}/calendar-manual-credit-test`);
  await expect(page.getByRole('button', { name: /Nueva sesi.n/, exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => (window as any).assertManualCreditIsolation());
  const writes = await output(page, 'rpc-calls');
  expect(writes.every((call: any) => ['save_session_reservation', 'save_session_attendance'].includes(call.name))).toBe(true);
});

const output = async (page: Page, id: string) => JSON.parse((await page.getByTestId(id).textContent())!);
const configure = (page: Page, value: Record<string, string>) => page.evaluate(value => window.dispatchEvent(new CustomEvent('manual-credit-configure', { detail: value })), value);
const dialog = (page: Page) => page.getByRole('dialog', { name: /^(Nueva|Editar) sesi.n$/ });
const funding = (page: Page, id: string) => dialog(page).getByRole('combobox', { name: new RegExp(`Financiaci.n.*${id.slice(-8)}`) });
const selectedRow = (page: Page, id: string) => dialog(page).locator(`div[data-student-id="${id}"]`);
const selectStudent = (page: Page, id: string) => dialog(page).locator(`button[data-student-id="${id}"]`).click();
const editReservation = (page: Page) => page.locator(`[data-session-id="${ids.session}"]`).click();
const enabledManualOptions = (page: Page, id: string) => funding(page, id).locator('option[value^="manual:"]:not([disabled])')
  .evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
const newReservation = async (page: Page) => {
  await page.getByRole('button', { name: /Nueva sesi.n/, exact: true }).click();
  await dialog(page).getByLabel('Hora de inicio').fill('14:00');
  await dialog(page).getByLabel('Hora de fin').fill('16:00');
  await dialog(page).getByLabel('Profesor', { exact: false }).selectOption('teacher');
  await dialog(page).getByRole('button', { name: 'Ambos', exact: true }).click();
};
const create = (page: Page) => dialog(page).getByRole('button', { name: /Crear sesi.n/, exact: true }).click();
const save = (page: Page) => dialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();

test('new homonym reservations never auto-select manual, gift or unsupported scalar balances', async ({ page }) => {
  await newReservation(page);
  await selectStudent(page, ids.other); await selectStudent(page, ids.member);
  await expect(funding(page, ids.member)).toHaveValue(''); await expect(funding(page, ids.other)).toHaveValue('');
  await expect(dialog(page).locator(`button[data-student-id="${ids.archived}"]`)).toHaveCount(0);
  expect(await enabledManualOptions(page, ids.member)).toEqual([`manual:${ids.replacement}`, `manual:${ids.original}`, `manual:${ids.boundary}`]);
  expect(await enabledManualOptions(page, ids.other)).toEqual(['manual:other-manual']);
  await expect(funding(page, ids.member)).not.toContainText('91'); await expect(funding(page, ids.member)).not.toContainText('87');
  await create(page); await expect(dialog(page)).toHaveCount(0);
  const callback = (await output(page, 'calls'))[0];
  expect(callback.data.studentIds).toEqual([ids.other, ids.member]);
  expect(callback.data.students).toEqual(['Alex Perez', 'Alex Perez']);
  expect(callback.data.manualCreditIdByStudentId).toEqual({}); expect(callback.data.giftCardIdByStudentId).toEqual({});
  expect((await output(page, 'rpc-calls'))[0]).toMatchObject({ name: 'save_session_reservation', args: {
    p_student_ids: [ids.member, ids.other], p_gift_card_ids: {}, p_manual_credit_ids: {}
  } });
});

test('explicit manual selection shows its own balance, validity and evidence ID without client authorization claims', async ({ page }) => {
  await newReservation(page); await selectStudent(page, ids.member); await selectStudent(page, ids.other);
  await funding(page, ids.member).selectOption(`manual:${ids.original}`);
  const info = selectedRow(page, ids.member).getByTestId('selected-manual-credit-info');
  await expect(info).toContainText(`ID de credito manual: ${ids.original}`);
  await expect(info).toContainText('Saldo cargado: 2/3 clases');
  await expect(info).toContainText('2026-10-01 a 2026-10-31');
  await expect(info).toContainText(`Evidencia: documento:${ids.original}`);
  await expect(info).toContainText('La seleccion no autoriza el cargo');
  await expect(dialog(page)).not.toContainText('server-recorded-actor');
  await expect(funding(page, ids.other)).toHaveValue('');
  await create(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[0].data.manualCreditIdByStudentId).toEqual({ [ids.member]: ids.original });
  const args = (await output(page, 'rpc-calls'))[0].args;
  expect(args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original }); expect(args.p_gift_card_ids).toEqual({});
  expect(Object.keys(args).sort()).toEqual(['p_expected_revision', 'p_gift_card_ids', 'p_manual_credit_ids', 'p_metadata', 'p_request_key', 'p_sede_id', 'p_session_id', 'p_student_ids']);
});

test('one funding selector switches sources exclusively and update persists both complete maps by ID', async ({ page }) => {
  await editReservation(page);
  await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
  await expect(funding(page, ids.other)).toHaveValue(ids.gift);
  await funding(page, ids.member).selectOption('member-gift');
  await expect(selectedRow(page, ids.member).getByTestId('selected-manual-credit-info')).toHaveCount(0);
  await funding(page, ids.other).selectOption('manual:other-manual');
  await save(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[0].data).toMatchObject({
    manualCreditIdByStudentId: { [ids.other]: 'other-manual' }, giftCardIdByStudentId: { [ids.member]: 'member-gift' }, revision: 7
  });
  expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({
    p_manual_credit_ids: { [ids.other]: 'other-manual' }, p_gift_card_ids: { [ids.member]: 'member-gift' }
  });
  await editReservation(page);
  await funding(page, ids.other).selectOption(''); await funding(page, ids.member).selectOption(`manual:${ids.replacement}`);
  await save(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls'))[1].args).toMatchObject({ p_manual_credit_ids: { [ids.member]: ids.replacement }, p_gift_card_ids: {} });
});

test('removing a draft roster ID clears both source maps and reselecting it does not restore funding automatically', async ({ page }) => {
  await newReservation(page); await selectStudent(page, ids.member);
  await funding(page, ids.member).selectOption(`manual:${ids.original}`);
  await selectedRow(page, ids.member).getByRole('button', { name: /Quitar/ }).click();
  await selectStudent(page, ids.member); await expect(funding(page, ids.member)).toHaveValue('');
  await funding(page, ids.member).selectOption('member-gift');
  await selectStudent(page, ids.member); await selectStudent(page, ids.member);
  await expect(funding(page, ids.member)).toHaveValue('');
  await create(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({ p_manual_credit_ids: {}, p_gift_card_ids: {} });
});

for (const fixture of ['unavailable', 'wrong-identity-original', 'no-sede', 'foreign-session-sede']) {
  test(`${fixture} original source remains visible and is not replaced with a currently accessible entitlement`, async ({ page }) => {
    await configure(page, { fixture }); await editReservation(page);
    await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
    await expect(funding(page, ids.member)).toBeDisabled();
    const info = selectedRow(page, ids.member).getByTestId('selected-manual-credit-info');
    await expect(info).toContainText(ids.original); await expect(info).toContainText('no se sustituira automaticamente');
    await expect(info).not.toContainText(`documento:${ids.original}`);
    await save(page); await expect(dialog(page)).toHaveCount(0);
    expect((await output(page, 'rpc-calls'))[0].args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original });
  });
}

test('exhausted or archived originals display their own data, not the replacement balance, and stay selected', async ({ page }) => {
  await configure(page, { fixture: 'exhausted-original' }); await editReservation(page);
  await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
  await expect(funding(page, ids.member).locator(`option[value="manual:${ids.original}"]`)).toHaveJSProperty('disabled', true);
  await expect(selectedRow(page, ids.member).getByTestId('selected-manual-credit-info')).toContainText('Saldo cargado: 0/3 clases');
  expect(await enabledManualOptions(page, ids.member)).toContain(`manual:${ids.replacement}`);
  await dialog(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  await configure(page, { fixture: 'archived' }); await editReservation(page);
  expect(await enabledManualOptions(page, ids.member)).toEqual([]);
  await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
  await expect(selectedRow(page, ids.member).getByTestId('selected-manual-credit-info')).toContainText('Saldo cargado: 2/3 clases');
  await save(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls'))[0].args.p_manual_credit_ids).toEqual({ [ids.member]: ids.original });
});

for (const fixture of ['completed', 'cancelled']) test(`${fixture} locks original manual source and roster ID, while metadata updates retain the tombstone map`, async ({ page }) => {
  await configure(page, { fixture }); await editReservation(page);
  await expect(funding(page, ids.member)).toBeDisabled();
  await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
  await expect(selectedRow(page, ids.member).getByRole('button', { name: /Quitar/ })).toBeDisabled();
  await expect(dialog(page).locator(`button[data-student-id="${ids.member}"]`)).toBeDisabled();
  await expect(dialog(page).getByLabel(/Tipo de sesi.n/).locator('option[value="feriado"]')).toBeDisabled();
  await dialog(page).getByLabel(/Cupo m.ximo/).fill('5');
  await save(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({ p_student_ids: [ids.member, ids.other], p_manual_credit_ids: { [ids.member]: ids.original }, p_gift_card_ids: { [ids.other]: ids.gift } });
});

test('policy1 never offers manual funding and rejects a malformed persisted manual source before callbacks', async ({ page }) => {
  await configure(page, { fixture: 'policy1' }); await editReservation(page);
  expect(await enabledManualOptions(page, ids.member)).toEqual([]); expect(await enabledManualOptions(page, ids.other)).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  await configure(page, { fixture: 'policy1-manual' }); await editReservation(page); await save(page);
  await expect(dialog(page).getByRole('alert')).toContainText('politica 2');
  expect(await output(page, 'calls')).toEqual([]); expect(await output(page, 'rpc-calls')).toEqual([]);
});

for (const date of ['2026-10-05', '2026-10-20']) test(`validity must cover both Madrid today and session date ${date}, inclusively`, async ({ page }) => {
  await configure(page, { date });
  await page.getByRole('button', { name: 'Mes', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${Number(date.slice(-2))} de octubre, 1 sesi.n$`) }).click();
  await editReservation(page);
  expect(await enabledManualOptions(page, ids.member)).toEqual([`manual:${ids.replacement}`, `manual:${ids.original}`]);
  await expect(funding(page, ids.member)).not.toContainText('expired'); await expect(funding(page, ids.member)).not.toContainText('not-started');
});

test('Madrid midnight rollover removes newly invalid options but never replaces the explicitly selected original', async ({ page }) => {
  await newReservation(page); await selectStudent(page, ids.member);
  await funding(page, ids.member).selectOption(`manual:${ids.boundary}`);
  await page.clock.setFixedTime(new Date('2026-10-11T22:30:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(funding(page, ids.member).locator(`option[value="manual:${ids.boundary}"]`)).toHaveJSProperty('disabled', true);
  await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.boundary}`);
  expect(await enabledManualOptions(page, ids.member)).toEqual([`manual:${ids.replacement}`, `manual:${ids.original}`]);
});

test('source changes, roster edits, closing and duplicate submissions are blocked after a pending response; retry keeps the same object', async ({ page }) => {
  await newReservation(page); await selectStudent(page, ids.member); await selectStudent(page, ids.other);
  await funding(page, ids.member).selectOption(`manual:${ids.original}`); await funding(page, ids.other).selectOption(ids.gift);
  await configure(page, { behavior: 'waiting' }); await create(page);
  await expect(funding(page, ids.member)).toBeDisabled(); await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  await dialog(page).getByRole('button', { name: /Guardando/ }).evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await output(page, 'calls')).toHaveLength(1);
  await configure(page, { behavior: 'lost-response' }); await page.evaluate(() => window.dispatchEvent(new Event('manual-credit-release')));
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await expect(selectedRow(page, ids.member).getByRole('button', { name: /Quitar/ })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Cancelar', exact: true })).toBeDisabled();
  await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
  await configure(page, { behavior: 'success', fixture: 'roll-forward' });
  await dialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  const calls = await output(page, 'calls'); expect(calls[1].sameObjectAsPrevious).toBe(true); expect(calls[1].data).toEqual(calls[0].data);
  const writes = await output(page, 'rpc-calls'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(await output(page, 'commits')).toHaveLength(1);
});

for (const behavior of ['lost-response', 'unmount-refresh-failure']) test(`${behavior} new reservation recovery after remount never rebuilds a key, ID, source or metadata`, async ({ page }) => {
  await newReservation(page); await selectStudent(page, ids.member); await funding(page, ids.member).selectOption(`manual:${ids.original}`);
  await configure(page, { behavior }); await create(page);
  if (behavior === 'lost-response') {
    await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
    await configure(page, { fixture: 'unmount' });
  }
  await expect(page.getByTestId('unmounted')).toBeVisible();
  const original = (await output(page, 'rpc-calls'))[0];
  await configure(page, { behavior: 'success', fixture: 'roll-forward' }); await configure(page, { fixture: 'remount' });
  await page.getByRole('button', { name: /Nueva sesi.n/, exact: true }).click();
  await expect(dialog(page).getByTestId('pending-session-operation')).toContainText('Guardar reserva');
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  await expect(dialog(page).getByRole('combobox', { name: /Financiaci.n/ })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  const writes = await output(page, 'rpc-calls'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(original);
  const callbacks = await output(page, 'calls'); expect(callbacks.map((call: any) => call.action)).toEqual(['add', 'retry']);
  const retries = await output(page, 'retry-calls'); expect(retries[0].descriptor.requestKey).toBe(original.args.p_request_key);
  expect(retries[0].descriptor.sessionId).toBe(original.args.p_session_id); expect(await output(page, 'commits')).toHaveLength(1);
});

test('server rejection does not substitute a source, sum balances or offer a bypass, and requires explicit correction', async ({ page }) => {
  await editReservation(page); await configure(page, { behavior: 'rollback' }); await save(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Fuente original rechazada');
  await expect(funding(page, ids.member)).toBeEnabled(); await expect(funding(page, ids.member)).toHaveValue(`manual:${ids.original}`);
  expect(await output(page, 'rpc-calls')).toHaveLength(1);
  await expect(dialog(page).getByRole('button', { name: /igualmente|autorizar|propietario/i })).toHaveCount(0);
  await funding(page, ids.member).selectOption(`manual:${ids.replacement}`); await configure(page, { behavior: 'success' }); await save(page);
  await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls'))[1].args.p_manual_credit_ids).toEqual({ [ids.member]: ids.replacement });
});

test('attendance never exposes source selection and submits only the atomic ID batch while preserving original maps', async ({ page }) => {
  await page.getByRole('button', { name: 'Abrir control de asistencia', exact: true }).click();
  const attendance = page.getByRole('dialog', { name: 'Control de asistencia', exact: true });
  await expect(attendance.getByRole('combobox', { name: /Financiaci.n/ })).toHaveCount(0);
  await attendance.locator(`[data-student-id="${ids.member}"]`).getByRole('button', { name: /Marcar asistencia/ }).click();
  await attendance.locator(`[data-student-id="${ids.other}"]`).getByRole('button', { name: /Marcar falta/ }).click();
  await attendance.getByRole('button', { name: 'Finalizar control', exact: true }).click(); await expect(attendance).toHaveCount(0);
  const writes = await output(page, 'rpc-calls'); expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ name: 'save_session_attendance', args: { p_expected_revision: 7,
    p_attendance: [{ student_id: ids.member, status: 'present' }, { student_id: ids.other, status: 'absent' }], p_finalize: true } });
  expect(writes[0].args).not.toHaveProperty('p_manual_credit_ids'); expect(writes[0].args).not.toHaveProperty('p_gift_card_ids');
  expect((await output(page, 'sessions'))[0].manualCreditIdByStudentId).toEqual({ [ids.member]: ids.original });
  await editReservation(page); await expect(funding(page, ids.member)).toBeDisabled();
});

test('mobile source details, evidence and homonym IDs remain contained and usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await configure(page, { fixture: 'long-evidence' });
  await editReservation(page);
  await expect(selectedRow(page, ids.member).getByTestId('selected-manual-credit-info')).toContainText('documento-sin-espacios-');
  await funding(page, ids.member).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await funding(page, ids.member).selectOption(`manual:${ids.replacement}`); await save(page); await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'rpc-calls'))[0].args.p_manual_credit_ids).toEqual({ [ids.member]: ids.replacement });
});
