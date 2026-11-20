import { expect, test } from '@playwright/test';

test('Dashboard counts homonyms by ID, does not count unknown payments, and opens the shared attendance flow', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
  await page.route('**/dashboard-integrity-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/student-lifecycle-harness.tsx');
    </script></body></html>` }));
  await page.goto('/dashboard-integrity-test');
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  await expect(page.getByText('Alumnos Hoy', { exact: true }).locator('..')).toContainText('2');
  await expect(page.getByText('Pendientes de pago', { exact: true }).locator('..')).toContainText('1');
  await page.getByRole('button', { name: 'Control de asistencia', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('"sessionId":"homonym-session"');
  await expect(page.getByTestId('saved')).toContainText('"date":"2026-10-16"');
});

test('Dashboard category chips use Spanish labels, not raw codes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
  await page.route('**/dashboard-integrity-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/student-lifecycle-harness.tsx');
    </script></body></html>` }));
  await page.goto('/dashboard-integrity-test');
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  await expect(page.getByText('Grupal', { exact: true })).toBeVisible();
  await expect(page.getByText('Grupo temporal', { exact: true })).toBeVisible();
  await expect(page.getByText('Bonos temporales', { exact: true })).toBeVisible();
  await expect(page.getByText('grupal', { exact: true })).toHaveCount(0);
  await expect(page.getByText('grupo_temporal', { exact: true })).toHaveCount(0);
  // Alert header total equals the sum of the three alert group badges.
  const alertSection = page.locator('section').filter({ hasText: 'Alertas' });
  const headerCount = Number((await alertSection.locator('h4').locator('..').locator('span').first().textContent())?.replace(/[^\d]/g, '') || '0');
  const groupBadges = alertSection.locator('div.mb-2 span.rounded-full');
  const badgeValues = await groupBadges.allTextContents();
  const badgeSum = badgeValues.reduce((sum, text) => sum + Number(text.trim() || 0), 0);
  expect(badgeSum).toBe(headerCount);
});

test('Dashboard bono alerts use gift-card remaining, not a zeroed student column', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
  await page.route('**/dashboard-integrity-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html lang="es"><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/tests/fixtures/student-lifecycle-harness.tsx');
    </script></body></html>` }));
  await page.goto('/dashboard-integrity-test');
  await page.getByRole('button', { name: 'Cargar bono vinculado' }).click();
  await page.getByRole('button', { name: 'Cambiar pantalla de prueba' }).click();
  // Paula has 0 on the student row but 2 remaining on the gift card — must not alert as exhausted.
  await expect(page.getByText('PAULA BONO')).toHaveCount(0);
  await expect(page.getByText(/Bono agotándose \(2 rest\.\)/)).toHaveCount(0);
});
