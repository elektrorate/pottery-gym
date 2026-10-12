import { expect, test, type Page, type Locator } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const studentId = '20000000-0000-0000-0000-000000000001';
const otherId = '20000000-0000-0000-0000-000000000002';
const sessionId = '30000000-0000-0000-0000-000000000001';
const penaltyId = '40000000-0000-0000-0000-000000000001';
const originalId = '50000000-0000-0000-0000-000000000001';
const actorId = '60000000-0000-0000-0000-000000000001';
const settlementId = '70000000-0000-0000-0000-000000000001';
let server: ViteDevServer;
let origin: string;
const isolation = new WeakMap<Page, { requests: string[]; errors: string[] }>();

// Real StudentList, synthetic main-owned callbacks/receipts, no application entry,
// env files, Supabase or external requests. CSS supports interaction, not visual acceptance.
test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    cacheDir: fileURLToPath(new URL('../../node_modules/.cache/student-credit-ui-vite', import.meta.url)),
    plugins: [react(), {
      name: 'student-credit-no-supabase',
      resolveId(source) { if (/supabase/i.test(source)) return '\0credit-forbidden-supabase'; },
      load(id) { if (id === '\0credit-forbidden-supabase') return "throw new Error('Credit harness must not import Supabase');"; }
    }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  const evidence = { requests: [] as string[], errors: [] as string[] };
  isolation.set(page, evidence);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    evidence.requests.push(route.request().url()); return route.abort();
  });
  await page.route('**/student-credit-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      * { box-sizing: border-box; } body { margin: 0; font: 14px system-ui; } svg { width: 1em; height: 1em; }
      button, input, select, textarea { font: inherit; max-width: 100%; } input, select, textarea { width: 100%; }
      button { cursor: pointer; } button:disabled { cursor: not-allowed; } label { display: block; min-width: 0; }
      p, code { overflow-wrap: anywhere; } fieldset { min-width: 0; margin: 0; padding: 12px; }
      .flex { display: flex; } .flex-col { flex-direction: column; } .flex-wrap { flex-wrap: wrap; }
      .flex-1 { flex: 1; } .shrink-0 { flex-shrink: 0; } .min-h-0 { min-height: 0; } .min-w-0 { min-width: 0; }
      .grid { display: grid; gap: 12px; } .grid-cols-2 { grid-template-columns: 1fr 1fr; }
      .grid-cols-3 { grid-template-columns: repeat(3, 1fr); } .h-full { height: 100%; } .w-full { width: 100%; }
      .h-10 { height: 40px; } .h-11 { height: 44px; } .hidden { display: none; }
      .overflow-hidden { overflow: hidden; } .overflow-y-auto { overflow-y: auto; } .overflow-x-auto { overflow-x: auto; }
      .fixed { position: fixed; inset: 0; z-index: 100; background: #eee; justify-content: center; }
      .fixed > div { width: min(100%, 1024px); height: 100dvh; background: white; }
      .fixed > div > div { padding: 12px; } .fixed form { padding-bottom: 20px; }
      [data-testid="student-credit-panel"] { padding: 12px 0; } article { padding: 12px; border: 1px solid #ddbfa4; }
      .break-all { word-break: break-all; } .break-words { overflow-wrap: break-word; }
      @media(min-width:640px) { [class~="sm:grid-cols-2"] { grid-template-columns: 1fr 1fr; } }
      @media(min-width:768px) { .fixed > div { height: 92dvh; margin: auto; } }
      @media(min-width:1024px) { [class~="lg:grid-cols-[1.2fr_1fr]"] { grid-template-columns: 1.2fr 1fr; } }
    </style></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/student-credit-ui-harness.tsx');
    </script></body></html>` }));
  await page.goto(`${origin}/student-credit-test`);
  await expect(page.getByRole('heading', { name: 'Alumnos', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(isolation.get(page)).toEqual({ requests: [], errors: [] });
  expect(await output(page, 'forbidden-calls')).toEqual([]);
});

const output = async (page: Page, id: string) => JSON.parse((await page.getByTestId(id).textContent())!);
const configure = (page: Page, detail: { fixture?: string; mode?: string; role?: string; hint?: boolean }) =>
  page.evaluate(detail => window.dispatchEvent(new CustomEvent('credit-test-configure', { detail })), detail);
const release = (page: Page, event = 'credit-test-release') => page.evaluate(event => window.dispatchEvent(new Event(event)), event);
const panel = (page: Page) => page.getByRole('region', { name: 'Créditos manuales e incidencias', exact: true });
const penalty = (page: Page) => panel(page).locator(`[data-penalty-id="${penaltyId}"]`);
const open = (page: Page, id = studentId) => page.locator(`button.ui-list[data-student-id="${id}"]`).click();
// Bypass the native maxlength to verify the state/intent guard too, not just HTML.
const forceValue = (control: Locator, value: string) => control.evaluate((element, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
const fillCredit = async (page: Page, mode = 'new_manual') => {
  await panel(page).getByLabel('Modo del crédito manual', { exact: true }).selectOption(mode);
  await panel(page).getByLabel('Actividad del crédito manual', { exact: true }).selectOption('mesa');
  await panel(page).getByLabel('Cantidad de clases manuales', { exact: true }).fill('3');
  await panel(page).getByLabel('Inicio del crédito manual', { exact: true }).fill('2026-10-15');
  await panel(page).getByLabel('Fin del crédito manual', { exact: true }).fill('2026-12-20');
  await panel(page).getByLabel('Motivo del crédito manual', { exact: true }).fill('Revision expresa de origen');
  await panel(page).getByLabel('Evidencia / origen del crédito manual', { exact: true }).fill('Documento local de clases adquiridas');
};
const start = async (page: Page, operation: string, mode = 'success') => {
  await configure(page, { mode });
  await open(page);
  if (operation === 'approve_manual') {
    await fillCredit(page);
    await panel(page).getByRole('button', { name: 'Aprobar crédito manual', exact: true }).click();
  } else {
    await penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`, { exact: true }).fill('Resolucion expresa del propietario');
    await penalty(page).getByRole('button', { name: operation === 'settle_penalty' ? 'Aplicar descuento pendiente' : 'Eximir incidencia', exact: true }).click();
  }
};
const assertIntent = (call: any, operation: string) => {
  expect(call.operation).toBe(operation);
  expect(call.frozen).toBe(true);
  expect(call.input.studentId).toBe(studentId);
  expect(call.input.requestKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const keys = operation === 'approve_manual'
    ? ['studentId', 'requestKey', 'mode', 'quantity', 'expectedLegacyBalance', 'activity', 'startsOn', 'endsOn', 'reason', 'evidence']
    : operation === 'settle_penalty' ? ['penaltyId', 'studentId', 'requestKey', 'expectedRevision', 'reason']
    : ['operation', 'sessionId', 'studentId', 'requestKey', 'expectedRevision', 'reason'];
  expect(Object.keys(call.input).sort()).toEqual(keys.sort());
};

test('explicit quantity, activity, dates, reason and evidence are mandatory; the panel is outside the profile form', async ({ page }) => {
  await open(page);
  const approve = panel(page).getByRole('button', { name: 'Aprobar crédito manual', exact: true });
  await expect(approve).toBeDisabled();
  expect(await panel(page).evaluate(element => element.closest('form') === null)).toBe(true);
  await expect(panel(page).locator('form')).toHaveCount(0);
  await expect(panel(page).getByLabel('Inicio del crédito manual')).toHaveValue('2026-10-12');
  await expect(panel(page).getByLabel('Fin del crédito manual')).toHaveValue('2026-11-12');
  await fillCredit(page);
  for (const label of ['Cantidad de clases manuales', 'Inicio del crédito manual', 'Fin del crédito manual', 'Motivo del crédito manual', 'Evidencia / origen del crédito manual']) {
    const input = panel(page).getByLabel(label, { exact: true });
    const value = await input.inputValue(); await input.fill(''); await expect(approve).toBeDisabled(); await input.fill(value);
  }
  await panel(page).getByLabel('Actividad del crédito manual').selectOption(''); await expect(approve).toBeDisabled();
  await panel(page).getByLabel('Actividad del crédito manual').selectOption('mesa');
  await panel(page).getByLabel('Cantidad de clases manuales').fill('1.5'); await expect(approve).toBeDisabled();
  await panel(page).getByLabel('Cantidad de clases manuales').fill('3');
  await panel(page).getByLabel('Fin del crédito manual').fill('2026-10-14'); await expect(approve).toBeDisabled();
  await panel(page).getByLabel('Fin del crédito manual').fill('2026-12-20');
  await penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`).press('Enter');
  expect(await output(page, 'calls')).toEqual([]);
  await approve.click();
  const saved = (await output(page, 'calls'))[0]; assertIntent(saved, 'approve_manual');
  expect(saved.input).toMatchObject({ mode: 'new_manual', quantity: 3, expectedLegacyBalance: 4, activity: 'mesa',
    startsOn: '2026-10-15', endsOn: '2026-12-20', reason: 'Revision expresa de origen', evidence: 'Documento local de clases adquiridas' });
  await expect(panel(page).locator(`[data-manual-credit-id="${saved.input.requestKey}"]`)).toContainText('ID de actor');
  await expect(panel(page)).toBeVisible();
  const people = await output(page, 'students');
  expect(people[0]).toMatchObject({ classesRemaining: 4, paymentStatus: null, studentCategory: 'temporal', legacyManualBalance: 4 });
  expect(people[1].manualCredits).toEqual([]);
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 4');
  await expect(panel(page).getByTestId('manual-credit-ledger')).toContainText('3 restantes / 3 aprobadas');
});

test('reconciliation captures the known raw balance and approval never fabricates payment or a membership', async ({ page }) => {
  await open(page); await fillCredit(page, 'reconcile_legacy');
  await expect(panel(page).getByRole('button', { name: 'Aprobar crédito manual' })).toBeDisabled();
  await expect(panel(page)).toContainText('saldo legado completo (4 clases)');
  await panel(page).getByLabel('Cantidad de clases manuales').fill('5');
  await expect(panel(page).getByRole('button', { name: 'Aprobar crédito manual' })).toBeDisabled();
  await panel(page).getByLabel('Cantidad de clases manuales').fill('4');
  await panel(page).getByRole('button', { name: 'Aprobar crédito manual' }).click();
  const call = (await output(page, 'calls'))[0]; assertIntent(call, 'approve_manual');
  expect(call.input).toMatchObject({ mode: 'reconcile_legacy', expectedLegacyBalance: 4, quantity: 4 });
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 4');
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('ya fue conciliado');
  await expect(panel(page).getByTestId('manual-credit-ledger')).toContainText('4 restantes / 4 aprobadas');
  await panel(page).getByLabel('Cantidad de clases manuales').fill('4');
  await expect(panel(page).getByRole('button', { name: 'Aprobar crédito manual' })).toBeDisabled();
  await expect(panel(page).getByLabel('Modo del crédito manual').locator('option[value="reconcile_legacy"]')).toHaveAttribute('disabled', '');
  expect(await output(page, 'calls')).toHaveLength(1);
  expect((await output(page, 'students'))[0]).toMatchObject({ classesRemaining: 4, paymentStatus: null, studentCategory: 'temporal' });
});

for (const fixture of ['unknown', 'missing-observation', 'zero', 'managed', 'historical-membership', 'historical-membership-allowed', 'reconcile-blocked', 'reconciled-allowed']) test(`${fixture} never invents a reconcilable legacy observation`, async ({ page }) => {
  await configure(page, { fixture }); await open(page);
  await expect(panel(page).getByLabel('Modo del crédito manual').locator('option[value="reconcile_legacy"]')).toHaveAttribute('disabled', '');
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('No hay saldo legado conciliable');
  await fillCredit(page); await panel(page).getByRole('button', { name: 'Aprobar crédito manual' }).click();
  expect((await output(page, 'calls'))[0].input.expectedLegacyBalance).toBe(['unknown', 'missing-observation'].includes(fixture) ? null : fixture === 'zero' ? 0 : 4);
  if (fixture === 'managed') {
    expect((await output(page, 'students'))[0].paymentStatus).toBe('pending');
    await expect(page.getByRole('button', { name: 'Aplicar ajuste / reintentar' })).toHaveCount(0);
  }
});

for (const role of ['staff', 'administrator', 'superadmin', 'other-owner']) test(`${role} sees the audit but no owner controls`, async ({ page }) => {
  await configure(page, { role, hint: false, fixture: 'long-audit' }); await open(page);
  await expect(panel(page).getByTestId('manual-credit-ledger')).toContainText(originalId);
  await expect(panel(page)).toContainText('Solo lectura');
  await expect(panel(page).locator('input, select, textarea, button')).toHaveCount(0);
});

for (const operation of ['approve_manual', 'settle_penalty', 'waive_penalty']) test(`a misleading owner hint cannot authorize ${operation}`, async ({ page }) => {
  await configure(page, { role: 'other-owner', hint: true }); await start(page, operation);
  await expect(panel(page).getByRole('alert')).toContainText('Solo el propietario de esta sede');
  expect(await output(page, 'ledger')).toEqual([]); expect(await output(page, 'pending-operations')).toEqual([]);
  assertIntent((await output(page, 'calls'))[0], operation);
});

for (const fixture of ['period', 'manual', 'late']) test(`${fixture} settlement targets the original entity without a funding chooser`, async ({ page }) => {
  await configure(page, { fixture }); await start(page, 'settle_penalty');
  const call = (await output(page, 'calls'))[0]; assertIntent(call, 'settle_penalty');
  expect(call.input).toMatchObject({ penaltyId, expectedRevision: 7, reason: 'Resolucion expresa del propietario' });
  await expect(penalty(page).getByTestId('penalty-original-source')).toContainText(originalId);
  await expect(penalty(page).getByRole('combobox')).toHaveCount(0);
  await expect(penalty(page)).toHaveAttribute('data-penalty-state', 'charged');
  const audit = penalty(page).getByTestId('penalty-settlement-audit');
  await expect(audit).toContainText(call.input.requestKey);
  await expect(audit).toContainText(call.input.reason);
  await expect(audit).toContainText(actorId);
  await expect(audit).toContainText('2026-10-12T08:00:00Z');
  expect(await output(page, 'ledger')).toEqual([{ operation: 'settle_penalty', studentId, penaltyId, sourceId: originalId, delta: -1 }]);
  expect((await output(page, 'students'))[0].classesRemaining).toBe(4);
});

for (const fixture of ['source-unusable', 'missing-source', 'ambiguous-source', 'missing-revision', 'missing-sede', 'wrong-entity', 'missing-hint']) test(`${fixture} fails closed rather than choosing a substitute`, async ({ page }) => {
  await configure(page, { fixture }); await open(page);
  if (fixture === 'missing-sede') await expect(panel(page).locator('input, select, textarea, button')).toHaveCount(0);
  else {
    const reason = penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`);
    if (await reason.isEnabled()) await reason.fill('Revision explicita');
    await expect(penalty(page).getByRole('button', { name: 'Aplicar descuento pendiente' })).toBeDisabled();
  }
  await expect(penalty(page).getByRole('combobox')).toHaveCount(0);
  if (fixture === 'missing-hint') {
    await expect(penalty(page)).toContainText('se calcula en la aplicación');
    await expect(penalty(page)).not.toContainText('El servidor no habilita');
  }
  expect(await output(page, 'calls')).toEqual([]);
});

