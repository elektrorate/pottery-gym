import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const memberId = '20000000-0000-0000-0000-000000000001';
const otherId = '20000000-0000-0000-0000-000000000002';
const sessionId = '30000000-0000-0000-0000-000000000001';
let server: ViteDevServer;
let origin: string;
const isolation = new WeakMap<Page, { requests: string[]; errors: string[] }>();

// Only CalendarView is real. The fixture's receipts/ledger are synthetic UI
// assertions, not SQL/API acceptance evidence. Never load env files or Supabase.
test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    plugins: [react(), {
      name: 'business-policy-no-supabase',
      resolveId(source) { if (/supabase/i.test(source)) return '\0policy-forbidden-supabase'; },
      load(id) { if (id === '\0policy-forbidden-supabase') return "throw new Error('Policy harness must not import Supabase');"; }
    }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-11T08:00:00Z'));
  const evidence = { requests: [] as string[], errors: [] as string[] };
  isolation.set(page, evidence);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    evidence.requests.push(route.request().url());
    return route.abort();
  });
  await page.route('**/business-policy-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      * { box-sizing: border-box; } body { margin: 0; font: 14px system-ui; } svg { width: 1em; height: 1em; }
      button, input, select { font: inherit; max-width: 100%; } button { cursor: pointer; } button:disabled { cursor: not-allowed; }
      input, select { width: 100%; } p { overflow-wrap: anywhere; } label { display: block; min-width: 0; }
      fieldset { min-width: 0; margin: 0; border: 0; padding: 12px; } .flex { display: flex; } .flex-col { flex-direction: column; }
      .flex-wrap { flex-wrap: wrap; } .flex-1 { flex: 1; } .shrink-0 { flex-shrink: 0; } .min-h-0 { min-height: 0; }
      .min-w-0 { min-width: 0; } .grid { display: grid; gap: 12px; } .grid-cols-2 { grid-template-columns: 1fr 1fr; }
      .grid-cols-3 { grid-template-columns: repeat(3, 1fr); } .h-full { height: 100%; } .w-full { width: 100%; }
      .overflow-hidden { overflow: hidden; } .overflow-y-auto { overflow-y: auto; } .overflow-x-auto { overflow-x: auto; }
      .p-0 { padding: 0; } .px-5 { padding-left: 20px; padding-right: 20px; } .py-4 { padding-top: 16px; padding-bottom: 16px; }
      .h-10 { height: 40px; } .h-11 { height: 44px; }
      .fixed { position: fixed; inset: 0; z-index: 100; background: #eee; justify-content: center; }
      [role="dialog"] { width: 100%; max-width: 768px; height: 100dvh; min-height: 0; background: white; }
      [role="dialog"] > header, [role="dialog"] > footer { padding: 12px; gap: 12px; align-items: center; }
      [role="dialog"] > header { justify-content: space-between; } [role="dialog"] > footer { justify-content: flex-end; }
      [role="dialog"] > [role="alert"], [role="dialog"] > [role="status"] { padding: 12px; flex-shrink: 0; }
      [data-session-id] { position: relative; width: 100% !important; min-height: 0 !important; margin-bottom: 12px; padding: 12px; }
      [data-student-id] { gap: 8px; padding: 6px; } [class~="max-h-[230px]"] { max-height: 230px; }
      [class~="max-h-40"] { max-height: 240px; } [class~="truncate"] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      @media(min-width:640px) { [role="dialog"] { height: auto; max-height: 92dvh; }
        [class~="sm:px-8"] { padding-left: 32px; padding-right: 32px; } [class~="sm:py-5"] { padding-top: 20px; padding-bottom: 20px; } }
      @media(min-width:768px) { [class~="md:grid-cols-[0.9fr_1.1fr]"] { grid-template-columns: 0.9fr 1.1fr; } }
    </style></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/business-policy-ui-harness.tsx');
    </script></body></html>` }));
  await page.goto(`${origin}/business-policy-test`);
  await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(isolation.get(page)).toEqual({ requests: [], errors: [] });
  expect(await output(page, 'forbidden-calls')).toEqual([]);
});

const output = async (page: Page, id: string) => JSON.parse((await page.getByTestId(id).textContent())!);
const configure = (page: Page, detail: { fixture?: string; behavior?: string; now?: string }) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('policy-test-configure', { detail })), detail);
const release = (page: Page, event = 'policy-test-release') => page.evaluate(event => window.dispatchEvent(new Event(event)), event);
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Control de asistencia', exact: true });
const row = (page: Page, id: string) => dialog(page).locator(`[data-student-id="${id}"]`);
const open = (page: Page) => page.locator(`[data-session-id="${sessionId}"]`).getByRole('button', { name: 'Abrir control de asistencia' }).click();
const mark = (page: Page, id: string, status: 'present' | 'absent') => row(page, id).getByRole('button', { name: status === 'present' ? /Marcar asistencia/ : /Marcar falta/ }).click();
const finalize = (page: Page) => dialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
const draft = (page: Page) => dialog(page).getByRole('button', { name: 'Guardar provisional', exact: true }).click();
const approve = async (page: Page, id: string, kind = 'membership_override', reason = 'Autorizacion individual de taller') => {
  await row(page, id).getByLabel(/Tipo de excepción/).selectOption(kind);
  await row(page, id).getByLabel(/Motivo de excepción/).fill(reason);
  await row(page, id).getByRole('button', { name: /^(Aprobar|Reaprobar) excepción$/ }).click();
};
const cancel = async (page: Page, id: string) => {
  await row(page, id).getByLabel(/Motivo de cancelación/).fill('Alumno avisa de cancelacion');
  await row(page, id).getByRole('button', { name: 'Cancelar reserva', exact: true }).click();
};
const balance = async (page: Page, id: string) => (await output(page, 'students')).find((student: any) => student.id === id).classesRemaining;
const assertBusinessIntent = (intent: any, operation: string, id = memberId, revision = 7) => {
  expect(intent).toMatchObject({ operation, sessionId, studentId: id, expectedRevision: revision });
  expect(intent.requestKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(Object.keys(intent).sort()).toEqual(['operation', 'sessionId', 'studentId', 'expectedRevision', 'requestKey', 'reason', ...(operation === 'approve_exception' ? ['kind'] : [])].sort());
};
const startStoredOperation = async (page: Page, operation: string, behavior: string) => {
  if (operation === 'waive_penalty') {
    await configure(page, { fixture: 'completed' });
    await configure(page, { fixture: 'owner' });
  }
  await configure(page, { behavior });
  if (operation === 'reservation' || operation === 'new_reservation') {
    if (operation === 'reservation') await page.locator(`[data-session-id="${sessionId}"]`).click();
    else await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByLabel('Cupo máximo').fill('3');
    await settings.getByLabel('Hora de inicio').fill('14:00');
    await settings.getByLabel('Hora de fin').fill('16:00');
    await settings.getByLabel('Profesor', { exact: false }).selectOption('teacher');
    if (operation === 'new_reservation') {
      await settings.locator(`button[data-student-id="${memberId}"]`).click();
      await settings.locator(`button[data-student-id="${otherId}"]`).click();
    }
    await settings.getByRole('button', { name: operation === 'reservation' ? 'Guardar cambios' : 'Crear sesión', exact: true }).click();
  } else {
    await open(page);
    if (operation === 'attendance') {
      await mark(page, memberId, 'present');
      await mark(page, otherId, 'absent');
      await page.getByLabel('Reemplazo', { exact: true }).selectOption('substitute');
      await finalize(page);
    } else if (operation === 'approve_exception') await approve(page, memberId);
    else if (operation === 'cancel_reservation') await cancel(page, memberId);
    else {
      await row(page, memberId).getByLabel(/Motivo de exención/).fill('Resolucion expresa del propietario');
      await row(page, memberId).getByRole('button', { name: /Eximir penalización/ }).click();
    }
  }
};

test('policy 2 drafts keep pending IDs and consume nothing; only full active finalization charges', async ({ page }) => {
  await open(page);
  await mark(page, memberId, 'present');
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Completa la asistencia');
  expect(await output(page, 'calls')).toEqual([]);
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(4);
  expect(await output(page, 'ledger')).toEqual([]);
  expect((await output(page, 'rpc-calls'))[0].args).toMatchObject({ p_finalize: false, p_expected_revision: 7,
    p_attendance: [{ student_id: otherId, status: 'pending' }, { student_id: memberId, status: 'present' }] });
  await open(page);
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(3);
  expect(await balance(page, otherId)).toBe(3);
  expect((await output(page, 'rpc-calls'))[1].args).toMatchObject({ p_finalize: true, p_expected_revision: 8 });
  expect(await output(page, 'ledger')).toEqual([{ studentId: otherId, kind: 'no_show', delta: -1 }, { studentId: memberId, kind: 'attendance', delta: -1 }]);
});

test('all absent consumes one class EACH; lost finalization response retries one full batch without double charges', async ({ page }) => {
  await open(page);
  await mark(page, memberId, 'absent');
  await mark(page, otherId, 'absent');
  await configure(page, { behavior: 'lost-response' });
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  await expect(row(page, memberId).getByRole('button', { name: /Marcar asistencia/ })).toBeDisabled();
  expect(await output(page, 'ledger')).toEqual([{ studentId: otherId, kind: 'no_show', delta: -1 }, { studentId: memberId, kind: 'no_show', delta: -1 }]);
  await configure(page, { behavior: 'success' });
  await dialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const calls = await output(page, 'calls');
  expect(calls[1].input).toEqual(calls[0].input);
  expect(calls[1].sameObjectAsPrevious).toBe(true);
  const rpc = await output(page, 'rpc-calls');
  expect(rpc[1]).toEqual(rpc[0]);
  expect(rpc[0].args.p_attendance).toEqual([{ student_id: otherId, status: 'absent' }, { student_id: memberId, status: 'absent' }]);
  expect(await balance(page, memberId)).toBe(3);
  expect(await balance(page, otherId)).toBe(3);
  expect(await output(page, 'ledger')).toHaveLength(2);
});

for (const funding of ['pending', 'unknown', 'expired']) test(`${funding} funding is not fabricated; staff approves only the selected ID without marking payment paid`, async ({ page }) => {
  await configure(page, { fixture: funding });
  await open(page);
  await expect(row(page, memberId).getByRole('button', { name: 'Aprobar excepción', exact: true })).toBeDisabled();
  await approve(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(row(page, memberId).getByTestId('exception-state')).toContainText('Aprobada por: staff');
  await expect(row(page, memberId).getByTestId('exception-state')).toContainText('2026-10-11T08:00:00Z');
  await expect(row(page, otherId).getByTestId('exception-state')).toHaveCount(0);
  await expect(row(page, memberId).getByRole('button', { name: 'Reaprobar excepción', exact: true })).toBeEnabled();
  const approval = (await output(page, 'calls'))[0];
  assertBusinessIntent(approval.input, 'approve_exception');
  expect(approval.frozen).toBe(true);
  expect(approval.input.kind).toBe('membership_override');
  expect((await output(page, 'students'))[0].paymentStatus).toBe(funding === 'pending' ? 'pending' : funding === 'unknown' ? null : 'paid');
  expect(await balance(page, memberId)).toBe(4);
  await mark(page, memberId, 'present');
  await mark(page, otherId, 'present');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'calls'))[1].input.revision).toBe(8);
  expect(await balance(page, memberId)).toBe(3);
});

test('unknown credit fails closed at the server and a provisional save still allows an explicit later approval', async ({ page }) => {
  await configure(page, { fixture: 'unknown' });
  await open(page);
  await mark(page, memberId, 'present');
  await mark(page, otherId, 'present');
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Requiere aprobacion explicita');
  expect(await output(page, 'ledger')).toEqual([]);
  expect(await balance(page, memberId)).toBe(4);
  await row(page, memberId).getByLabel(/Motivo de excepción/).fill('Aprobacion expresa');
  await expect(row(page, memberId).getByRole('button', { name: 'Aprobar excepción', exact: true })).toBeDisabled();
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await approve(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '9');
  await expect(row(page, memberId)).toHaveAttribute('data-attendance-status', 'present');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect((await output(page, 'calls')).at(-1).input.revision).toBe(9);
  expect(await balance(page, memberId)).toBe(3);
});

test('stale funding SQL rejection permits explicit same-student reapproval with a new key and stable uncertain retries', async ({ page }) => {
  await configure(page, { fixture: 'pending' });
  await open(page);
  await approve(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  const original = (await output(page, 'calls'))[0].input;
  await mark(page, memberId, 'present');
  await mark(page, otherId, 'present');
  await configure(page, { fixture: 'changed-payment' });
  expect(await output(page, 'calls')).toHaveLength(1);
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Session exception is stale; explicit reapproval required');
  await expect(row(page, memberId)).toContainText('Pago: desconocido');
  await expect(row(page, memberId).getByTestId('exception-state')).toContainText(original.reason);
  await expect(row(page, memberId).getByRole('button', { name: 'Reaprobar excepción', exact: true })).toBeDisabled();
  expect(await output(page, 'approval-history')).toEqual([original]);
  expect(await output(page, 'ledger')).toEqual([]);
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await expect(dialog(page)).toHaveAttribute('data-revision', '9');
  const reason = 'Reaprobacion expresa tras revisar el pago desconocido';
  await row(page, memberId).getByLabel(/Motivo de excepción/).fill(reason);
  expect(await output(page, 'approval-history')).toEqual([original]);
  expect(await output(page, 'calls')).toHaveLength(3);
  await configure(page, { behavior: 'lost-response' });
  await row(page, memberId).getByRole('button', { name: 'Reaprobar excepción', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await expect(row(page, memberId).getByRole('button', { name: 'Reaprobar excepción', exact: true })).toBeDisabled();
  await expect(row(page, memberId).getByLabel(/Tipo de excepción/)).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  const reapproval = (await output(page, 'calls'))[3].input;
  assertBusinessIntent(reapproval, 'approve_exception', memberId, 9);
  expect(reapproval).toMatchObject({ kind: 'membership_override', reason });
  expect(reapproval.requestKey).not.toBe(original.requestKey);
  expect(await output(page, 'approval-history')).toEqual([original, reapproval]);
  await configure(page, { behavior: 'success' });
  await dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true }).click();
  await expect(dialog(page)).toHaveAttribute('data-revision', '10');
  await expect(row(page, memberId).getByTestId('exception-state')).toContainText(reason);
  const calls = await output(page, 'calls');
  expect(calls[4].input).toEqual(reapproval);
  expect(calls[4].sameObjectAsPrevious).toBe(true);
  expect(calls[3].frozen).toBe(true);
  expect(calls[4].frozen).toBe(true);
  const rpc = await output(page, 'rpc-calls');
  expect(rpc[4]).toEqual(rpc[3]);
  expect(await output(page, 'approval-history')).toEqual([original, reapproval]);
  expect(await balance(page, memberId)).toBe(4);
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(3);
  await open(page);
  await expect(row(page, memberId).getByRole('button', { name: /^(Aprobar|Reaprobar) excepción$/ })).toHaveCount(0);
});

test('a changed paid source never auto-reapproves a free exception; current kind eligibility stays server-owned', async ({ page }) => {
  await configure(page, { fixture: 'no-credit' });
  await open(page);
  await approve(page, memberId, 'no_credit', 'Cortesia inicial sin credito');
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  const original = (await output(page, 'calls'))[0].input;
  await mark(page, memberId, 'present');
  await mark(page, otherId, 'present');
  await configure(page, { fixture: 'paid-credit' });
  expect(await output(page, 'calls')).toHaveLength(1);
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Session exception is stale; explicit reapproval required');
  await expect(row(page, memberId)).toContainText('Pago: pagado');
  expect(await output(page, 'approval-history')).toEqual([original]);
  expect(await output(page, 'ledger')).toEqual([]);
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await expect(row(page, memberId).getByRole('button', { name: 'Reaprobar excepción', exact: true })).toBeDisabled();
  await approve(page, memberId, 'no_credit', 'Solicito nueva cortesia con credito disponible');
  await expect(dialog(page).getByRole('alert')).toContainText('No-credit exception cannot bypass available credit');
  const rejected = (await output(page, 'calls'))[3].input;
  assertBusinessIntent(rejected, 'approve_exception', memberId, 9);
  expect(rejected.kind).toBe('no_credit');
  expect(rejected.requestKey).not.toBe(original.requestKey);
  await approve(page, memberId, 'membership_override', 'Revision expresa del tipo de excepcion');
  await expect(dialog(page).getByRole('alert')).toContainText('Membership override requires known original positive credit');
  const calls = await output(page, 'calls');
  expect(calls).toHaveLength(5);
  expect(calls[4].input).toMatchObject({ operation: 'approve_exception', sessionId, studentId: memberId,
    expectedRevision: 9, kind: 'membership_override' });
  expect(calls[4].input.requestKey).not.toBe(rejected.requestKey);
  expect(await output(page, 'approval-history')).toEqual([original]);
  expect((await output(page, 'sessions'))[0].businessStateByStudentId[memberId].exceptionId).toBe(original.requestKey);
  expect(await balance(page, memberId)).toBe(4);
  expect(await output(page, 'ledger')).toEqual([]);
  await expect(dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true })).toHaveCount(0);
  await cancel(page, memberId);
  await expect(row(page, memberId)).toHaveAttribute('data-reservation-state', 'cancelled');
  await expect(row(page, memberId).getByRole('button', { name: /^(Aprobar|Reaprobar) excepción$/ })).toHaveCount(0);
});

test('no-credit courtesy is individual, traceable and never fabricates a balance or payment', async ({ page }) => {
  await configure(page, { fixture: 'no-credit' });
  await open(page);
  await approve(page, memberId, 'no_credit', 'Asistencia de cortesia individual');
  await expect(row(page, memberId).getByTestId('exception-state')).toContainText('asistencia sin descuento');
  await mark(page, memberId, 'present');
  await mark(page, otherId, 'present');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(0);
  expect(await balance(page, otherId)).toBe(3);
  expect((await output(page, 'sessions'))[0].businessStateByStudentId[memberId]).toMatchObject({ billingState: 'no_charge', billingKind: 'courtesy', exceptionReason: 'Asistencia de cortesia individual' });
  expect(await output(page, 'ledger')).toEqual([{ studentId: otherId, kind: 'attendance', delta: -1 }]);
});

test('all absent without valid credit records pending incidents, not negative balances or future-period charges', async ({ page }) => {
  await configure(page, { fixture: 'zero-balance' });
  await open(page);
  await mark(page, memberId, 'absent');
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(0);
  expect(await balance(page, otherId)).toBe(0);
  expect(await output(page, 'ledger')).toEqual([]);
  await open(page);
  for (const id of [memberId, otherId]) {
    await expect(row(page, id)).toHaveAttribute('data-billing-state', 'incident');
    await expect(row(page, id).getByTestId('penalty-state')).toContainText('pendiente de resolución');
    await expect(row(page, id).getByRole('button', { name: /Eximir penalización/ })).toHaveCount(0);
  }
});

test('a no-credit attendance exception does not waive a later absence penalty', async ({ page }) => {
  await configure(page, { fixture: 'no-credit' });
  await open(page);
  await approve(page, memberId, 'no_credit');
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await mark(page, memberId, 'absent');
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(0);
  expect(await balance(page, otherId)).toBe(3);
  expect((await output(page, 'sessions'))[0].businessStateByStudentId[memberId]).toMatchObject({
    exceptionKind: 'no_credit', billingKind: 'no_show', billingState: 'incident', penaltyState: 'pending'
  });
});

test('late cancellation without valid credit creates an incident, not a negative balance', async ({ page }) => {
  await configure(page, { fixture: 'no-credit', now: '2026-10-11T08:01:00Z' });
  await open(page);
  await cancel(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(0);
  expect((await output(page, 'sessions'))[0].businessStateByStudentId[memberId]).toMatchObject({
    reservationState: 'cancelled', cancellationKind: 'late', billingKind: 'late_cancellation', billingState: 'incident', penaltyState: 'pending'
  });
  expect(await output(page, 'ledger')).toEqual([{ studentId: otherId, kind: 'no_show', delta: -1 }]);
});

for (const [now, classification, remaining] of [
  ['2026-10-11T08:00:00Z', 'timely', 4], ['2026-10-11T08:01:00Z', 'late', 3]
] as const) test(`server classifies ${classification} cancellation at the 8h boundary, ignoring browser time and retaining pending cancelled IDs`, async ({ page }) => {
  await page.clock.setFixedTime(new Date('2031-01-01T00:00:00Z'));
  await configure(page, { now });
  await open(page);
  await cancel(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(row(page, memberId)).toHaveAttribute('data-reservation-state', 'cancelled');
  await expect(row(page, memberId).getByTestId('cancellation-state')).toContainText(now);
  await expect(row(page, memberId).getByTestId('cancellation-state')).toContainText('Alumno avisa de cancelacion');
  await expect(row(page, memberId).getByTestId('cancellation-state')).toContainText('Cancelada por: staff');
  await expect(row(page, memberId).getByRole('button', { name: /Marcar asistencia/ })).toBeDisabled();
  await expect(row(page, memberId).getByRole('button', { name: /Marcar falta/ })).toBeDisabled();
  await expect(row(page, memberId).getByRole('button', { name: /Dejar pendiente|Cancelar reserva|Aprobar excepción|Reactivar/ })).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(4);
  expect(await output(page, 'ledger')).toEqual([]);
  const cancellation = (await output(page, 'calls'))[0].input;
  assertBusinessIntent(cancellation, 'cancel_reservation');
  const rpc = (await output(page, 'rpc-calls'))[0];
  expect(Object.keys(rpc.args).sort()).toEqual(['p_session_id', 'p_student_id', 'p_request_key', 'p_expected_revision', 'p_reason'].sort());
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  const saved = (await output(page, 'rpc-calls'))[1].args;
  expect(saved.p_attendance).toEqual([{ student_id: otherId, status: 'absent' }, { student_id: memberId, status: 'pending' }]);
  expect(saved.p_finalize).toBe(true);
  expect(saved.p_expected_revision).toBe(8);
  expect(await balance(page, memberId)).toBe(remaining);
  expect(await balance(page, otherId)).toBe(3);
  const state = (await output(page, 'sessions'))[0].businessStateByStudentId[memberId];
  expect(state).toMatchObject({ cancellationKind: classification, cancelledAt: now, billingKind: classification === 'timely' ? 'timely_cancellation' : 'late_cancellation' });
});

test('cancelled reservations remain readonly in configuration and do not prevent capacity reduction to the active count', async ({ page }) => {
  await open(page);
  await cancel(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(dialog(page).getByTestId('attendance-roster-count')).toHaveText('1 activos / 2 en historial');
  await expect(dialog(page).locator('[data-student-id]')).toHaveCount(2);
  await dialog(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  const session = page.locator(`[data-session-id="${sessionId}"]`);
  await expect(session).toContainText('1/2 cupos');
  await expect(session.locator('[data-student-id]')).toHaveCount(2);
  await expect(session.locator(`[data-student-id="${memberId}"]`)).toHaveAttribute('data-reservation-state', 'cancelled');
  await session.click();
  const settings = page.getByRole('dialog', { name: 'Editar sesión', exact: true });
  await expect(settings.getByTestId('reservation-roster-count')).toHaveText('1 seleccionados / 1 cancelados');
  await expect(settings.locator(`button[data-student-id="${memberId}"]`)).toBeDisabled();
  await expect(settings.getByRole('button', { name: /Quitar.*00000001/ })).toBeDisabled();
  await expect(settings.getByRole('combobox', { name: /Financiación.*00000001/ })).toBeDisabled();
  await page.getByLabel('Cupo máximo').fill('1');
  await expect(settings).toContainText('1 de 1 plazas ocupadas');
  await settings.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(settings).toHaveCount(0);
  expect((await output(page, 'calls'))[1].input.studentIds).toEqual([otherId, memberId]);
  expect((await output(page, 'sessions'))[0].businessStateByStudentId[memberId].reservationState).toBe('cancelled');
});

test('dirty markings and substitute changes block financial actions rather than being overwritten by refresh', async ({ page }) => {
  await open(page);
  await row(page, memberId).getByLabel(/Motivo de excepción/).fill('Motivo individual');
  await row(page, memberId).getByLabel(/Motivo de cancelación/).fill('Aviso individual');
  await mark(page, otherId, 'present');
  await expect(row(page, memberId).getByRole('button', { name: 'Aprobar excepción', exact: true })).toBeDisabled();
  await expect(row(page, memberId).getByRole('button', { name: 'Cancelar reserva', exact: true })).toBeDisabled();
  await expect(row(page, otherId)).toHaveAttribute('data-attendance-status', 'present');
  expect(await output(page, 'calls')).toEqual([]);
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await page.getByLabel('Reemplazo', { exact: true }).selectOption('substitute');
  await row(page, memberId).getByLabel(/Motivo de excepción/).fill('Motivo individual');
  await expect(row(page, memberId).getByRole('button', { name: 'Aprobar excepción', exact: true })).toBeDisabled();
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await approve(page, memberId);
  await expect(dialog(page)).toHaveAttribute('data-revision', '10');
  await expect(row(page, otherId)).toHaveAttribute('data-attendance-status', 'present');
  await expect(page.getByLabel('Reemplazo', { exact: true })).toHaveValue('substitute');
  expect((await output(page, 'calls'))[2].input.expectedRevision).toBe(9);
});

for (const operation of ['approve_exception', 'cancel_reservation', 'waive_penalty'] as const) test(`${operation} retains ONE frozen UUID intent across response loss and reload failure, with no global reset`, async ({ page }) => {
  if (operation === 'waive_penalty') {
    await configure(page, { fixture: 'completed' });
    await configure(page, { fixture: 'owner' });
  }
  await open(page);
  await configure(page, { behavior: 'lost-response' });
  if (operation === 'approve_exception') await approve(page, memberId);
  else if (operation === 'cancel_reservation') await cancel(page, memberId);
  else {
    await row(page, memberId).getByLabel(/Motivo de exención/).fill('Resolucion expresa del propietario');
    await row(page, memberId).getByRole('button', { name: /Eximir penalización/ }).click();
  }
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  await expect(row(page, otherId).getByRole('button', { name: /Marcar asistencia/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /habilitar nuevos intentos|reiniciar|ignorar/i })).toHaveCount(0);
  const first = (await output(page, 'calls'))[0];
  assertBusinessIntent(first.input, operation);
  expect(first.frozen).toBe(true);
  await configure(page, { behavior: 'refresh-failure' });
  await dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Recarga sintetica perdida');
  await configure(page, { behavior: 'success' });
  await dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true }).click();
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeEnabled();
  const calls = await output(page, 'calls');
  expect(calls).toHaveLength(3);
  for (const call of calls.slice(1)) { expect(call.input).toEqual(first.input); expect(call.sameObjectAsPrevious).toBe(true); }
  const rpc = await output(page, 'rpc-calls');
  expect(rpc[1]).toEqual(rpc[0]); expect(rpc[2]).toEqual(rpc[0]);
  expect(await output(page, 'ledger')).toHaveLength(operation === 'waive_penalty' ? 1 : 0);
});

for (const operation of ['approve_exception', 'cancel_reservation', 'waive_penalty', 'attendance', 'reservation', 'new_reservation']) {
  for (const failure of ['lost-response', 'unmount-refresh-failure']) test(`${operation} restores the exact stored intent after ${failure}, unmount and read-only reload`, async ({ page }) => {
    await startStoredOperation(page, operation, failure);
    if (failure === 'lost-response') {
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Resultado sin confirmar');
      await configure(page, { fixture: 'unmount-calendar' });
    }
    await expect(page.getByTestId('calendar-load-error')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const original = (await output(page, 'calls'))[0];
    const rpc = (await output(page, 'rpc-calls'))[0];
    const descriptor = (await output(page, 'pending-operations'))[0];
    const ledger = await output(page, 'ledger');
    await page.clock.setFixedTime(new Date('2031-01-01T00:00:00Z'));
    await configure(page, { fixture: 'roll-forward', now: '2031-01-01T00:00:00Z' });
    await page.getByRole('button', { name: 'Recargar datos sin repetir escrituras', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Nueva sesión', exact: true })).toBeVisible();
    expect(await output(page, 'calls')).toHaveLength(1);
    expect(await output(page, 'rpc-calls')).toHaveLength(1);
    expect(await output(page, 'retry-calls')).toEqual([]);
    await page.evaluate(() => { crypto.randomUUID = () => { throw new Error('Recovery must not generate a UUID'); }; });
    if (operation === 'new_reservation' && failure === 'unmount-refresh-failure') {
      await page.locator(`[data-session-id="${descriptor.sessionId}"]`).click();
    } else if (operation === 'reservation' || operation === 'approve_exception') await open(page);
    else await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
    const active = page.getByRole('dialog');
    const recovery = active.getByTestId('pending-session-operation');
    await expect(recovery).toHaveAttribute('data-operation', descriptor.operation);
    await expect(recovery).toContainText('datos originales');
    await expect(recovery).not.toContainText(descriptor.requestKey);
    if (descriptor.reason) await expect(recovery).toContainText(descriptor.reason);
    await expect(active.getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
    await expect(active.locator('fieldset').first()).toHaveAttribute('disabled', '');
    expect(await active.locator('input, select').evaluateAll(controls => controls.every(control => control.matches(':disabled')))).toBe(true);
    await page.getByRole('button', { name: 'Nueva sesión', exact: true }).evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(page.getByRole('dialog')).toHaveCount(1);
    expect(await output(page, 'calls')).toHaveLength(1);
    const business = !['attendance', 'reservation', 'new_reservation'].includes(operation);
    await configure(page, { behavior: 'waiting' });
    await active.getByRole('button', { name: business ? 'Reintentar operación' : 'Reintentar guardado', exact: true }).click();
    const processing = active.getByRole('button', { name: business ? 'Procesando operación...' : /^Guardando/, exact: true });
    await expect(processing).toBeDisabled();
    await processing.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(await output(page, 'calls')).toHaveLength(2);
    expect(await output(page, 'rpc-calls')).toHaveLength(2);
    await configure(page, { behavior: 'success' });
    await release(page);
    if (business) {
      await expect(active).toHaveAttribute('data-revision', String(descriptor.expectedRevision + 5));
      await expect(active.getByRole('button', { name: 'Cerrar modal' })).toBeEnabled();
      await expect(recovery).toHaveCount(0);
    } else await expect(active).toHaveCount(0);
    const calls = await output(page, 'calls');
    expect(calls[1].input).toEqual(original.input);
    expect(calls[1].sameObjectAsPrevious).toBe(true);
    expect(calls[1].frozen).toBe(true);
    expect((await output(page, 'rpc-calls'))[1]).toEqual(rpc);
    expect(await output(page, 'retry-calls')).toEqual([{ id: descriptor.isNewSession ? null : descriptor.sessionId, requestKey: descriptor.requestKey }]);
    expect(await output(page, 'pending-operations')).toEqual([]);
    expect(await output(page, 'ledger')).toEqual(ledger);
    if (operation === 'attendance') expect(calls[1].input.completedAt).toBe('2026-10-11T08:00:00.000Z');
    if (operation === 'new_reservation') expect((await output(page, 'sessions')).filter((session: any) => session.id === descriptor.sessionId)).toHaveLength(1);
  });
}

test('a stored descriptor without its retry callback blocks replacement intents rather than exposing fake recovery', async ({ page }) => {
  await startStoredOperation(page, 'approve_exception', 'lost-response');
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await configure(page, { fixture: 'unmount-calendar' });
  await configure(page, { fixture: 'no-recovery-callback', behavior: 'success' });
  await page.getByRole('button', { name: 'Recargar datos sin repetir escrituras', exact: true }).click();
  await open(page);
  await expect(page.getByRole('alert')).toContainText('recuperación no está disponible');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reintentar operación|Reintentar guardado/ })).toHaveCount(0);
  expect(await output(page, 'calls')).toHaveLength(1);
  expect(await output(page, 'pending-operations')).toHaveLength(1);
  await configure(page, { fixture: 'recovery-callback' });
  await open(page);
  await expect(dialog(page).getByTestId('pending-session-operation')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeEnabled();
  expect(await output(page, 'pending-operations')).toEqual([]);
});

test('restored stale SQL rejection clears the old intent and reloads revision before an explicit new action', async ({ page }) => {
  await startStoredOperation(page, 'approve_exception', 'transport');
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  const original = (await output(page, 'calls'))[0].input;
  await configure(page, { fixture: 'unmount-calendar' });
  await page.getByRole('button', { name: 'Recargar datos sin repetir escrituras', exact: true }).click();
  await open(page);
  await configure(page, { behavior: 'stale' });
  await dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Revisa los datos recargados');
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(row(page, memberId)).toHaveAttribute('data-attendance-status', 'absent');
  await expect(page.getByLabel('Reemplazo', { exact: true })).toHaveValue('substitute');
  await expect(dialog(page).getByTestId('pending-session-operation')).toHaveCount(0);
  expect(await output(page, 'pending-operations')).toEqual([]);
  expect((await output(page, 'calls'))[1].input).toEqual(original);
  await configure(page, { behavior: 'success' });
  await approve(page, memberId, 'membership_override', 'Nueva aprobacion tras revisar el conflicto');
  await expect(dialog(page)).toHaveAttribute('data-revision', '9');
  const next = (await output(page, 'calls'))[2].input;
  expect(next.expectedRevision).toBe(8);
  expect(next.requestKey).not.toBe(original.requestKey);
});

test('restored waiver still obeys current backend authorization and clears a genuine SQL rejection', async ({ page }) => {
  await startStoredOperation(page, 'waive_penalty', 'transport');
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await configure(page, { fixture: 'unmount-calendar' });
  await configure(page, { fixture: 'other-owner', behavior: 'success' });
  await page.getByRole('button', { name: 'Recargar datos sin repetir escrituras', exact: true }).click();
  await open(page);
  await dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Solo el propietario de este taller');
  await expect(dialog(page).getByTestId('pending-session-operation')).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeEnabled();
  expect(await output(page, 'pending-operations')).toEqual([]);
  expect(await output(page, 'ledger')).toEqual([]);
  expect(await balance(page, memberId)).toBe(3);
  await expect(row(page, memberId).getByTestId('penalty-state')).toContainText('una clase consumida');
});

for (const operation of ['approve_exception', 'cancel_reservation', 'waive_penalty'] as const) test(`${operation} waits for BOTH its response and refresh and prevents duplicate submits`, async ({ page }) => {
  if (operation === 'waive_penalty') {
    await configure(page, { fixture: 'completed' });
    await configure(page, { fixture: 'owner' });
  }
  await open(page);
  await configure(page, { behavior: 'waiting' });
  if (operation === 'approve_exception') await approve(page, memberId);
  else if (operation === 'cancel_reservation') await cancel(page, memberId);
  else {
    await row(page, memberId).getByLabel(/Motivo de exención/).fill('Resolucion expresa del propietario');
    await row(page, memberId).getByRole('button', { name: /Eximir penalización/ }).click();
  }
  await expect(dialog(page).getByRole('button', { name: 'Procesando operación...', exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Procesando operación...', exact: true }).evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(row(page, otherId).getByRole('button', { name: /Marcar asistencia/ })).toBeDisabled();
  expect(await output(page, 'calls')).toHaveLength(1);
  await configure(page, { behavior: 'deferred-refresh' });
  await release(page);
  await expect(page.getByTestId('refreshes')).toHaveText('1');
  await expect(dialog(page)).toHaveAttribute('data-revision', '7');
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeDisabled();
  if (operation === 'approve_exception') await expect(row(page, memberId).getByTestId('exception-state')).toHaveCount(0);
  else if (operation === 'cancel_reservation') await expect(row(page, memberId)).toHaveAttribute('data-reservation-state', 'reserved');
  else await expect(row(page, memberId).getByTestId('penalty-state')).toContainText('una clase consumida');
  await release(page, 'policy-test-refresh');
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal' })).toBeEnabled();
  if (operation === 'approve_exception') await expect(row(page, memberId).getByTestId('exception-state')).toBeVisible();
  else if (operation === 'cancel_reservation') await expect(row(page, memberId)).toHaveAttribute('data-reservation-state', 'cancelled');
  else await expect(row(page, memberId).getByTestId('penalty-state')).toContainText('eximida');
  expect(await output(page, 'calls')).toHaveLength(1);
});

test('stale business rejection reloads current attendance and revision before any new intent', async ({ page }) => {
  await open(page);
  await configure(page, { behavior: 'stale' });
  await approve(page, memberId);
  await expect(dialog(page).getByRole('alert')).toContainText('Revisa los datos recargados');
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(row(page, memberId)).toHaveAttribute('data-attendance-status', 'absent');
  await expect(row(page, otherId)).toHaveAttribute('data-attendance-status', 'present');
  await expect(page.getByLabel('Reemplazo', { exact: true })).toHaveValue('substitute');
  await configure(page, { behavior: 'success' });
  await row(page, memberId).getByRole('button', { name: 'Aprobar excepción', exact: true }).click();
  await expect(dialog(page)).toHaveAttribute('data-revision', '9');
  const calls = await output(page, 'calls');
  expect(calls[1].input.expectedRevision).toBe(8);
  expect(calls[1].input.requestKey).not.toBe(calls[0].input.requestKey);
});

test('ordinary finalized attendance corrections do NOT refund a charged absence or clear its penalty', async ({ page }) => {
  await configure(page, { fixture: 'completed' });
  await open(page);
  await expect(dialog(page).getByTestId('attendance-policy')).toContainText('no devuelve una penalización');
  await expect(row(page, memberId).getByRole('button', { name: /Eximir penalización/ })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  await mark(page, memberId, 'present');
  await dialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(3);
  expect(await output(page, 'ledger')).toEqual([]);
  const saved = (await output(page, 'sessions'))[0];
  expect(saved.businessStateByStudentId[memberId]).toMatchObject({ billingState: 'charged', billingKind: 'no_show', penaltyId: 'penalty', penaltyState: 'charged' });
  expect(saved.completedAt).toBe('2026-10-11T18:00:00Z');
  expect((await output(page, 'calls'))[0].input).not.toHaveProperty('businessStateByStudentId');
});

for (const fixture of ['completed', 'incident']) test(`only an explicit owner waiver resolves a ${fixture} penalty with its own reason`, async ({ page }) => {
  await configure(page, { fixture });
  await configure(page, { fixture: 'owner' });
  await open(page);
  const button = row(page, memberId).getByRole('button', { name: /Eximir penalización/ });
  await expect(button).toBeDisabled();
  await row(page, memberId).getByLabel(/Motivo de exención/).fill('Revision administrativa del propietario');
  await dialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  await mark(page, memberId, 'present');
  await expect(button).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Cancelar edición', exact: true }).click();
  await expect(row(page, memberId)).toHaveAttribute('data-attendance-status', 'absent');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await expect(row(page, memberId).getByTestId('penalty-state')).toContainText('eximida');
  await expect(row(page, memberId).getByTestId('waiver-state')).toContainText('Revision administrativa del propietario');
  await expect(row(page, memberId).getByTestId('waiver-state')).toContainText('Eximida por: owner');
  await expect(row(page, memberId).getByTestId('waiver-state')).toContainText('2026-10-11T08:00:00Z');
  await expect(row(page, memberId).getByTestId('penalty-state')).toContainText('Falta');
  const state = (await output(page, 'sessions'))[0].businessStateByStudentId[memberId];
  expect(state.penaltyReason).toBe('Falta');
  expect(state.waiverReason).toBe('Revision administrativa del propietario');
  expect(await balance(page, memberId)).toBe(fixture === 'completed' ? 4 : 0);
  const intent = (await output(page, 'calls'))[0].input;
  assertBusinessIntent(intent, 'waive_penalty');
  expect(intent.reason).toBe('Revision administrativa del propietario');
  await expect(button).toHaveCount(0);
});

test('a misleading owner hint or reason text never bypasses server authorization', async ({ page }) => {
  await configure(page, { fixture: 'completed' });
  await configure(page, { fixture: 'other-owner' });
  await open(page);
  await row(page, memberId).getByLabel(/Motivo de exención/).fill('Soy propietario y autorizo quitar todo');
  await row(page, memberId).getByRole('button', { name: /Eximir penalización/ }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Solo el propietario de este taller');
  expect(await balance(page, memberId)).toBe(3);
  await expect(row(page, memberId)).toHaveAttribute('data-billing-state', 'charged');
  await expect(dialog(page).getByRole('button', { name: 'Reintentar operación', exact: true })).toHaveCount(0);
});

test('unauthorized approval is rejected despite an authorization-looking reason', async ({ page }) => {
  await configure(page, { fixture: 'unauthorized' });
  await open(page);
  await approve(page, memberId, 'membership_override', 'Autorizado por propietario, pagado y aprobado');
  await expect(dialog(page).getByRole('alert')).toContainText('Personal no autorizado');
  await expect(row(page, memberId).getByTestId('exception-state')).toHaveCount(0);
  await expect(row(page, memberId).getByLabel(/Motivo de excepción/)).toBeEnabled();
  expect((await output(page, 'students'))[0].paymentStatus).toBe('paid');
  expect(await output(page, 'ledger')).toEqual([]);
});

test('policy 1 keeps the previous UI, pending validation and absent semantics without historical rebilling', async ({ page }) => {
  await configure(page, { fixture: 'legacy' });
  await open(page);
  await expect(dialog(page).getByTestId('attendance-policy')).toContainText('no se aplican nuevas penalizaciones ni recobros históricos');
  await expect(dialog(page).getByRole('button', { name: /Guardar provisional|Aprobar excepción|Cancelar reserva|Eximir penalización/ })).toHaveCount(0);
  await mark(page, memberId, 'absent');
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Completa la asistencia');
  expect(await output(page, 'calls')).toEqual([]);
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await balance(page, memberId)).toBe(4);
  expect(await balance(page, otherId)).toBe(4);
  expect(await output(page, 'ledger')).toEqual([]);
  expect((await output(page, 'calls'))[0].input).not.toHaveProperty('attendancePolicyVersion');
});

test('legacy unknown funding surfaces a server error rather than treating the member as paid', async ({ page }) => {
  await configure(page, { fixture: 'legacy-unknown' });
  await open(page);
  await mark(page, memberId, 'present');
  await mark(page, otherId, 'absent');
  await finalize(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Financiacion desconocida');
  await expect(dialog(page).getByRole('button', { name: 'Finalizar control', exact: true })).toBeEnabled();
  expect((await output(page, 'students'))[0].paymentStatus).toBeNull();
  expect(await output(page, 'ledger')).toEqual([]);
});

test('new sessions explicitly select policy 2, while editing legacy metadata never opts it in', async ({ page }) => {
  await configure(page, { fixture: 'legacy' });
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  const settings = page.getByRole('dialog', { name: 'Editar sesión', exact: true });
  await page.getByLabel('Cupo máximo').fill('3');
  await settings.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(settings).toHaveCount(0);
  expect((await output(page, 'calls'))[0].input).not.toHaveProperty('attendancePolicyVersion');
  expect((await output(page, 'sessions'))[0].attendancePolicyVersion).toBe(1);
  await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
  await page.getByLabel('Profesor', { exact: false }).selectOption('teacher');
  await page.getByRole('dialog', { name: 'Nueva sesión', exact: true }).getByRole('button', { name: 'Crear sesión', exact: true }).click();
  expect((await output(page, 'calls'))[1]).toMatchObject({ operation: 'add', input: { attendancePolicyVersion: 2 } });
});

test('missing revision blocks business callbacks; missing IDs cannot be guessed from homonyms', async ({ page }) => {
  await configure(page, { fixture: 'missing-revision' });
  await open(page);
  await approve(page, memberId);
  await expect(dialog(page).getByRole('alert')).toContainText('revisión');
  expect(await output(page, 'calls')).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  await configure(page, { fixture: 'missing-ids' });
  await open(page);
  await expect(page.getByRole('alert')).toContainText('IDs persistidos y alineados');
  await expect(dialog(page)).toHaveCount(0);
  expect(await output(page, 'calls')).toEqual([]);
});

test('optional callbacks preserve old consumers and do not expose unusable financial controls', async ({ page }) => {
  await configure(page, { fixture: 'no-callbacks' });
  await open(page);
  await expect(dialog(page).getByRole('button', { name: /Aprobar excepción|Cancelar reserva|Eximir penalización/ })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Guardar provisional', exact: true })).toBeVisible();
});

test('mobile homonym rows have independently labeled controls and remain usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(row(page, memberId).getByLabel('Motivo de excepción para Alex Perez (00000001)', { exact: true })).toBeEnabled();
  await expect(row(page, otherId).getByLabel('Motivo de excepción para Alex Perez (00000002)', { exact: true })).toBeEnabled();
  await approve(page, memberId, 'no_credit');
  await expect(dialog(page)).toHaveAttribute('data-revision', '8');
  await mark(page, otherId, 'present');
  await draft(page);
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(row(page, otherId)).toHaveAttribute('data-attendance-status', 'present');
});

for (const viewport of [{ width: 1024, height: 480 }, { width: 390, height: 568 }]) test(`modal scroll bodies keep last-row controls clear of Guardar cambios at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await configure(page, { fixture: 'long-business-reasons' });
  await open(page);
  await dialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  for (const id of [otherId, memberId]) {
    await row(page, id).getByLabel(/Motivo de exención/).fill('Revision administrativa detallada del propietario. '.repeat(20));
  }
  const assertHit = async (target: ReturnType<Page['getByRole']>) => {
    await target.scrollIntoViewIfNeeded();
    const geometry = await target.evaluate(control => {
      const modal = control.closest('[role="dialog"]')!;
      const scroller = modal.querySelector(':scope > .custom-scrollbar')!;
      const footer = modal.querySelector(':scope > footer')!;
      const bounds = control.getBoundingClientRect();
      const bodyBounds = scroller.getBoundingClientRect();
      const footerBounds = footer.getBoundingClientRect();
      const style = getComputedStyle(scroller);
      const save = footer.querySelector('button:last-child')!;
      const saveBounds = save.getBoundingClientRect();
      return { tag: scroller.tagName, overflow: style.overflowY, minHeight: style.minHeight,
        padding: [parseFloat(style.paddingLeft), parseFloat(style.paddingTop)],
        scrollable: scroller.scrollHeight > scroller.clientHeight, scrolled: scroller.scrollTop > 0,
        inBody: bounds.top >= bodyBounds.top && bounds.bottom <= bodyBounds.bottom,
        beforeFooter: bounds.bottom <= footerBounds.top && bodyBounds.bottom <= footerBounds.top + 1,
        footerInViewport: footerBounds.bottom <= innerHeight + 1,
        hit: control.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
        footerHit: save.contains(document.elementFromPoint(saveBounds.x + saveBounds.width / 2, saveBounds.y + saveBounds.height / 2)) };
    });
    expect(geometry).toMatchObject({ overflow: 'auto', minHeight: '0px', scrollable: true, scrolled: true,
      inBody: true, beforeFooter: true, footerInViewport: true, hit: true, footerHit: true });
    expect(geometry.padding).toEqual(viewport.width >= 640 ? [32, 20] : [20, 16]);
    expect(geometry.tag).toBe('DIV');
  };
  const lastAttendance = row(page, memberId).getByRole('button', { name: /Marcar asistencia/ });
  await assertHit(lastAttendance);
  await lastAttendance.click();
  await expect(row(page, memberId)).toHaveAttribute('data-attendance-status', 'present');
  await expect(dialog(page).getByRole('button', { name: 'Guardar cambios', exact: true })).toBeVisible();
  expect(await output(page, 'calls')).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Cerrar modal', exact: true }).click();
  await configure(page, { fixture: 'default' });
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  const settings = page.getByRole('dialog', { name: 'Editar sesión', exact: true });
  const lastReservation = settings.locator(`div[data-student-id="${memberId}"]`).getByRole('button', { name: /Quitar/ });
  await assertHit(lastReservation);
  await lastReservation.click();
  await expect(settings.getByTestId('reservation-roster-count')).toHaveText('1 seleccionados');
  await expect(settings.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeVisible();
  expect(await output(page, 'calls')).toEqual([]);
});
