import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const supabaseUrl = process.env.TEST_SUPABASE_URL || 'https://ilkrcakrduibgsfqfzti.supabase.co';
const serviceRoleKey = process.env.TEST_SERVICE_ROLE_KEY;
const staffEmail = 'test@barro.test';
const staffPassword = 'Test123!';

const serviceHeaders = () => ({
  apikey: serviceRoleKey || '',
  Authorization: `Bearer ${serviceRoleKey || ''}`,
  'Content-Type': 'application/json'
});

const qaName = (suffix: string) => `PW-QA-${Date.now()}-${suffix}`;

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(staffEmail);
  await page.getByLabel('Contraseña').fill(staffPassword);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/dashboard\/?$/);
}

async function findRows(api: APIRequestContext, table: string, query: string) {
  const response = await api.get(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: serviceHeaders() });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function deleteRows(api: APIRequestContext, table: string, query: string) {
  const response = await api.delete(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: serviceHeaders() });
  expect(response.ok()).toBeTruthy();
}

async function upsertRows(api: APIRequestContext, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const response = await api.post(`${supabaseUrl}/rest/v1/${table}?on_conflict=sede_id%2Cday_of_week%2Cslot_index`, {
    headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates' },
    data: rows
  });
  expect(response.ok()).toBeTruthy();
}

async function deleteByIds(api: APIRequestContext, table: string, column: string, ids: string[]) {
  if (ids.length) await deleteRows(api, table, `${column}=in.(${ids.join(',')})`);
}

test.beforeAll(() => {
  expect(serviceRoleKey, 'TEST_SERVICE_ROLE_KEY is required for isolated operations tests').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  const giftCards = await findRows(request, 'gift_cards', 'select=id&code=like.PW-QA-*');
  await deleteByIds(request, 'gift_cards', 'id', giftCards.map((row: { id: string }) => row.id));

  const sessions = await findRows(request, 'sessions', 'select=id&workshop_name=like.PW-QA-*');
  const sessionIds = sessions.map((row: { id: string }) => row.id);
  await deleteByIds(request, 'session_students', 'session_id', sessionIds);
  await deleteByIds(request, 'sessions', 'id', sessionIds);

  const items = await findRows(request, 'inventory_items', 'select=id&name=like.PW-QA-*');
  const itemIds = items.map((row: { id: string }) => row.id);
  await deleteByIds(request, 'inventory_movements', 'item_id', itemIds);
  await deleteByIds(request, 'inventory_items', 'id', itemIds);

  const students = await findRows(request, 'students', 'select=id&name=like.PW-QA-*');
  const studentIds = students.map((row: { id: string }) => row.id);
  await deleteByIds(request, 'session_students', 'student_id', studentIds);
  await deleteByIds(request, 'students', 'id', studentIds);

  await deleteRows(request, 'pieces', 'description=like.PW-QA-*');
});

test.describe('Alumnos', () => {
  test('valida nombre y persiste la edición de un alumno', async ({ page, request }) => {
    const name = qaName('ALUMNO-EDIT');
    const email = `${name.toLowerCase()}@barro.test`;

    await login(page);
    await page.goto('/students');
    await page.getByRole('button', { name: 'Crear nuevo alumno' }).click();
    await page.getByRole('button', { name: /Información personal/ }).click();
    await page.getByRole('button', { name: 'Guardar alumno' }).click();
    await expect(page.getByRole('alert')).toContainText('El nombre es obligatorio');

    await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('textbox', { name: 'Apellidos', exact: true }).fill('Automatizado');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await page.getByRole('textbox', { name: 'Teléfono', exact: true }).fill('600000002');
    await page.getByRole('button', { name: 'Gold 120€ · 4 bonos', exact: true }).click();
    await page.getByRole('button', { name: 'Guardar alumno' }).click();
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();

    const created = await findRows(request, 'students', `select=id,name,phone&email=eq.${encodeURIComponent(email)}`);
    expect(created).toHaveLength(1);
    await page.getByRole('button').filter({ hasText: name }).first().click();
    await page.getByRole('button', { name: /Información personal/ }).click();
    await page.getByRole('textbox', { name: 'Teléfono', exact: true }).fill('600000003');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'students', `select=phone&email=eq.${encodeURIComponent(email)}`);
      return rows[0]?.phone;
    }).toBe('600000003');
  });
});