test('unusable source may be explicitly waived through the existing session intent, without charging another right', async ({ page }) => {
  await configure(page, { fixture: 'source-unusable' }); await start(page, 'waive_penalty');
  const call = (await output(page, 'calls'))[0]; assertIntent(call, 'waive_penalty');
  expect(call.input).toMatchObject({ operation: 'waive_penalty', sessionId, expectedRevision: 7 });
  await expect(penalty(page)).toHaveAttribute('data-penalty-state', 'waived');
  expect((await output(page, 'ledger'))[0].delta).toBe(0);
  expect((await output(page, 'students'))[0].classesRemaining).toBe(4);
});

test('a stale canSettle hint is not authority and server source rejection keeps the incident pending', async ({ page }) => {
  await configure(page, { fixture: 'stale-source-hint' }); await start(page, 'settle_penalty');
  await expect(panel(page).getByRole('alert')).toContainText('derecho original no es utilizable');
  await expect(penalty(page)).toHaveAttribute('data-penalty-state', 'pending');
  expect(await output(page, 'ledger')).toEqual([]);
});

for (const field of ['approve', 'settle', 'waive', 'getter', 'retry']) test(`missing ${field} callback has no credit or generic-balance fallback`, async ({ page }) => {
  await configure(page, { fixture: `no-${field}` }); await open(page);
  if (field === 'waive') await expect(penalty(page).getByRole('button', { name: 'Eximir incidencia' })).toHaveCount(0);
  else if (field === 'settle') {
    await penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`).fill('Revision');
    await expect(penalty(page).getByRole('button', { name: 'Aplicar descuento pendiente' })).toBeDisabled();
  } else await expect(panel(page).getByLabel('Cantidad de clases manuales')).toBeDisabled();
  expect(await output(page, 'calls')).toEqual([]);
});

for (const operation of ['approve_manual', 'settle_penalty', 'waive_penalty']) {
  for (const failure of ['lost-response', 'unmount-refresh-failure']) test(`${operation} restores the exact frozen intent after ${failure} and remount`, async ({ page }) => {
    await start(page, operation, failure);
    if (failure === 'lost-response') {
      await expect(panel(page).getByRole('alert')).toContainText('Resultado sin confirmar');
      await configure(page, { fixture: 'unmount' });
    }
    await expect(page.getByTestId('student-load-error')).toBeVisible();
    const first = (await output(page, 'calls'))[0]; assertIntent(first, operation);
    const ledger = await output(page, 'ledger');
    await configure(page, { fixture: 'roll-forward', mode: 'success' });
    await page.clock.setFixedTime(new Date('2031-01-01T00:00:00Z'));
    await page.getByRole('button', { name: 'Recargar datos sin repetir escrituras' }).click();
    await page.evaluate(() => { crypto.randomUUID = () => { throw new Error('Recovery must not create another UUID'); }; });
    await open(page);
    const recovery = panel(page).getByTestId('pending-student-credit-operation');
    await expect(recovery).toHaveAttribute('data-operation', operation);
    await expect(recovery).toContainText('datos originales');
    await expect(recovery).not.toContainText(first.input.requestKey);
    expect(await panel(page).locator('input, select, textarea').evaluateAll(controls => controls.every(control => control.matches(':disabled')))).toBe(true);
    await recovery.getByRole('button', { name: 'Reintentar operación pendiente' }).click();
    await expect(recovery).toHaveCount(0);
    const calls = await output(page, 'calls'); expect(calls).toHaveLength(2);
    expect(calls[1].input).toEqual(first.input); expect(calls[1].sameObjectAsPrevious).toBe(true); expect(calls[1].frozen).toBe(true);
    expect(await output(page, 'retry-calls')).toEqual([{ studentId, requestKey: first.input.requestKey }]);
    expect(await output(page, 'ledger')).toEqual(ledger); expect(await output(page, 'pending-operations')).toEqual([]);
    await expect(penalty(page)).toContainText(`Revisión de sesión: ${operation === 'approve_manual' ? 11 : 12}`);
    expect((await output(page, 'students'))[0].classesRemaining).toBe(9);
    await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 2');
    if (operation === 'approve_manual') expect(calls[1].input.expectedLegacyBalance).toBe(4);
  });
  test(`${operation} prevents duplicate submits and waits for the authoritative refresh`, async ({ page }) => {
    await start(page, operation, 'waiting');
    const processing = panel(page).getByRole('button', { name: 'Procesando operación...' });
    await expect(processing).toBeDisabled();
    await processing.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(await output(page, 'calls')).toHaveLength(1);
    await configure(page, { mode: 'deferred-refresh' }); await release(page);
    await expect(page.getByTestId('ledger')).not.toHaveText('[]');
    await expect(processing).toBeDisabled();
    if (operation === 'approve_manual') await expect(panel(page).locator('[data-manual-credit-id]')).toHaveCount(0);
    else await expect(penalty(page)).toHaveAttribute('data-penalty-state', 'pending');
    await release(page, 'credit-test-refresh');
    await expect(panel(page).getByTestId('pending-student-credit-operation')).toHaveCount(0);
    expect(await output(page, 'calls')).toHaveLength(1);
  });
}

test('closing and reopening restores the pending descriptor rather than accepting a replacement draft', async ({ page }) => {
  await start(page, 'approve_manual', 'transport');
  await expect(panel(page).getByTestId('pending-student-credit-operation')).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar ficha' }).click(); await open(page);
  await expect(panel(page).getByLabel('Cantidad de clases manuales')).toBeDisabled();
  await configure(page, { mode: 'success' });
  await panel(page).getByRole('button', { name: 'Reintentar operación pendiente' }).click();
  const calls = await output(page, 'calls'); expect(calls[1].input).toEqual(calls[0].input);
  expect(calls[1].sameObjectAsPrevious).toBe(true);
});

test('a restored descriptor without retry support remains read-only and keeps the exact main-owned attempt', async ({ page }) => {
  await start(page, 'settle_penalty', 'transport'); await configure(page, { fixture: 'unmount' });
  await configure(page, { fixture: 'no-retry', mode: 'success' }); await configure(page, { fixture: 'remount' }); await open(page);
  await expect(panel(page).getByTestId('pending-student-credit-operation')).toContainText('recuperación no está disponible');
  await expect(panel(page).getByRole('button', { name: 'Reintentar operación pendiente' })).toHaveCount(0);
  await expect(panel(page).getByLabel('Cantidad de clases manuales')).toBeDisabled();
  expect(await output(page, 'calls')).toHaveLength(1); expect(await output(page, 'pending-operations')).toHaveLength(1);
});

for (const fixture of ['charged', 'waived']) test(`${fixture} audit rows do not expose a new pending resolution`, async ({ page }) => {
  await configure(page, { fixture }); await open(page);
  await expect(penalty(page)).toHaveAttribute('data-penalty-state', fixture);
  await expect(penalty(page).getByRole('button', { name: 'Aplicar descuento pendiente' })).toHaveCount(0);
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toContainText(settlementId);
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toContainText('Motivo de liquidacion original');
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toContainText(actorId);
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toContainText('2026-10-11T20:00:00Z');
  if (fixture === 'waived') await expect(penalty(page).locator('input, select, button')).toHaveCount(0);
  else await expect(penalty(page).getByRole('button', { name: 'Eximir incidencia' })).toBeDisabled();
  expect(await output(page, 'calls')).toEqual([]);
});

test('an explicit reconcile hint permits only the entire known balance and survives lost response without rewriting raw history', async ({ page }) => {
  await configure(page, { fixture: 'reconcile-allowed', mode: 'lost-response' }); await open(page);
  await fillCredit(page, 'reconcile_legacy'); await panel(page).getByLabel('Cantidad de clases manuales').fill('4');
  await panel(page).getByRole('button', { name: 'Aprobar crédito manual' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  await configure(page, { fixture: 'unmount' }); await configure(page, { fixture: 'remount', mode: 'success' }); await open(page);
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 4');
  await page.evaluate(() => { crypto.randomUUID = () => { throw new Error('Reconciliation recovery must not generate a UUID'); }; });
  await panel(page).getByRole('button', { name: 'Reintentar operación pendiente' }).click();
  await expect(panel(page).getByTestId('pending-student-credit-operation')).toHaveCount(0);
  const calls = await output(page, 'calls');
  expect(calls).toHaveLength(2); expect(calls[1].input).toEqual(calls[0].input); expect(calls[1].sameObjectAsPrevious).toBe(true);
  expect(calls[1].input).toMatchObject({ mode: 'reconcile_legacy', quantity: 4, expectedLegacyBalance: 4 });
  expect(await output(page, 'ledger')).toHaveLength(1);
  expect((await output(page, 'students'))[0]).toMatchObject({ classesRemaining: 4, legacyManualBalance: 4, canReconcileLegacy: false });
  await expect(panel(page).getByLabel('Modo del crédito manual').locator('option[value="reconcile_legacy"]')).toHaveAttribute('disabled', '');
});

test('new manual approval is independent of a changed raw observation and never reuses it as a funding source', async ({ page }) => {
  await open(page); await fillCredit(page); await configure(page, { fixture: 'change-raw-without-refresh' });
  await panel(page).getByRole('button', { name: 'Aprobar crédito manual' }).click();
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 2');
  expect((await output(page, 'calls'))[0].input).toMatchObject({ mode: 'new_manual', expectedLegacyBalance: 4, quantity: 3 });
  expect(await output(page, 'ledger')).toHaveLength(1);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('manual reason and evidence enforce their limits in HTML and in the intent guard', async ({ page }) => {
  await open(page); await fillCredit(page);
  const reason = panel(page).getByLabel('Motivo del crédito manual', { exact: true });
  const evidence = panel(page).getByLabel('Evidencia / origen del crédito manual', { exact: true });
  const approve = panel(page).getByRole('button', { name: 'Aprobar crédito manual' });
  await expect(reason).toHaveAttribute('maxlength', '2000'); await expect(evidence).toHaveAttribute('maxlength', '10000');
  await forceValue(reason, 'r'.repeat(2001)); await expect(approve).toBeDisabled();
  await approve.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await output(page, 'calls')).toEqual([]);
  await reason.fill('r'.repeat(2000)); await forceValue(evidence, 'e'.repeat(10001)); await expect(approve).toBeDisabled();
  await approve.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await output(page, 'calls')).toEqual([]);
  await evidence.fill('e'.repeat(10000)); await expect(approve).toBeEnabled(); await approve.click();
  const intent = (await output(page, 'calls'))[0].input;
  expect(intent.reason).toHaveLength(2000); expect(intent.evidence).toHaveLength(10000);
});

for (const fixture of ['pending', 'charged']) test(`${fixture} resolution reason cannot exceed 2000 characters, even through a dispatched click`, async ({ page }) => {
  if (fixture === 'charged') await configure(page, { fixture }); await open(page);
  const reason = penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`);
  const waive = penalty(page).getByRole('button', { name: 'Eximir incidencia' });
  await expect(reason).toHaveAttribute('maxlength', '2000'); await forceValue(reason, 'r'.repeat(2001)); await expect(waive).toBeDisabled();
  await waive.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  if (fixture === 'pending') {
    const settle = penalty(page).getByRole('button', { name: 'Aplicar descuento pendiente' });
    await expect(settle).toBeDisabled(); await settle.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }
  expect(await output(page, 'calls')).toEqual([]);
  await reason.fill('r'.repeat(2000)); await waive.click();
  expect((await output(page, 'calls'))[0].input.reason).toHaveLength(2000);
});

