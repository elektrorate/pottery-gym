import { test, expect } from '@playwright/test';

test('teachers see scheduled classes, including mixed blocks, and open that calendar', async ({ page }) => {
  await page.goto('/tests/fixtures/teacher-calendar.html');
  await expect(page.getByText('2 programadas')).toBeVisible();
  await expect(page.getByText('1 programada')).toBeVisible();
  await expect(page.getByText('0 concluidas')).toBeVisible();

  await page.getByRole('button', { name: 'Historial' }).nth(1).click();
  const mixedClass = page.getByRole('link', { name: /24 de noviembre/ });
  await expect(mixedClass).toBeVisible();
  await expect(mixedClass).toContainText('Sesión mixta · Torno');

  await mixedClass.click();
  await expect(page.getByRole('status')).toContainText('Luis Torno');
  await expect(page.locator('[data-session-id="mixta-proxima"]')).toBeVisible();
  await expect(page.locator('[data-session-id="torno-ajena"]')).toHaveCount(0);
  await expect(page.getByText('No se encontró esta sesión')).toHaveCount(0);
});