test.describe('Calendario', () => {
  test('crea, edita y elimina una sesión de workshop', async ({ page, request }) => {
    const workshopName = qaName('WORKSHOP');

    await login(page);
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
    await page.getByLabel('Tipo de sesión').selectOption('workshop');
    await page.getByLabel('Nombre del workshop').fill(workshopName);
    await page.getByLabel('Hora de inicio').fill('13:00');
    await page.getByLabel('Hora de fin').fill('14:00');
    await page.getByLabel('Cupo máximo').fill('12');
    await page.getByRole('button', { name: 'Crear sesión' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'sessions', `select=id,workshop_name,start_time,end_time,capacity&workshop_name=eq.${encodeURIComponent(workshopName)}`);
      return rows[0]?.capacity;
    }).toBe(12);
    await page.getByText(workshopName, { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Editar sesión' })).toBeVisible();
    await page.getByLabel('Hora de fin').fill('15:00');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'sessions', `select=end_time&workshop_name=eq.${encodeURIComponent(workshopName)}`);
      return rows[0]?.end_time;
    }).toMatch(/T15:00:00/);

    await page.getByText(workshopName, { exact: true }).click();
    await page.getByRole('button', { name: 'Eliminar' }).click();
    await page.getByRole('dialog').filter({ hasText: '¿Eliminar sesión?' }).getByRole('button', { name: 'Eliminar' }).click();
    await expect.poll(async () => (await findRows(request, 'sessions', `select=id&workshop_name=eq.${encodeURIComponent(workshopName)}`)).length).toBe(0);
  });

  test('avisa si se intenta crear una sesión en un día cerrado', async ({ page, request }) => {
    const profileRows = await findRows(request, 'profiles', 'select=id&email=eq.test%40barro.test');
    const userId = profileRows[0]?.id as string | undefined;
    const sedeRows = userId
      ? await findRows(request, 'sede_members', `select=sede_id&user_id=eq.${userId}`)
      : [];
    const sedeId = sedeRows[0]?.sede_id as string | undefined;
    test.skip(!sedeId, 'No hay una sede de prueba disponible');

    const scheduleQuery = `sede_id=eq.${sedeId}`;
    const originalSchedule = await findRows(request, 'workshop_schedules', `select=*&${scheduleQuery}`);
    const closedSchedule = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      sede_id: sedeId,
      day_of_week: dayOfWeek,
      slot_index: 0,
      is_open: false,
      opens_at: null,
      closes_at: null
    }));

    await upsertRows(request, 'workshop_schedules', closedSchedule);
    try {
      await login(page);
      await page.goto('/calendar');
      await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
      await page.getByLabel('Tipo de sesión').selectOption('workshop');
      await page.getByLabel('Nombre del workshop').fill(qaName('CLOSED-DAY'));
      await page.getByRole('button', { name: 'Crear sesión' }).click();
      await expect(page.getByRole('alert')).toContainText('El taller está cerrado.');
      await expect(page.getByRole('heading', { name: 'Nueva sesión' })).toBeVisible();

      const todayDayOfWeek = new Date().getDay();
      const limitedSchedule = closedSchedule.map(day => day.day_of_week === todayDayOfWeek
        ? { ...day, is_open: true, opens_at: '10:00', closes_at: '14:00' }
        : day);
      await upsertRows(request, 'workshop_schedules', [
        ...limitedSchedule,
        { sede_id: sedeId, day_of_week: todayDayOfWeek, slot_index: 1, is_open: true, opens_at: '16:00', closes_at: '18:00' }
      ]);
      await page.getByRole('button', { name: 'Cerrar modal' }).click();
      await page.reload();
      await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
      await page.getByLabel('Tipo de sesión').selectOption('workshop');
      await page.getByLabel('Nombre del workshop').fill(qaName('OUTSIDE-HOURS'));
      await page.getByLabel('Hora de inicio').fill('09:00');
      await page.getByLabel('Hora de fin').fill('16:00');
      await page.getByRole('button', { name: 'Crear sesión' }).click();
      await expect(page.getByRole('alert')).toContainText('Fuera de horario (10:00–14:00, 16:00–18:00).');
    } finally {
      await deleteRows(request, 'workshop_schedules', scheduleQuery);
      await upsertRows(request, 'workshop_schedules', originalSchedule);
    }
  });
});

