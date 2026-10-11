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
