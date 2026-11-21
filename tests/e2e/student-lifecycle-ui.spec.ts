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
  await expect(page.getByRole('button', { name: /Activo Sin Clases/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Temporal Sin Clases/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: /Pendiente Dia Cinco/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Inactivo Dia Seis/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Vencidas', exact: true }).click();
  await expect(page.getByRole('button', { name: /Inactivo Dia Seis/ })).toBeVisible();
  await page.getByRole('button', { name: /^Bonos de clases\s+1$/i }).click();
  await expect(page.getByRole('button', { name: /Temporal Sin Clases/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Temporal Historico/ })).toHaveCount(0);
  await expect(page.locator('button.ui-list')).toHaveCount(1);
  await expect(page.getByRole('tablist', { name: 'Estado de membresías', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Archivados\s+2$/i }).click();
  await expect(page.locator('button.ui-list')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Temporal Historico/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Membresia Archivada/ })).toBeVisible();
  await page.getByRole('button', { name: /^Membresía\s+3$/i }).click();
  await page.getByRole('tab', { name: 'Todos', exact: true }).click();
  await expect(page.locator('button.ui-list')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /Activo Sin Clases/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Pendiente Dia Cinco/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Inactivo Dia Seis/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Temporal Sin Clases/ })).toHaveCount(0);
  const summary = page.locator('[aria-label="Resumen de alumnos"]');
  await expect(summary.getByText('membresías', { exact: true }).locator('..')).toHaveText(/^3\s*membresías$/i);
  await expect(summary.getByText('bonos de clases', { exact: true }).locator('..')).toHaveText(/^1\s*bonos de clases$/i);
  await expect(summary.getByText('grupales', { exact: true }).locator('..')).toHaveText(/^1\s*grupales$/i);
  await expect(summary.getByText('grupo temporal', { exact: true }).locator('..')).toHaveText(/^1\s*grupo temporal$/i);
  await page.getByRole('button', { name: /^Grupal\s+1$/i }).click();
  await expect(page.getByRole('button', { name: /Grupal Visible/ })).toBeVisible();
  await page.getByRole('button', { name: /^Grupo temporal\s+1$/i }).click();
  await expect(page.getByRole('button', { name: /Grupo Temporal Visible/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  await expect(page.getByText('Activos de membresía').locator('..')).toContainText('3');
  await expect(page.getByText('Pendientes de pago', { exact: true }).locator('..')).toContainText('1');
});

test('search persists while secondary filters stay scoped to the selected tab', async ({ page }) => {
  const search = page.getByLabel('Buscar alumno por nombre o apellidos');
  await search.fill('SIN CLASES');
  await page.getByRole('tab', { name: 'Al día', exact: true }).click();
  await expect(search).toHaveValue('SIN CLASES');
  await expect(page.locator('button.ui-list').filter({ hasText: 'Activo Sin Clases' })).toBeVisible();
  await page.getByRole('button', { name: /^Bonos de clases\s+1$/i }).click();
  await expect(page.locator('button.ui-list').filter({ hasText: 'Temporal Sin Clases' })).toBeVisible();
  await expect(search).toHaveValue('SIN CLASES');
  await expect(page.getByRole('combobox', { name: /^Elegir plan\b/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
  await page.getByRole('button', { name: /^Membresía\s+3$/i }).click();
  const plan = page.getByRole('combobox', { name: /^Elegir plan\b/i });
  await expect(plan).toBeVisible();
  await expect(page.getByRole('button', { name: /Temporal Sin Clases/ })).toHaveCount(0);
  await plan.selectOption('gold');
  await expect(plan).toHaveValue('gold');
  await page.getByRole('tab', { name: 'Al día', exact: true }).click();
  await expect(page.getByRole('button', { name: /Activo Sin Clases/ })).toBeVisible();
  await expect(page.locator('button.ui-list')).toHaveCount(1);
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(plan).toBeVisible();
  await expect(plan).toHaveValue('gold');
  await expect(page.getByRole('button', { name: /Pendiente Dia Cinco/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Activo Sin Clases/ })).toHaveCount(0);
  await expect(page.locator('button.ui-list')).toHaveCount(1);
});

test('mobile layout keeps tabs and row state visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'Al día', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Vencidas', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Al día', exact: true }).click();
  await expect(page.getByRole('button', { name: /Activo Sin Clases/ })).toContainText('Activo');
});

test('new temporary can raise the contracted class count above 1', async ({ page }) => {
  await page.getByRole('button', { name: 'Crear nuevo alumno' }).click();
  await page.getByLabel('Categoría del alumno').selectOption('temporal');
  await page.getByRole('button', { name: 'Cambiar categoría', exact: true }).click();
  await expect(page.getByLabel('Clases contratadas', { exact: true })).toHaveValue('4');
  await page.getByRole('button', { name: 'Aumentar clases', exact: true }).click();
  await expect(page.getByLabel('Clases contratadas', { exact: true })).toHaveValue('5');
  await page.getByRole('button', { name: 'Aumentar clases', exact: true }).click();
  await expect(page.getByLabel('Clases contratadas', { exact: true })).toHaveValue('6');
  await expect(page.getByLabel('Clases restantes', { exact: true })).toHaveValue('6');
});

test('grupal profile opens and payment status can be confirmed', async ({ page }) => {
  await page.getByRole('button', { name: /^Grupal\s+1$/i }).click();
  await page.getByRole('button', { name: /Grupal Visible/ }).click();
  await expect(page.getByRole('heading', { name: /^Grupal Visible$/ })).toBeVisible();
  await expect(page.getByLabel('Clases contratadas', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Clases restantes', { exact: true })).toHaveValue('4');
  await page.getByLabel('Estado del pago').selectOption('paid');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('"paymentStatus":"paid"');
  await expect(page.getByTestId('saved')).toContainText('"studentCategory":"grupal"');
});

test('editing legacy temporary preserves already assigned classes', async ({ page }) => {
  await page.getByRole('button', { name: /^Archivados\s+2$/i }).click();
  await page.getByRole('button', { name: /Temporal Historico/ }).click();
  await expect(page.getByLabel('Clases contratadas', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Clases restantes', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('"classesRemaining":3');
  await expect(page.getByTestId('saved')).toContainText('"studentCategory":"temporal"');
  await expect(page.getByTestId('saved')).toContainText('"status":"new"');
  await expect(page.getByTestId('saved')).toContainText('"paymentStatus":null');
});

test('sixth-day transition updates an already open screen', async ({ page }) => {
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await expect(page.getByRole('button', { name: /Pendiente Dia Cinco/ })).toBeVisible();
  await page.clock.setSystemTime(new Date('2026-10-16T22:01:00Z'));
  await page.clock.runFor(31_000);
  await expect(page.getByRole('button', { name: /Pendiente Dia Cinco/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Vencidas', exact: true }).click();
  await expect(page.getByRole('button', { name: /Pendiente Dia Cinco/ })).toBeVisible();
});

test('deleting still requires confirmation and does not archive', async ({ page }) => {
  await page.getByRole('button', { name: /^Archivados\s+2$/i }).click();
  await page.getByRole('button', { name: /Temporal Historico/ }).click();
  const dangerZone = page.getByRole('region', { name: 'Zona de peligro' });
  await expect(dangerZone).toBeVisible();
  await expect(dangerZone.getByRole('button', { name: 'Archivar alumno manualmente' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Eliminar alumno', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '¿Eliminar alumno?' });
  await expect(dialog).toContainText(/Temporal Historico/);
  await expect(dialog).toContainText('Esta acción no se puede deshacer');
  await expect(dialog).toContainText('Archivar');
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar alumno', exact: true }).click();
  await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(page.getByRole('button', { name: /Temporal Historico/ })).toHaveCount(0);
});

test('pending payment can be confirmed from the profile and the dashboard counter follows', async ({ page }) => {
  await page.getByRole('tab', { name: /Pendientes/ }).click();
  await page.getByRole('button', { name: /Pendiente Dia Cinco/ }).click();
  await expect(page.getByRole('button', { name: 'Confirmar pago', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar pago', exact: true }).click();
  await expect(page.getByTestId('payment-state')).toHaveText('Pago al día');
  await expect(page.getByRole('button', { name: 'Confirmar pago', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  await expect(page.getByText('Pendientes de pago', { exact: true }).locator('..')).toContainText('0');
});

test('manual class balance changes wait for a reason and confirmation', async ({ page }) => {
  await page.getByRole('button', { name: /^Grupal\s+1$/i }).click();
  await page.getByRole('button', { name: /Grupal Visible/ }).click();
  await expect(page.getByTestId('payment-state')).toHaveText('Pago al día');
  await expect(page.getByRole('button', { name: 'Archivar alumno manualmente' })).toBeVisible();
  const dangerZone = page.getByRole('region', { name: 'Zona de peligro' });
  await expect(dangerZone.getByRole('button', { name: 'Eliminar alumno' })).toBeVisible();
  await expect(dangerZone.getByRole('button', { name: 'Archivar alumno manualmente' })).toHaveCount(0);
  const remaining = page.getByLabel('Clases restantes', { exact: true });
  await expect(remaining).toHaveValue('4');
  await page.getByRole('button', { name: 'Reducir clases restantes' }).click();
  await expect(remaining).toHaveValue('4');
  const dialog = page.getByRole('dialog', { name: '¿Ajustar clases?' });
  await expect(dialog).toContainText('4');
  await expect(dialog).toContainText('3');
  await expect(dialog.getByRole('button', { name: 'Confirmar', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(remaining).toHaveValue('4');
  await page.getByRole('button', { name: 'Reducir clases restantes' }).click();
  await dialog.getByRole('button', { name: 'Corrección', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(remaining).toHaveValue('3');
  await expect(page.getByTestId('saved')).toContainText('"classesRemaining":3');
});

test('scalar pending payment confirms without a membership period', async ({ page }) => {
  await page.getByRole('button', { name: /^Grupo temporal\s+1$/i }).click();
  await page.getByRole('button', { name: /Grupo Temporal Visible/ }).click();
  await page.getByRole('button', { name: 'Confirmar pago', exact: true }).click();
  await expect(page.getByTestId('payment-state')).toHaveText('Pago al día');
  await expect(page.getByTestId('saved')).toContainText('"paymentStatus":"paid"');
});

test('period payment fields are protected and expired member can be reactivated explicitly', async ({ page }) => {
  await page.getByRole('tab', { name: 'Vencidas', exact: true }).click();
  await page.getByRole('button', { name: /Inactivo Dia Seis/ }).click();
  await expect(page.getByLabel('Estado del pago')).toBeDisabled();
  await expect(page.getByText(/El perfil no modifica categoría, plan, fechas, precio, clases ni pagos/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reactivar alumno manualmente' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: /^Archivados\s+2$/i }).click();
  await page.getByRole('button', { name: /Membresia Archivada/ }).click();
  await page.getByRole('button', { name: 'Reactivar alumno manualmente' }).click();
  await expect(page.getByTestId('saved')).toContainText('"archivedAt":""');
});

test('linked gift cards show contracted classes, buyer details and type in the student ficha', async ({ page }) => {
  await page.getByRole('button', { name: 'Cargar bono vinculado' }).click();
  await page.getByRole('button', { name: /^Bonos de clases\s+2$/i }).click();
  const row = page.getByRole('button').filter({ hasText: 'Paula Bono' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2 clases');
  await expect(row).toContainText('Modelado');
  await row.click();
  await expect(page.getByRole('heading', { name: /^Paula Bono$/ })).toBeVisible();
  await expect(page.getByLabel('Clases contratadas')).toHaveValue('2');
  await expect(page.getByLabel('Clases restantes')).toHaveValue('2');
  await expect(page.getByText('CR-796024D9E0 · Modelado')).toBeVisible();
  await expect(page.getByText('100 € · Pagado')).toBeVisible();
  await expect(page.getByText('Comprador: Aina · 606 130 865')).toBeVisible();
  await expect(page.getByText('«T´estimo molt !»')).toBeVisible();
  await expect(page.getByLabel('Tipo de clase')).toHaveValue('Modelado');
});