test.describe('Gift Cards', () => {
  test('crea y edita una Gift Card sin alterar su estado protegido', async ({ page, request }) => {
    const code = qaName('GIFT').toUpperCase();
    const recipient = qaName('RECIPIENT');
    const buyer = qaName('BUYER');

    await login(page);
    await page.goto('/giftcards');
    await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
    await page.getByRole('textbox', { name: 'Nombre del comprador *' }).fill(buyer);
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('+34600000004');
    await page.getByRole('textbox', { name: 'Email *' }).fill(`${buyer.toLowerCase()}@barro.test`);
    await page.getByRole('textbox', { name: 'Nombre del destinatario *' }).fill(recipient);
    await page.getByRole('textbox', { name: 'Código de validación' }).fill(code);
    await page.getByRole('combobox', { name: 'Estado del pago' }).selectOption('paid');
    await page.getByRole('button', { name: 'Crear bono' }).click();

    await expect.poll(async () => findRows(request, 'gift_cards', `select=id,status,payment_status,sessions_used&code=eq.${encodeURIComponent(code)}`)).toHaveLength(1);
    await expect(page.getByRole('button').filter({ hasText: recipient }).first()).toBeVisible();
    await page.getByRole('button').filter({ hasText: recipient }).first().click();
    await expect(page.getByRole('heading', { name: 'Editar bono temporal' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Observaciones internas' }).fill('PW-QA edición validada');
    await page.getByRole('combobox', { name: 'Estado del bono' }).selectOption('consumed');
    await page.getByRole('combobox', { name: 'Estado del pago' }).selectOption('refunded');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'gift_cards', `select=status,payment_status,sessions_used,extra_commentary&code=eq.${encodeURIComponent(code)}`);
      return rows[0];
    }).toEqual({ status: 'active', payment_status: 'paid', sessions_used: 0, extra_commentary: 'PW-QA edición validada' });
  });

  test('consume y revierte una Gift Card al corregir la asistencia', async ({ page, request }) => {
    const code = qaName('ATTENDANCE-GIFT').toUpperCase();
    const recipient = qaName('ATTENDANCE-RECIPIENT');
    const buyer = qaName('ATTENDANCE-BUYER');
    const workshopName = qaName('ATTENDANCE-WORKSHOP');

    await login(page);
    await page.goto('/giftcards');
    await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
    await page.getByRole('textbox', { name: 'Nombre del comprador *' }).fill(buyer);
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('+34600000005');
    await page.getByRole('textbox', { name: 'Email *' }).fill(`${buyer.toLowerCase()}@barro.test`);
    await page.getByRole('textbox', { name: 'Nombre del destinatario *' }).fill(recipient);
    await page.getByRole('textbox', { name: 'Código de validación' }).fill(code);
    await page.getByRole('combobox', { name: 'Estado del pago' }).selectOption('paid');
    await page.getByRole('button', { name: 'Crear bono' }).click();
    await expect.poll(async () => findRows(request, 'gift_cards', `select=id,recipient_student_id,status,sessions_used&code=eq.${encodeURIComponent(code)}`)).toHaveLength(1);
    const giftCardRows = await findRows(request, 'gift_cards', `select=id,recipient_student_id,status,sessions_used&code=eq.${encodeURIComponent(code)}`);
    const giftCardId = giftCardRows[0].id as string;

    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Nueva sesión', exact: true }).click();
    await page.getByLabel('Tipo de sesión').selectOption('workshop');
    await page.getByLabel('Nombre del workshop').fill(workshopName);
    await page.getByRole('button', { name: 'Temporales' }).click();
    await page.getByPlaceholder('Buscar por nombre o grupo').fill(recipient);
    await page.getByRole('button').filter({ hasText: recipient }).last().click();
    await page.getByRole('button', { name: 'Crear sesión' }).click();

    await expect.poll(async () => findRows(request, 'sessions', `select=id&workshop_name=eq.${encodeURIComponent(workshopName)}`)).toHaveLength(1);
    const session = await findRows(request, 'sessions', `select=id&workshop_name=eq.${encodeURIComponent(workshopName)}`);
    const sessionId = session[0].id as string;
    await expect.poll(async () => findRows(request, 'session_students', `select=student_id,gift_card_id&session_id=eq.${sessionId}`)).toHaveLength(1);

    const sessionCard = page.locator('div.group').filter({ hasText: workshopName }).first();
    await expect(sessionCard).toBeVisible();
    await sessionCard.getByRole('button', { name: 'Abrir control de asistencia' }).click();
    await page.getByRole('button', { name: `Marcar asistencia de ${recipient}` }).click();
    await page.getByRole('button', { name: 'Finalizar control' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'gift_cards', `select=status,sessions_used&code=eq.${encodeURIComponent(code)}`);
      return rows[0];
    }).toEqual({ status: 'consumed', sessions_used: 1 });
    await expect.poll(async () => (await findRows(request, 'gift_card_movements', `select=id&gift_card_id=eq.${giftCardId}&movement_type=eq.redeem`)).length).toBe(1);

    await page.reload();
    const completedCard = page.locator('div.group').filter({ hasText: workshopName }).first();
    await completedCard.getByRole('button', { name: 'Abrir control de asistencia' }).click();
    await page.getByRole('button', { name: 'Editar asistencia' }).click();
    await page.getByRole('button', { name: `Marcar falta de ${recipient}` }).click();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'gift_cards', `select=status,sessions_used&code=eq.${encodeURIComponent(code)}`);
      return rows[0];
    }).toEqual({ status: 'active', sessions_used: 0 });
    await expect.poll(async () => (await findRows(request, 'gift_card_movements', `select=id&gift_card_id=eq.${giftCardId}&movement_type=eq.reverse`)).length).toBe(1);
  });

  test('ejecuta los RPC manuales de consumir y anular Gift Cards', async ({ page, request }) => {
    const consumedCode = qaName('MANUAL-CONSUME').toUpperCase();
    const cancelledCode = qaName('MANUAL-CANCEL').toUpperCase();

    await login(page);
    await page.goto('/giftcards');
    await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
    await page.getByRole('textbox', { name: 'Nombre del comprador *' }).fill(qaName('MANUAL-BUYER'));
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('+34600000006');
    await page.getByRole('textbox', { name: 'Email *' }).fill(`${consumedCode.toLowerCase()}@barro.test`);
    await page.getByRole('textbox', { name: 'Nombre del destinatario *' }).fill(qaName('MANUAL-RECIPIENT'));
    await page.getByRole('textbox', { name: 'Código de validación' }).fill(consumedCode);
    await page.getByRole('combobox', { name: 'Estado del pago' }).selectOption('paid');
    await page.getByRole('button', { name: 'Crear bono' }).click();
    await expect.poll(async () => findRows(request, 'gift_cards', `select=id,status&code=eq.${encodeURIComponent(consumedCode)}`)).toHaveLength(1);

    await page.getByRole('button').filter({ hasText: consumedCode }).first().click();
    await page.getByRole('button', { name: 'Bono consumido' }).click();
    await page.getByRole('dialog').filter({ hasText: '¿Marcar bono como consumido?' }).getByRole('button', { name: 'Bono consumido' }).click();
    await expect.poll(async () => {
      const rows = await findRows(request, 'gift_cards', `select=status,consumed_at&code=eq.${encodeURIComponent(consumedCode)}`);
      return rows[0];
    }).toMatchObject({ status: 'consumed' });

    await page.getByRole('tab', { name: /Activos/ }).click();
    await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
    await page.getByRole('textbox', { name: 'Nombre del comprador *' }).fill(qaName('MANUAL-CANCEL-BUYER'));
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('+34600000007');
    await page.getByRole('textbox', { name: 'Email *' }).fill(`${cancelledCode.toLowerCase()}@barro.test`);
    await page.getByRole('textbox', { name: 'Nombre del destinatario *' }).fill(qaName('MANUAL-CANCEL-RECIPIENT'));
    await page.getByRole('textbox', { name: 'Código de validación' }).fill(cancelledCode);
    await page.getByRole('combobox', { name: 'Estado del pago' }).selectOption('paid');
    await page.getByRole('button', { name: 'Crear bono' }).click();
    await expect.poll(async () => findRows(request, 'gift_cards', `select=id,status&code=eq.${encodeURIComponent(cancelledCode)}`)).toHaveLength(1);

    await page.getByRole('button').filter({ hasText: cancelledCode }).first().click();
    await page.getByRole('button', { name: 'Anular / eliminar' }).click();
    await page.getByRole('dialog').filter({ hasText: '¿Anular este bono?' }).getByRole('button', { name: 'Anular bono' }).click();
    await expect.poll(async () => {
      const rows = await findRows(request, 'gift_cards', `select=status&code=eq.${encodeURIComponent(cancelledCode)}`);
      return rows[0]?.status;
    }).toBe('cancelled');
  });
});

