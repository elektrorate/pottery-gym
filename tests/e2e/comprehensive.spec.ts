import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const supabaseUrl = process.env.TEST_SUPABASE_URL || 'https://ilkrcakrduibgsfqfzti.supabase.co';
const serviceRoleKey = process.env.TEST_SERVICE_ROLE_KEY;
const staffEmail = 'test@barro.test';
const staffPassword = 'Test123!';
const adminEmail = 'erick@kgbycia.com';
const adminPassword = 'admin123';

const serviceHeaders = () => ({
  apikey: serviceRoleKey || '',
  Authorization: `Bearer ${serviceRoleKey || ''}`,
  'Content-Type': 'application/json'
});

const qaName = (suffix: string) => `PW-QA-${Date.now()}-${suffix}`;

async function login(page: Page, email: string, password: string, path: '/dashboard' | '/admin') {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}(?:/)?$`));
}

async function deleteRows(api: APIRequestContext, table: string, query: string) {
  if (!serviceRoleKey) return;
  await api.delete(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: serviceHeaders() });
}

async function findRows(api: APIRequestContext, table: string, query: string) {
  if (!serviceRoleKey) return [];
  const response = await api.get(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: serviceHeaders() });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.beforeAll(() => {
  expect(serviceRoleKey, 'TEST_SERVICE_ROLE_KEY is required for isolated cleanup').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  const studentRows = await findRows(request, 'students', 'select=id&name=like.PW-QA-*');
  const studentIds = studentRows.map((row: { id: string }) => row.id);
  if (studentIds.length) {
    await deleteRows(request, 'session_students', `student_id=in.(${studentIds.join(',')})`);
    await deleteRows(request, 'students', `id=in.(${studentIds.join(',')})`);
  }
  await deleteRows(request, 'inventory_items', 'name=like.PW-QA-*');
  await deleteRows(request, 'pieces', 'description=like.PW-QA-*');
  await deleteRows(request, 'gift_cards', 'code=like.PW-QA-*');
  await deleteRows(request, 'sessions', 'workshop_name=like.PW-QA-*');
});

test.describe('Autenticación y permisos', () => {
  test('rechaza credenciales inválidas y permite login de staff', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(staffEmail);
    await page.getByLabel('Contraseña').fill('PW-QA-invalid');
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page.getByRole('alert')).toContainText('Credenciales incorrectas');

    await login(page, staffEmail, staffPassword, '/dashboard');
    await expect(page.getByText('Estado del taller hoy')).toBeVisible();
  });

  test('staff puede navegar operaciones y no accede a administración', async ({ page }) => {
    await login(page, staffEmail, staffPassword, '/dashboard');
    const routes = [
      ['/calendar', 'Clases'],
      ['/students', 'Alumnos'],
      ['/giftcards', 'Bonos regalo'],
      ['/history', 'Historial'],
      ['/inventory', 'Inventario'],
      ['/teachers', 'Profesores']
    ] as const;

    for (const [route, heading] of routes) {
      await page.goto(route);
      await expect(page.locator('h1, h2, h3').filter({ hasText: heading }).first()).toBeVisible();
    }

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    await page.goto('/team');
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/dashboard\/?$/);
  });

  test('staff puede usar el menú móvil y cambiar el tema', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.getByRole('button', { name: 'Abrir menú' }).click();
    await expect(page.getByRole('button', { name: 'Cerrar menú' })).toBeVisible();
    await page.getByRole('button', { name: 'Clases', exact: true }).last().click();
    await expect(page).toHaveURL(/\/calendar\/?$/);
    const themeToggle = page.getByRole('button', { name: /modo oscuro|modo claro/i }).first();
    await expect(themeToggle).toBeVisible();
    const previousPressed = await themeToggle.getAttribute('aria-pressed');
    await themeToggle.click();
    await expect(themeToggle).toHaveAttribute('aria-pressed', previousPressed === 'true' ? 'false' : 'true');
  });

  test('super admin puede acceder al panel y sus secciones', async ({ page }) => {
    await login(page, adminEmail, adminPassword, '/admin');
    await expect(page.getByText('Panel de control')).toBeVisible();
    for (const [label, heading] of [['Talleres', /^Talleres$/], ['Reportes', /^Reportes$/], ['Equipo', /Gestión del Equipo/]] as const) {
      await page.getByRole('link', { name: label, exact: true }).click();
      await expect(page.getByRole('main').getByRole('heading', { name: heading })).toBeVisible();
    }
  });
});

test.describe('Flujos operativos', () => {
  test('alumnos: crea, valida y elimina un registro de QA', async ({ page, request }) => {
    const name = qaName('ALUMNO');
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.goto('/students');
    await page.getByRole('button', { name: 'Crear nuevo alumno' }).click();
    await page.getByRole('button', { name: /Información personal/ }).click();
    await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('textbox', { name: 'Apellidos', exact: true }).fill('Automatizado');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`${name.toLowerCase()}@barro.test`);
    await page.getByRole('textbox', { name: 'Teléfono', exact: true }).fill('600000001');
    await page.getByRole('spinbutton', { name: 'Cuota', exact: true }).fill('90');
    await page.getByRole('button', { name: /Gold/ }).click();
    await page.getByRole('button', { name: 'Guardar alumno' }).click();
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();

    const rows = await findRows(request, 'students', `select=id,name&name=eq.${encodeURIComponent(name)}`);
    expect(rows).toHaveLength(1);
    await page.getByText(name, { exact: false }).first().click();
    await page.getByRole('button', { name: 'Eliminar alumno' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect.poll(async () => (await findRows(request, 'students', `select=id&name=eq.${encodeURIComponent(name)}`)).length).toBe(0);
  });

  test('calendario: valida sesión, audiencia y modal de creación', async ({ page }) => {
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Nueva clase', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('Tipo de sesión').selectOption('workshop');
    await expect(page.getByLabel('Nombre del workshop')).toBeVisible();
    await page.getByLabel('Tipo de sesión').selectOption('mesa');
    await page.getByRole('button', { name: 'Crear sesión' }).click();
    await expect(page.getByText('Debes asignar un profesor.')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar modal' }).click();
  });

  test('gift cards: abre formulario, valida campos y permite filtrar archivados', async ({ page }) => {
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.goto('/giftcards');
    await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
    await expect(page.getByRole('heading', { name: 'Nuevo bono temporal' })).toBeVisible();
    await page.getByRole('button', { name: 'Crear bono' }).click();
    await expect(page.getByRole('textbox', { name: 'Nombre del comprador *' })).toHaveAttribute('required', '');
    await expect(page.getByRole('textbox', { name: 'Nombre del destinatario *' })).toHaveAttribute('required', '');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('tab', { name: /Archivados/ }).click();
    await expect(page.getByRole('tab', { name: /Archivados/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('inventario: crea, abre detalle, registra formulario y elimina QA', async ({ page, request }) => {
    const name = qaName('INVENTARIO');
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.goto('/inventory');
    await page.getByRole('button', { name: /Nuevo material/ }).click();
    await page.getByPlaceholder('Ej: GL-010').fill(`PW-${Date.now()}`);
    await page.getByPlaceholder('Ej: Esmalte blanco mate').fill(name);
    await page.locator('input[type="number"]').nth(0).fill('10');
    await page.locator('input[type="number"]').nth(1).fill('2');
    await page.getByPlaceholder('kg, l, un').fill('kg');
    await page.getByRole('button', { name: 'Guardar item' }).click();
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    const rows = await findRows(request, 'inventory_items', `select=id,name&name=eq.${encodeURIComponent(name)}`);
    expect(rows).toHaveLength(1);
    await deleteRows(request, 'inventory_items', `name=eq.${encodeURIComponent(name)}`);
  });

  test('piezas: abre formulario, valida propietario y elimina QA', async ({ page }) => {
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.goto('/pieces');
    await page.getByRole('button', { name: /Registrar pieza|Nueva pieza|Añadir pieza/ }).click();
    await expect(page.getByRole('heading', { name: 'REGISTRAR PIEZA' })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar modal' }).click();
  });

  test('accesibilidad básica: foco, escape y estados de carga', async ({ page }) => {
    await login(page, staffEmail, staffPassword, '/dashboard');
    await page.goto('/giftcards');
    await page.getByRole('button', { name: /Nueva tarjeta/ }).focus();
    await expect(page.getByRole('button', { name: /Nueva tarjeta/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Nuevo bono temporal' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Nuevo bono temporal' })).toHaveCount(0);
  });
});