test('owner exemption of a charged incident reverses only the original right and preserves settlement audit', async ({ page }) => {
  await configure(page, { fixture: 'charged' }); await open(page);
  expect(await output(page, 'original-source-balance')).toBe(2);
  await penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`).fill('Exencion expresa del cargo original');
  await penalty(page).getByRole('button', { name: 'Eximir incidencia' }).click();
  const call = (await output(page, 'calls'))[0]; assertIntent(call, 'waive_penalty');
  expect(call.input).toMatchObject({ sessionId, expectedRevision: 7, reason: 'Exencion expresa del cargo original' });
  await expect(penalty(page)).toHaveAttribute('data-penalty-state', 'waived');
  expect(await output(page, 'ledger')).toEqual([{ operation: 'waive_penalty', studentId, penaltyId, sourceId: originalId,
    reason: 'Exencion expresa del cargo original', delta: 1 }]);
  expect(await output(page, 'original-source-balance')).toBe(3);
  expect((await output(page, 'students'))[0]).toMatchObject({ classesRemaining: 4, legacyManualBalance: 4, paymentStatus: null, studentCategory: 'temporal' });
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toContainText('Motivo de liquidacion original');
  await expect(penalty(page).locator('input, select, button')).toHaveCount(0);
});

test('charged owner exemption still uses exact receipt recovery after response loss and a changed session revision', async ({ page }) => {
  await configure(page, { fixture: 'charged' }); await start(page, 'waive_penalty', 'lost-response');
  await expect(panel(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  const original = (await output(page, 'calls'))[0];
  await configure(page, { fixture: 'unmount' }); await configure(page, { fixture: 'roll-forward', mode: 'success' });
  await configure(page, { fixture: 'remount' }); await open(page);
  await page.evaluate(() => { crypto.randomUUID = () => { throw new Error('Charged waiver recovery must not generate a UUID'); }; });
  await panel(page).getByRole('button', { name: 'Reintentar operación pendiente' }).click();
  await expect(panel(page).getByTestId('pending-student-credit-operation')).toHaveCount(0);
  const retry = (await output(page, 'calls'))[1]; expect(retry.input).toEqual(original.input); expect(retry.sameObjectAsPrevious).toBe(true);
  expect(retry.input.expectedRevision).toBe(7); expect(await output(page, 'original-source-balance')).toBe(3);
  expect(await output(page, 'ledger')).toHaveLength(1);
  await expect(penalty(page)).toContainText('Revisión de sesión: 12');
});

test('charged audit stays readable without waiver support and missing optional audit is not fabricated', async ({ page }) => {
  await configure(page, { fixture: 'charged' }); await configure(page, { fixture: 'no-waive' }); await open(page);
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toContainText(settlementId);
  await expect(penalty(page).locator('input, select, button')).toHaveCount(0);
  await configure(page, { fixture: 'resolved-no-audit' });
  await expect(penalty(page).getByTestId('penalty-settlement-audit')).toHaveCount(0);
  await expect(penalty(page)).not.toContainText('undefined');
  expect(await output(page, 'calls')).toEqual([]);
});

test('a misleading owner hint cannot reverse an already charged incident', async ({ page }) => {
  await configure(page, { fixture: 'charged', role: 'other-owner', hint: true }); await start(page, 'waive_penalty');
  await expect(panel(page).getByRole('alert')).toContainText('Solo el propietario de esta sede');
  await expect(penalty(page)).toHaveAttribute('data-penalty-state', 'charged');
  expect(await output(page, 'original-source-balance')).toBe(2); expect(await output(page, 'ledger')).toEqual([]);
});

for (const operation of ['approve_manual', 'settle_penalty', 'waive_penalty']) {
  test(`${operation} local validation without a stored intent leaves correction available rather than an uncertain lock`, async ({ page }) => {
    await start(page, operation, 'validation');
    await expect(panel(page).getByRole('alert')).toContainText('Validacion local');
    await expect(panel(page).getByRole('alert')).not.toContainText('Resultado sin confirmar');
    await expect(panel(page).getByTestId('pending-student-credit-operation')).toHaveCount(0);
    expect(await output(page, 'calls')).toEqual([]); expect(await output(page, 'pending-operations')).toEqual([]);
    const button = operation === 'approve_manual' ? panel(page).getByRole('button', { name: 'Aprobar crédito manual' })
      : penalty(page).getByRole('button', { name: operation === 'settle_penalty' ? 'Aplicar descuento pendiente' : 'Eximir incidencia' });
    await expect(button).toBeEnabled(); await expect(panel(page).getByLabel('Cantidad de clases manuales')).toBeEnabled();
    await configure(page, { mode: 'success' }); await button.click();
    assertIntent((await output(page, 'calls'))[0], operation); expect(await output(page, 'ledger')).toHaveLength(1);
  });
  test(`${operation} definite SQL rejection remains frozen until its failed refresh is successfully repeated`, async ({ page }) => {
    await start(page, operation, 'rollback-refresh-failure');
    await expect(panel(page).getByRole('alert')).toContainText('Resultado sin confirmar');
    await expect(panel(page).getByLabel('Cantidad de clases manuales')).toBeDisabled();
    expect(await output(page, 'ledger')).toEqual([]); expect(await output(page, 'pending-operations')).toHaveLength(1);
    const original = (await output(page, 'calls'))[0];
    await configure(page, { mode: 'rollback' }); await panel(page).getByRole('button', { name: 'Reintentar operación pendiente' }).click();
    await expect(panel(page).getByRole('alert')).toContainText('Revisa los datos recargados');
    await expect(panel(page).getByTestId('pending-student-credit-operation')).toHaveCount(0);
    const calls = await output(page, 'calls'); expect(calls[1].input).toEqual(original.input); expect(calls[1].sameObjectAsPrevious).toBe(true);
    expect(await output(page, 'pending-operations')).toEqual([]);
    await configure(page, { mode: 'success' });
    const button = operation === 'approve_manual' ? panel(page).getByRole('button', { name: 'Aprobar crédito manual' })
      : penalty(page).getByRole('button', { name: operation === 'settle_penalty' ? 'Aplicar descuento pendiente' : 'Eximir incidencia' });
    await expect(button).toBeEnabled(); await button.click();
    expect((await output(page, 'calls'))[2].input.requestKey).not.toBe(original.input.requestKey);
    expect(await output(page, 'ledger')).toHaveLength(1);
  });
}

test('stale SQL rejection clears only the old attempt and a new approval captures refreshed raw observations', async ({ page }) => {
  await start(page, 'approve_manual', 'transport'); await configure(page, { fixture: 'unmount' });
  await configure(page, { fixture: 'remount', mode: 'stale' }); await open(page);
  await panel(page).getByRole('button', { name: 'Reintentar operación pendiente' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Revisa los datos recargados');
  await expect(panel(page).getByTestId('legacy-credit-observation')).toContainText('Saldo legado observado: 2');
  await expect(panel(page).getByTestId('pending-student-credit-operation')).toHaveCount(0);
  await configure(page, { mode: 'success' }); await fillCredit(page);
  await panel(page).getByRole('button', { name: 'Aprobar crédito manual' }).click();
  const calls = await output(page, 'calls'); expect(calls).toHaveLength(3);
  expect(calls[1].input).toEqual(calls[0].input);
  expect(calls[2].input.expectedLegacyBalance).toBe(2); expect(calls[2].input.requestKey).not.toBe(calls[0].input.requestKey);
});

test('receipt replay still invokes current actor validation rather than trusting a cached owner label', async ({ page }) => {
  await start(page, 'waive_penalty', 'lost-response');
  await configure(page, { fixture: 'unmount' }); await configure(page, { fixture: 'remount', mode: 'success', role: 'other-owner', hint: false }); await open(page);
  await panel(page).getByRole('button', { name: 'Reintentar operación pendiente' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Solo el propietario de esta sede');
  expect(await output(page, 'ledger')).toHaveLength(1);
  expect(await output(page, 'pending-operations')).toEqual([]);
  await expect(panel(page)).toContainText('Solo lectura');
});

test('homonyms are addressed by student ID and removal of the live profile never reuses its stale snapshot', async ({ page }) => {
  await open(page, otherId); await fillCredit(page); await panel(page).getByRole('button', { name: 'Aprobar crédito manual' }).click();
  expect((await output(page, 'calls'))[0].input.studentId).toBe(otherId);
  expect((await output(page, 'students'))[0].manualCredits).toEqual([]);
  await page.getByRole('button', { name: 'Cerrar ficha' }).click(); await open(page);
  await configure(page, { fixture: 'remove-student' }); await expect(panel(page)).toHaveCount(0);
});

for (const width of [390, 1280]) test(`audit IDs, long evidence and owner controls remain reachable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await configure(page, { fixture: 'long-audit' }); await open(page);
  await panel(page).getByLabel('Cantidad de clases manuales').scrollIntoViewIfNeeded();
  await expect(panel(page).getByLabel('Cantidad de clases manuales')).toBeVisible();
  await penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`).scrollIntoViewIfNeeded();
  await expect(penalty(page).getByLabel(`Motivo de resolución ${penaltyId}`)).toBeVisible();
  expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