test.describe('Inventario', () => {
  test('registra un movimiento y actualiza existencias', async ({ page, request }) => {
    const name = qaName('INVENTARIO-MOV');
    const code = `PW-${Date.now()}`;

    await login(page);
    await page.goto('/inventory');
    await page.getByRole('button', { name: /Nuevo material/ }).click();
    await page.getByPlaceholder('Ej: GL-010').fill(code);
    await page.getByPlaceholder('Ej: Esmalte blanco mate').fill(name);
    await page.locator('input[type="number"]').nth(0).fill('10');
    await page.locator('input[type="number"]').nth(1).fill('2');
    await page.getByPlaceholder('kg, l, un').fill('kg');
    await page.getByRole('button', { name: 'Guardar item' }).click();
    await page.getByRole('button', { name: `Abrir ${name}` }).click();
    await page.getByRole('button', { name: 'Registrar movimiento' }).click();
    await page.locator('select').last().selectOption('out');
    await page.locator('input[type="number"]').last().fill('3');
    await page.getByPlaceholder('Ej: Compra, consumo, ajuste').fill('PW-QA consumo');
    await page.getByRole('button', { name: 'Guardar movimiento' }).click();

    await expect.poll(async () => {
      const rows = await findRows(request, 'inventory_items', `select=current_quantity&name=eq.${encodeURIComponent(name)}`);
      return rows[0]?.current_quantity;
    }).toBe(7);
    const movements = await findRows(request, 'inventory_movements', `select=reason,quantity&type=eq.out&reason=eq.${encodeURIComponent('PW-QA consumo')}`);
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(3);
  });
});

