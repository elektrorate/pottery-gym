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
  await page.getByRole('tab', { name: /Activos/ }).click();
  await expect(page.getByRole('button', { name: /ACTIVO SIN CLASES/ })).toBeVisible();
  await expect(page.getByText(/Mostrando 1 de 1 alumnos activos/)).toBeVisible();
  await expect(page.getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /INACTIVO DIA SEIS/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Inactivos/ }).click();
  await expect(page.getByRole('button', { name: /INACTIVO DIA SEIS/ })).toBeVisible();
  await page.getByRole('tab', { name: /Temporales/ }).click();
  await expect(page.getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /TEMPORAL HISTORICO/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Todos/ }).click();
  await expect(page.getByText(/6 alumnos registrados/)).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  await expect(page.getByText('Activos de membresía').locator('..')).toContainText('1');
  await expect(page.getByText('Pendientes de pago', { exact: true }).locator('..')).toContainText('1');
});

test('search persists while secondary filters stay scoped to the selected tab', async ({ page }) => {
  const search = page.getByLabel('Buscar alumno por nombre o apellidos');
  await search.fill('SIN CLASES');
  await page.getByRole('tab', { name: /Activos/ }).click();
  await expect(search).toHaveValue('SIN CLASES');
  await expect(page.locator('#students-results').getByRole('button', { name: /ACTIVO SIN CLASES/ })).toBeVisible();
  await page.getByRole('tab', { name: /Temporales/ }).click();
  await expect(page.locator('#students-results').getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Filtrar por tipo' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Filtrar por plan' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  await page.getByRole('tab', { name: /Todos/ }).click();
  await page.getByRole('combobox', { name: 'Filtrar por tipo' }).selectOption('membresia');
  await expect(page.getByRole('combobox', { name: 'Filtrar por plan' })).toBeVisible();
  await expect(page.locator('#students-results').getByRole('button', { name: /TEMPORAL SIN CLASES/ })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Filtrar por plan' }).selectOption('gold');
  await expect(page.locator('#students-results').getByRole('button', { name: /ACTIVO SIN CLASES/ })).toBeVisible();
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('combobox', { name: 'Filtrar por tipo' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Filtrar por plan' })).toBeVisible();
});

test('mobile layout keeps tabs and row state visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: /Activos/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Inactivos/ })).toBeVisible();
  await page.getByRole('tab', { name: /Activos/ }).click();
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
  await page.getByRole('tab', { name: /Inactivos/ }).click();
  await page.getByRole('button', { name: /TEMPORAL HISTORICO/ }).click();
  await expect(page.getByLabel('Bonos contratados', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Bonos restantes', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('"classesRemaining":3');
  await expect(page.getByTestId('saved')).toContainText('"studentCategory":"temporal"');
  await expect(page.getByTestId('saved')).toContainText('"status":"new"');
  await expect(page.getByTestId('saved')).not.toContainText('paymentStatus');
});

test('sixth-day transition updates an already open screen', async ({ page }) => {
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toBeVisible();
  await page.clock.setSystemTime(new Date('2026-10-16T22:01:00Z'));
  await page.clock.runFor(31_000);
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Inactivos/ }).click();
  await expect(page.getByRole('button', { name: /PENDIENTE DIA CINCO/ })).toBeVisible();
});

test('deleting still requires confirmation and does not archive', async ({ page }) => {
  await page.getByRole('tab', { name: /Inactivos/ }).click();
  await page.getByRole('button', { name: /TEMPORAL HISTORICO/ }).click();
  await page.getByRole('button', { name: 'Eliminar alumno', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '¿Eliminar alumno?' });
  await expect(dialog).toContainText('Esta acción no se puede deshacer');
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar alumno', exact: true }).click();
  await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(page.getByRole('button', { name: /TEMPORAL HISTORICO/ })).toHaveCount(0);
});

test('payment persists independently and expired member can be reactivated', async ({ page }) => {
  await page.getByRole('tab', { name: /Inactivos/ }).click();
  await page.getByRole('button', { name: /INACTIVO DIA SEIS/ }).click();
  await page.getByLabel('Estado del pago').selectOption('paid');
  await page.getByLabel('Fecha de vencimiento de pago').fill('2026-11-16');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('"paymentStatus":"paid"');
  await page.getByRole('tab', { name: /Activos/ }).click();
  await expect(page.getByRole('button', { name: /INACTIVO DIA SEIS/ })).toBeVisible();
});
