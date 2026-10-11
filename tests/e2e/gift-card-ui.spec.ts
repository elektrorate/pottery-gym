import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Isolated local Vite server, synthetic data/callbacks, no env files or application entry.
// Fixture-only CSS avoids the production Tailwind/font CDNs. This is an interaction
// harness at both viewport sizes, not a production-style visual regression test.
let server: ViteDevServer;
let origin: string;
const memberId = '20000000-0000-0000-0000-000000000001';
const temporaryId = '20000000-0000-0000-0000-000000000002';
test.beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T12:00:00Z') });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/gift-card-integrity-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      * { box-sizing: border-box; } body { margin: 0; font: 14px system-ui; } svg { width: 1em; height: 1em; }
      button, input, select, textarea { font: inherit; max-width: 100%; } label { display: block; min-width: 0; }
      label > span:first-child { display: block; } input, select, textarea { width: 100%; } button { cursor: pointer; }
      button:disabled { cursor: not-allowed; } p { overflow-wrap: anywhere; } fieldset { min-width: 0; margin-bottom: 12px; }
      .flex { display: flex; } .flex-col { flex-direction: column; } .flex-wrap { flex-wrap: wrap; } .grid { display: grid; gap: 12px; }
      .fixed { position: fixed; } .inset-0 { inset: 0; } .overflow-hidden { overflow: hidden; } .overflow-y-auto { overflow-y: auto; }
      .min-h-0 { min-height: 0; } .flex-1 { flex: 1; } .shrink-0 { flex-shrink: 0; }
      .fixed { background: #fff; z-index: 100; justify-content: center; } .fixed form { width: 100%; max-width: 768px; max-height: 100dvh; }
      .fixed form > header, .fixed form > footer, .fixed form > div { padding: 12px; }
      [role="dialog"] { margin: auto; max-width: min(100%, 440px); padding: 20px; background: white; }
      [class~="z-[300]"] { z-index: 300; background: #eee; } .fixed form > header { justify-content: space-between; }
      .fixed form > footer { gap: 12px; } .fixed form > div { overflow-y: auto; }
      @media(min-width:768px) { [class~="md:grid-cols-2"] { grid-template-columns: 1fr 1fr; } [class~="md:col-span-2"] { grid-column: span 2; } }
    </style></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/gift-card-ui-harness.tsx');
    </script></body></html>` }));
  await page.goto(`${origin}/gift-card-integrity-test`);
  await expect(page.getByRole('heading', { name: 'Tarjetas de Regalo', exact: true })).toBeVisible();
});
const calls = async (page: Page) => JSON.parse((await page.getByTestId('calls').textContent())!);
const fillNew = async (page: Page) => {
  await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
  await page.getByLabel('Nombre del comprador', { exact: true }).fill('Comprador nuevo');
  await page.getByLabel('Teléfono', { exact: true }).fill('600000000');
  await page.getByLabel('Email', { exact: true }).fill('buyer@example.test');
};
const open = (page: Page, recipient: string) => page.getByRole('button').filter({ hasText: recipient }).click();
const protectedFields = ['status', 'paymentStatus', 'sessionsUsed', 'sessionsRemaining', 'consumedAt', 'activatedAt', 'expiryDate'];

test('name/email never auto-select or auto-create a recipient, even with duplicate names', async ({ page }) => {
  await fillNew(page);
  await page.getByLabel('Nombre del destinatario').fill('Alex Perez');
  await page.getByLabel('Email del destinatario').fill('member@example.test');
  await expect(page.getByLabel('Alumno destinatario', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Crear bono', exact: true })).toBeDisabled();
  await expect(page.locator('form').getByRole('status')).toContainText('Sin alumno seleccionado');
  await page.getByLabel('Buscar alumno destinatario').fill('Alex');
  const selector = page.getByLabel('Alumno destinatario', { exact: true });
  await expect(selector.locator('option')).toHaveCount(3);
  await selector.selectOption(temporaryId);
  await page.getByLabel('Nombre del destinatario').fill('Etiqueta para regalo');
  await expect(selector).toHaveValue(temporaryId);
  await page.getByRole('button', { name: 'Crear bono', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nuevo bono temporal', exact: true })).toHaveCount(0);
  const saved = await calls(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].data.recipientStudentId).toBe(temporaryId);
  expect(saved[0].data.recipient).toBe('Etiqueta para regalo');
  for (const field of protectedFields.filter(field => field !== 'paymentStatus')) expect(saved[0].data).not.toHaveProperty(field);
  expect(JSON.parse((await page.getByTestId('student-identities').textContent())!)).toEqual([memberId, temporaryId]);
});
test('searching by authorized email requires explicit selection and clearing it blocks save', async ({ page }) => {
  await fillNew(page);
  await page.getByLabel('Buscar alumno destinatario').fill('member@example.test');
  const selector = page.getByLabel('Alumno destinatario', { exact: true });
  await expect(selector.locator('option')).toHaveCount(2);
  await expect(selector).toHaveValue('');
  await selector.selectOption(memberId);
  await selector.selectOption('');
  await expect(page.getByRole('button', { name: 'Crear bono', exact: true })).toBeDisabled();
  await page.getByLabel('Buscar alumno destinatario').fill('no autorizado');
  await expect(selector.locator('option')).toHaveCount(1);
  expect(await calls(page)).toEqual([]);
});
test('existing explicit selection survives label edits/search and submits no inferred terms or invariants', async ({ page }) => {
  await open(page, 'Etiqueta conservada');
  const selector = page.getByLabel('Alumno destinatario', { exact: true });
  await expect(selector).toHaveValue(temporaryId);
  await page.getByLabel('Nombre del destinatario').fill('Alex con otra etiqueta');
  await page.getByLabel('Buscar alumno destinatario').fill('no coincide');
  await expect(selector).toHaveValue(temporaryId);
  await expect(selector.locator('option')).toHaveCount(2);
  await expect(page.getByLabel('Estado del pago')).toBeDisabled();
  await expect(page.getByLabel('Estado del bono')).toBeDisabled();
  await expect(page.getByLabel('Sesiones utilizadas')).toBeDisabled();
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect(await calls(page)).toEqual([{ action: 'update', id: 'linked', data: { recipient: 'Alex con otra etiqueta' } }]);
  await open(page, 'Alex con otra etiqueta');
  await expect(selector).toHaveValue(temporaryId);
});
test('recipient changes are explicit and a link absent from the refreshed list stays selected', async ({ page }) => {
  await open(page, 'Etiqueta conservada');
  await page.getByLabel('Alumno destinatario', { exact: true }).selectOption(memberId);
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await calls(page))[0].data.recipientStudentId).toBe(memberId);
  await open(page, 'Vinculo fuera de lista');
  const selector = page.getByLabel('Alumno destinatario', { exact: true });
  await expect(selector).toHaveValue('20000000-0000-0000-0000-000000000003');
  await page.evaluate(() => window.dispatchEvent(new Event('gift-card-test-remove-students')));
  await expect(selector).toHaveValue('20000000-0000-0000-0000-000000000003');
  await page.getByLabel('Nombre del destinatario').fill('Etiqueta antigua corregida');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await calls(page))[1].data).toEqual({ recipient: 'Etiqueta antigua corregida' });
});
test('new/replacement identities disappearing from the authorized list cannot save', async ({ page }) => {
  await fillNew(page);
  await page.getByLabel('Alumno destinatario', { exact: true }).selectOption(memberId);
  await page.evaluate(() => window.dispatchEvent(new Event('gift-card-test-remove-students')));
  await expect(page.getByRole('button', { name: 'Crear bono', exact: true })).toBeDisabled();
  expect(await calls(page)).toEqual([]);
});
test('legacy metadata edits preserve unknown terms; recipient label edits require an explicit link', async ({ page }) => {
  await open(page, 'Bono antiguo');
  await page.getByLabel('Dedicatoria personalizada').fill('Solo dedicatoria');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await calls(page))[0].data).toEqual({ dedication: 'Solo dedicatoria' });
  await open(page, 'Bono antiguo');
  await page.getByLabel('Nombre del destinatario').fill('Otro nombre');
  await expect(page.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeDisabled();
  await page.getByLabel('Alumno destinatario', { exact: true }).selectOption(memberId);
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await calls(page))[1].data.recipientStudentId).toBe(memberId);
});
test('used card locks identity/terms but preserves label editing and legacy allocation', async ({ page }) => {
  await open(page, 'Bono con historial');
  for (const label of ['Alumno destinatario', 'Tipo de clase', 'Número de sesiones', 'Vigencia']) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Número de sesiones')).toHaveValue('3');
  await page.getByLabel('Nombre del destinatario').fill('Etiqueta del historial');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await calls(page))[0].data).toEqual({ recipient: 'Etiqueta del historial' });
});
test('existing payment uses a separate confirmed callback and never an update payload', async ({ page }) => {
  await open(page, 'Pago pendiente');
  await expect(page.getByLabel('Estado del pago')).toBeDisabled();
  await page.getByRole('button', { name: 'Confirmar pago del bono', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '¿Confirmar pago del bono?' });
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect(await calls(page)).toEqual([]);
  await page.getByRole('button', { name: 'Confirmar pago del bono', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirmar pago', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page)).toEqual([{ action: 'confirm_gift_card_payment', id: 'pending' }]);
});
test('missing payment callback fails closed rather than directly editing payment', async ({ page }) => {
  await page.getByRole('button', { name: 'Desconectar pago', exact: true }).click();
  await open(page, 'Pago pendiente');
  await expect(page.getByRole('button', { name: 'Confirmar pago del bono', exact: true })).toBeDisabled();
  await expect(page.getByText('Confirmación de pago no disponible hasta conectar la operación autorizada.')).toBeVisible();
  expect(await calls(page)).toEqual([]);
});
test('consume keeps confirmation and uses server date; cancel retains history instead of deletion', async ({ page }) => {
  await open(page, 'Etiqueta conservada');
  await page.getByRole('button', { name: 'Bono consumido', exact: true }).click();
  const consume = page.getByRole('dialog', { name: '¿Marcar bono como consumido?' });
  await consume.getByRole('button', { name: 'Bono consumido', exact: true }).click();
  await expect(consume).toHaveCount(0);
  expect(await calls(page)).toEqual([{ action: 'consume_gift_card', id: 'linked' }]);
  await open(page, 'Pago pendiente');
  await page.getByRole('button', { name: 'Anular / eliminar', exact: true }).click();
  const cancel = page.getByRole('dialog', { name: '¿Anular este bono?' });
  await expect(cancel).toContainText('movimientos históricos se conservarán');
  await cancel.getByRole('button', { name: 'Anular bono', exact: true }).click();
  await expect(cancel).toHaveCount(0);
  expect((await calls(page))[1]).toEqual({ action: 'cancel_gift_card', id: 'pending' });
});
test('buyer/duration/archive filters retain existing selection behavior', async ({ page }) => {
  const search = page.getByLabel('Buscar tarjeta por nombre del comprador');
  await search.fill('archivado');
  await expect(page.getByRole('button').filter({ hasText: 'Bono archivado' })).toHaveCount(0);
  await page.getByRole('tab', { name: /Archivados/ }).click();
  await expect(search).toHaveValue('archivado');
  await page.getByLabel('Filtrar por duración y caducidad').selectOption('6');
  await open(page, 'Bono archivado');
  await expect(page.getByLabel('Alumno destinatario', { exact: true })).toHaveValue(temporaryId);
  await expect(page.getByRole('button', { name: 'Bono consumido', exact: true })).toHaveCount(0);
});
test('redeem/reverse/redeem retains the net active balance and historical snapshot', async ({ page }) => {
  const snapshot = JSON.parse((await page.getByTestId('gift-card-snapshots').textContent())!).find(card => card.id === 'cycle');
  expect(snapshot).toMatchObject({ status: 'active', numClasses: 2, sessionsUsed: 1, sessionsRemaining: 1 });
  expect(snapshot.movements.map(movement => [movement.type, movement.sessionsDelta])).toEqual([['redeem', 1], ['reverse', -1], ['redeem', 1]]);
  const row = page.getByRole('button').filter({ hasText: 'Bono con ciclo' });
  await expect(row).toContainText('Activo');
  await expect(row).not.toContainText('Consumido');
  await expect(row.locator('strong')).toHaveText('1');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeVisible();
  await page.getByRole('tab', { name: /Archivados/ }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('tab', { name: /Activos/ }).click();
  await open(page, 'Bono con ciclo');
  await expect(page.getByLabel('Estado del bono')).toHaveValue('active');
  await expect(page.getByLabel('Sesiones utilizadas')).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'Bono consumido', exact: true })).toBeVisible();
  await page.getByLabel('Dedicatoria personalizada').fill('Ciclo conservado');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect(await calls(page)).toEqual([{ action: 'update', id: 'cycle', data: { dedication: 'Ciclo conservado' } }]);
  const saved = JSON.parse((await page.getByTestId('gift-card-snapshots').textContent())!).find(card => card.id === 'cycle');
  expect(saved).toEqual({ ...snapshot, dedication: 'Ciclo conservado' });
  await expect(row).toContainText('Activo');
});
test('duplicate or ambiguous movements cannot infer exhaustion or overwrite unknown snapshots', async ({ page }) => {
  const snapshots = JSON.parse((await page.getByTestId('gift-card-snapshots').textContent())!);
  for (const [id, recipient] of [['duplicate-history', 'Bono con duplicados'], ['unknown-balance', 'Historial sin saldo']]) {
    const snapshot = snapshots.find(card => card.id === id);
    expect(snapshot.movements.reduce((net, movement) => net + movement.sessionsDelta, 0)).toBe(2);
    const row = page.getByRole('button').filter({ hasText: recipient });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('Consumido');
    await page.getByRole('tab', { name: /Archivados/ }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole('tab', { name: /Activos/ }).click();
    await open(page, recipient);
    await page.getByLabel('Dedicatoria personalizada').fill('Solo metadatos');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    expect((await calls(page)).at(-1)).toEqual({ action: 'update', id, data: { dedication: 'Solo metadatos' } });
    const saved = JSON.parse((await page.getByTestId('gift-card-snapshots').textContent())!).find(card => card.id === id);
    expect(saved).toEqual({ ...snapshot, dedication: 'Solo metadatos' });
  }
});
test('manual consumption, legacy archive markers and cancelled/expired status remain authoritative', async ({ page }) => {
  const snapshots = JSON.parse((await page.getByTestId('gift-card-snapshots').textContent())!);
  for (const [id, recipient, label] of [
    ['manual-cycle', 'Consumo manual corregido', 'Consumido'],
    ['legacy-consumed', 'Consumo antiguo fechado', 'Consumido'],
    ['exhausted', 'Agotado antiguo', 'Consumido'],
    ['cancelled-cycle', 'Ciclo anulado', 'Anulado'],
    ['expired-cycle', 'Ciclo caducado', 'Caducado']
  ]) {
    const row = page.getByRole('button').filter({ hasText: recipient });
    await expect(row).toHaveCount(0);
    await page.getByRole('tab', { name: /Archivados/ }).click();
    await expect(row).toContainText(label);
    await open(page, recipient);
    await expect(page.getByRole('button', { name: 'Bono consumido', exact: true })).toHaveCount(0);
    await page.getByLabel('Dedicatoria personalizada').fill('Archivo conservado');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    expect((await calls(page)).at(-1)).toEqual({ action: 'update', id, data: { dedication: 'Archivo conservado' } });
    const saved = JSON.parse((await page.getByTestId('gift-card-snapshots').textContent())!).find(card => card.id === id);
    expect(saved).toEqual({ ...snapshots.find(card => card.id === id), dedication: 'Archivo conservado' });
    await page.getByRole('tab', { name: /Activos/ }).click();
  }
});
test('failed callback keeps the form and selected ID with no automatic retry', async ({ page }) => {
  await page.getByRole('button', { name: 'Simular fallo', exact: true }).click();
  await fillNew(page);
  await page.getByLabel('Alumno destinatario', { exact: true }).selectOption(temporaryId);
  await page.getByRole('button', { name: 'Crear bono', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Fallo sintetico');
  await expect(page.getByLabel('Alumno destinatario', { exact: true })).toHaveValue(temporaryId);
  await expect(page.getByRole('button', { name: 'Crear bono', exact: true })).toBeEnabled();
  expect(await calls(page)).toHaveLength(1);
});
test('pending save disables duplicate submission until the callback settles', async ({ page }) => {
  await page.getByRole('button', { name: 'Simular espera', exact: true }).click();
  await fillNew(page);
  await page.getByLabel('Alumno destinatario', { exact: true }).selectOption(memberId);
  await page.getByRole('button', { name: 'Crear bono', exact: true }).click();
  await expect(page.getByRole('button', { name: /Guardando/ })).toBeDisabled();
  await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event('gift-card-test-release')));
  await expect(page.locator('form')).toHaveCount(0);
});
test('mobile identity flow remains accessible without selecting or creating by name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fillNew(page);
  await page.getByLabel('Nombre del destinatario').fill('Alex Perez');
  await expect(page.getByRole('button', { name: 'Crear bono', exact: true })).toBeDisabled();
  await page.getByLabel('Buscar alumno destinatario').fill('temporary@example.test');
  await page.getByLabel('Alumno destinatario', { exact: true }).selectOption(temporaryId);
  await expect(page.getByLabel('Alumno destinatario', { exact: true })).toHaveValue(temporaryId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Crear bono', exact: true }).click();
  expect((await calls(page))[0].data.recipientStudentId).toBe(temporaryId);
});