test.describe('Piezas', () => {
  test('crea, edita y elimina una pieza', async ({ page, request }) => {
    const description = qaName('PIEZA');
    const updatedDescription = `${description}-EDITADA`;

    await login(page);
    await page.goto('/pieces');
    await page.getByRole('button', { name: /Nueva pieza/ }).click();
    const modal = page.locator('div.fixed.inset-0').filter({ hasText: 'REGISTRAR PIEZA' }).first();
    await modal.locator('select').first().selectOption({ index: 1 });
    await modal.getByPlaceholder('Ej: Jarrón con textura').fill(description);
    await modal.getByRole('button', { name: 'GUARDAR CAMBIOS' }).click();

    await expect.poll(async () => findRows(request, 'pieces', `select=id,description&description=eq.${encodeURIComponent(description)}`)).toHaveLength(1);
    const pieceRow = page.locator('div.relative.grid').filter({ hasText: description }).first();
    await pieceRow.getByRole('button', { name: /Editar pieza de/ }).click();
    const editModal = page.locator('div.fixed.inset-0').filter({ hasText: 'EDITAR PIEZA' }).first();
    await editModal.getByPlaceholder('Ej: Jarrón con textura').fill(updatedDescription);
    await editModal.getByRole('button', { name: 'GUARDAR CAMBIOS' }).click();
    await expect.poll(async () => findRows(request, 'pieces', `select=id&description=eq.${encodeURIComponent(updatedDescription)}`)).toHaveLength(1);

    const updatedRow = page.locator('div.relative.grid').filter({ hasText: updatedDescription }).first();
    await updatedRow.getByRole('button', { name: /Editar pieza de/ }).click();
    await page.getByRole('button', { name: 'Eliminar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect.poll(async () => (await findRows(request, 'pieces', `select=id&description=eq.${encodeURIComponent(updatedDescription)}`)).length).toBe(0);
  });
});
