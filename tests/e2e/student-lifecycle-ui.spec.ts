import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
  await page.route('**/lifecycle-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/student-lifecycle-harness.tsx');
    </script></body></html>` })) ;
  await page.goto('/lifecycle-test');
  await expect(page.getByRole('heading', { name: 'Alumnos', exact: true })).toBeVisible();
});

test('single lifecycle tabs and dashboard share the same membership counts', async ({ page }) => {
  await page.getByRole('tab', { name: 'Al día', exact: true }).click();
  await expect(page.getByRole('button', { name: /ACTIVO SIN CLASES/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /INACTIVO DIA SEIS/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Vencidas', exact: true }).click();
  await expect(page.getByRole('button', { name: /INACTIVO DIA SEIS/ })).toBeVisible();
  await page.getByRole('button', { name: /Temporal 1/ }).click();
  await expect(page.getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /TEMPORAL HISTORICO/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Todos 4/ }).click();
  await expect(page.locator('header').getByText('6', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  await expect(page.getByText('Activos de membresía').locator('..')).toContainText('1');
  await expect(page.getByText('Pendientes de pago', { exact: true }).locator('..')).toContainText('1');
});

test('search persists while secondary filters stay scoped to the selected tab', async ({ page }) => {
  const search = page.getByLabel('Buscar alumno por nombre o apellidos');
  await search.fill('SIN CLASES');
  await page.getByRole('tab', { name: 'Al día', exact: true }).click();
  await expect(search).toHaveValue('SIN CLASES');
  await expect(page.locator('button.ui-list').filter({ hasText: 'ACTIVO SIN CLASES' })).toBeVisible();
  await page.getByRole('button', { name: /Temporal 1/ }).click();
  await expect(page.locator('button.ui-list').filter({ hasText: 'TEMPORAL SIN CLASES' })).toBeVisible();

  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  await page.getByRole('button', { name: /Membresía 3/ }).click();
  await expect(page.getByRole('button', { name: 'Gold', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Gold', exact: true }).click();
  await expect(page.getByRole('button', { name: /ACTIVO SIN CLASES/ })).toBeVisible();
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: 'Gold', exact: true })).toBeVisible();
});

test('mobile layout keeps tabs and row state visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'Al día', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Vencidas', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Al día', exact: true }).click();
  await expect(page.getByRole('button', { name: /ACTIVO SIN CLASES/ })).toContainText('Activo');
});

test('new temporary has one class and an independent category/status', async ({ page }) => {
  await page.getByRole('button', { name: 'Crear nuevo alumno' }).click();
  await page.getByLabel('Categoría del alumno').selectOption('temporal');
  await page.getByRole('button', { name: 'Cambiar categoría', exact: true }).click();
  await expect(page.getByLabel('Bonos contratados', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Bonos restantes', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Aumentar bonos' }).click();
  await expect(page.getByLabel('Bonos contratados', { exact: true })).toHaveValue('1');
});

test('editing legacy temporary preserves already assigned classes', async ({ page }) => {
  await page.getByRole('button', { name: /Archivados 2/ }).click();
  await page.getByRole('button', { name: /TEMPORAL HISTORICO/ }).click();
  await expect(page.getByLabel('Bonos contratados', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Bonos restantes', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('"classesRemaining":3');
  await expect(page.getByTestId('saved')).toContainText('"studentCategory":"temporal"');
  await expect(page.getByTestId('saved')).toContainText('"status":"new"');
  await expect(page.getByTestId('saved')).toContainText('"paymentStatus":null');
});

test('sixth-day transition updates an already open screen', async ({ page }) => {
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toBeVisible();
  await page.clock.setSystemTime(new Date('2026-10-16T22:01:00Z'));
  await page.clock.runFor(31_000);
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Vencidas', exact: true }).click();
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toBeVisible();
});

test('deleting still requires confirmation and does not archive', async ({ page }) => {
  await page.getByRole('button', { name: /Archivados 2/ }).click();
  await page.getByRole('button', { name: /TEMPORAL HISTORICO/ }).click();
  await page.getByRole('button', { name: 'Eliminar alumno', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '¿Eliminar alumno?' });
  await expect(dialog).toContainText('Esta acción no se puede deshacer');
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar alumno', exact: true }).click();
  await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(page.getByRole('button', { name: /TEMPORAL HISTORICO/ })).toHaveCount(0);
});

test('period payment fields are protected and expired member can be reactivated explicitly', async ({ page }) => {
  await page.getByRole('tab', { name: 'Vencidas', exact: true }).click();
  await page.getByRole('button', { name: /INACTIVO DIA SEIS/ }).click();
  await expect(page.getByLabel('Estado del pago')).toBeDisabled();
  await expect(page.getByText(/El perfil no modifica categoría, plan, fechas, precio, clases ni pagos/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reactivar alumno manualmente' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: /Archivados 2/ }).click();
  await page.getByRole('button', { name: /MEMBRESIA ARCHIVADA/ }).click();
  await page.getByRole('button', { name: 'Reactivar alumno manualmente' }).click();
  await expect(page.getByTestId('saved')).toContainText('"archivedAt":""');
});
