import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';
import { apiUrl, frontendUrl, projectId, testPassword } from '../../scripts/local-staging-runtime.mjs';
import { DOMAIN_READ_OPERATIONS, parseDomainReadResponse } from '../../supabase/functions/_shared/domain-read-contract';

const ownSede = '30000000-0000-0000-0000-000000000001';
const foreignSede = '30000000-0000-0000-0000-000000000002';
const seedMember = '10000000-0000-0000-0000-000000000001';
const seedTemporary = '10000000-0000-0000-0000-000000000002';
const foreignMember = '10000000-0000-0000-0000-000000000003';
const teacher = '70000000-0000-0000-0000-000000000001';
const anonKey = process.env.TEST_LOCAL_SUPABASE_ANON_KEY || '';
type Actor = { token: string; id: string };
type Row = Record<string, any>;
type Fixture = {
  member: string; temporary: string; period: string; card: string; memberCard: string;
  session: string; reservationKey: string; date: string; buyer: string; code: string;
  reservation: Row;
};
let owner: Actor;
let other: Actor;
let reader: Actor;
let seedBefore: Row;

function jwtRole(token: string): string | undefined {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role; } catch { return undefined; }
}

// No Supabase SDK, service key, default URL, redirects, DELETE, or admin Auth.
// Error messages expose only fixed paths/status/codes, never response bodies.
async function http(actor: Actor | null, route: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  if (!/^\/(?:rest\/v1\/|auth\/v1\/(?:token\?|user$)|functions\/v1\/domain-read$)/.test(route)
    || route.includes('://') || !['GET', 'POST', 'PATCH'].includes(method)) throw new Error('Nonlocal or unsupported API operation rejected.');
  if (jwtRole(anonKey) !== 'anon' || (actor && jwtRole(actor.token) !== 'authenticated')) {
    throw new Error('Only anon public API keys and password-login authenticated JWTs are allowed.');
  }
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { ...extraHeaders, apikey: anonKey, Authorization: `Bearer ${actor?.token || anonKey}`,
        'Content-Type': 'application/json', Prefer: 'return=representation' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch { throw new Error(`Local API transport failed: ${method} ${route.split('?')[0]}`); }
  let data: any;
  try { const text = await response.text(); data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Local API returned non-JSON: HTTP ${response.status}`); }
  return { status: response.status, data, headers: response.headers };
}

async function ok(actor: Actor | null, route: string, method = 'GET', body?: unknown): Promise<any> {
  const result = await http(actor, route, method, body);
  if (result.status < 200 || result.status >= 300) {
    const code = /^[A-Z0-9]{5,8}$/.test(result.data?.code || '') ? result.data.code : 'unclassified';
    throw new Error(`Local API rejected ${method} ${route.split('?')[0]}: HTTP ${result.status}, code ${code}`);
  }
  return result.data;
}

const rows = (actor: Actor, table: string, filter: string, select = '*', order = ''): Promise<Row[]> =>
  ok(actor, `/rest/v1/${table}?select=${select}&${filter}${order ? `&order=${order}` : ''}`);
const rpc = (actor: Actor, name: string, args: Row) => ok(actor, `/rest/v1/rpc/${name}`, 'POST', args);
const ids = (values: string[]) => `in.(${values.join(',')})`;

async function loginApi(email: string): Promise<Actor> {
  const data = await ok(null, '/auth/v1/token?grant_type=password', 'POST', { email, password: testPassword });
  if (jwtRole(data.access_token) !== 'authenticated' || !data.user?.id || data.user.email !== email) {
    throw new Error('Local password login did not return the expected authenticated identity.');
  }
  const actor = { token: data.access_token, id: data.user.id };
  const profiles = await rows(actor, 'profiles', `id=eq.${actor.id}`, 'id,role');
  expect(profiles).toEqual([{ id: actor.id, role: 'tallerista' }]);
  return actor;
}

const test = base.extend<{ isolation: void }>({
  isolation: [async ({ context }, use) => {
    const rejected: string[] = [];
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if ([frontendUrl, apiUrl].includes(url.origin)) {
        if (url.origin === apiUrl) {
          const headers = request.headers();
          const token = headers.authorization?.replace(/^Bearer /i, '');
          if ((headers.apikey && headers.apikey !== anonKey)
            || (token && !['anon', 'authenticated'].includes(jwtRole(token) || ''))) {
            rejected.push('Unexpected browser API credential role');
            return route.abort('blockedbyclient');
          }
        }
        return route.continue();
      }
      const staticGet = request.method() === 'GET' && url.protocol === 'https:' && (
        (url.hostname === 'cdn.tailwindcss.com' && request.resourceType() === 'script' && /^\/(?:\d+\.\d+\.\d+)?$/.test(url.pathname))
        || (url.hostname === 'fonts.googleapis.com' && request.resourceType() === 'stylesheet' && url.pathname === '/css2')
        || (url.hostname === 'fonts.gstatic.com' && request.resourceType() === 'font' && url.pathname.startsWith('/s/'))
      );
      if (staticGet) return route.continue();
      // Deliberately omit query strings, headers and bodies from diagnostics.
      rejected.push(`${request.method()} ${request.resourceType()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      const origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
      if ([frontendUrl, apiUrl].includes(origin)) socket.connectToServer();
      else { rejected.push(`websocket ${origin}${url.pathname}`); socket.close(); }
    });
    try { await use(); } finally {
      expect(rejected, 'Unexpected remote traffic or privileged browser credentials').toEqual([]);
      expect(context.serviceWorkers()).toHaveLength(0);
    }
  }, { auto: true }]
});

test.describe.configure({ mode: 'default' });
test.use({ baseURL: frontendUrl, serviceWorkers: 'block', timezoneId: 'Europe/Madrid', trace: 'off', screenshot: 'off', video: 'off' });

async function seedSnapshot() {
  const seedStudents = [seedMember, seedTemporary, '10000000-0000-0000-0000-000000000004'];
  const seedCards = ['40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002'];
  const seedSessions = [1, 2, 3].map(n => `20000000-0000-0000-0000-00000000000${n}`);
  const requests: Record<string, Promise<Row[]>> = {
    students: rows(owner, 'students', `id=${ids(seedStudents)}`, '*', 'id'),
    periods: rows(owner, 'student_membership_periods', `student_id=${ids(seedStudents)}`, '*', 'id'),
    cards: rows(owner, 'gift_cards', `id=${ids(seedCards)}`, '*', 'id'),
    sessions: rows(owner, 'sessions', `id=${ids(seedSessions)}`, '*', 'id'),
    roster: rows(owner, 'session_students', `session_id=${ids(seedSessions)}`, '*', 'id'),
    receipts: rows(owner, 'session_operation_receipts', `session_id=${ids(seedSessions)}`, '*', 'session_id,request_key'),
    credits: rows(owner, 'session_credit_movements', `session_id=${ids(seedSessions)}`, '*', 'id'),
    gifts: rows(owner, 'gift_card_movements', `gift_card_id=${ids(seedCards)}`, '*', 'id'),
    adjustments: rows(owner, 'student_membership_class_adjustments', `student_id=${ids(seedStudents)}`, '*', 'id'),
    schedule: rows(owner, 'workshop_schedules', `sede_id=eq.${ownSede}`, '*', 'id')
  };
  return Object.fromEntries(await Promise.all(Object.entries(requests).map(async ([key, value]) => [key, await value])));
}

test.beforeAll(async () => {
  if (process.env.BASE_URL !== frontendUrl || jwtRole(anonKey) !== 'anon'
    || Object.keys(process.env).some(key => /(?:SERVICE_ROLE|SUPABASE_ACCESS_TOKEN)/i.test(key))) {
    throw new Error('Run only with node scripts/local-staging-test.mjs and its sanitized local environment.');
  }
  const response = await fetch(`${frontendUrl}/__local-staging`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const identity = await response.json();
  expect(response.status).toBe(200);
  expect({ projectId: identity.projectId, apiUrl: identity.apiUrl, frontendUrl: identity.frontendUrl })
    .toEqual({ projectId, apiUrl, frontendUrl });
  [owner, other, reader] = await Promise.all(['staff@pottery.local', 'other@pottery.local', 'reader@pottery.local'].map(loginApi));
  expect(new Set([owner.id, other.id, reader.id]).size).toBe(3);
  expect(await rows(owner, 'sedes', `id=eq.${ownSede}`, 'id,owner_id,is_active'))
    .toEqual([{ id: ownSede, owner_id: owner.id, is_active: true }]);
  expect(await rows(other, 'sedes', `id=eq.${foreignSede}`, 'id,owner_id,is_active'))
    .toEqual([{ id: foreignSede, owner_id: other.id, is_active: true }]);
  const schedule = await rows(owner, 'workshop_schedules', `sede_id=eq.${ownSede}`, 'day_of_week,is_open,opens_at,closes_at,slot_index', 'day_of_week');
  expect(schedule).toEqual(Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, is_open: true,
    opens_at: '09:00:00', closes_at: '20:00:00', slot_index: 0 })));
  seedBefore = await seedSnapshot();
});

test.afterAll(async () => {
  if (seedBefore) expect(await seedSnapshot(), 'Seeded demonstration identities and history must remain unchanged').toEqual(seedBefore);
});

async function fixture(tag: string, reserve = true): Promise<Fixture> {
  const f = { member: randomUUID(), temporary: randomUUID(), card: randomUUID(), memberCard: randomUUID(),
    session: randomUUID(), reservationKey: randomUUID(), date: '', period: '', buyer: '', code: '', reservation: {} } as Fixture;
  f.date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  f.buyer = `Local E2E ${tag} ${f.session}`;
  f.code = `E2E-${f.card}`.toUpperCase();
  const members = await ok(owner, '/rest/v1/students', 'POST', {
    id: f.member, sede_id: ownSede, full_name: 'Alex Perez', name: 'Alex', surname: 'Perez',
    email: `e2e-${f.member}@pottery.local`, student_category: 'membresia', membership_tier: 'gold', class_type: 'Modelado', status: 'active'
  });
  const temporaries = await ok(owner, '/rest/v1/students', 'POST', {
    id: f.temporary, sede_id: ownSede, full_name: 'Alex Perez', name: 'Alex', surname: 'Perez',
    email: `e2e-${f.temporary}@pottery.local`, student_category: 'temporal', class_type: 'Modelado', status: 'new',
    bonos_asignados: 1, classes_remaining: 1, payment_status: 'paid'
  });
  expect(members).toHaveLength(1);
  expect(temporaries).toHaveLength(1);
  expect(temporaries[0]).toMatchObject({ id: f.temporary, student_category: 'temporal', classes_remaining: 1,
    bonos_asignados: 1, membership_tier: null, current_membership_period_id: null });
  const member = members[0];
  f.period = member.current_membership_period_id;
  expect(member).toMatchObject({ student_category: 'membresia', membership_tier: 'gold', bonos_asignados: 4,
    classes_remaining: 4, payment_status: 'pending' });
  expect(f.period).toMatch(/^[a-f0-9-]{36}$/);
  expect(await rows(owner, 'student_membership_periods', `id=eq.${f.period}`)).toEqual([
    expect.objectContaining({ student_id: f.member, sede_id: ownSede, allocated_classes: 4, payment_status: 'pending', confirmed_at: null })
  ]);
  const paid = await rpc(owner, 'confirm_student_membership_payment', { period_id: f.period });
  expect(paid).toMatchObject({ id: f.period, student_id: f.member, payment_status: 'paid', confirmed_by: owner.id });
  expect(paid.confirmed_at).toBeTruthy();
  expect(paid.starts_on <= f.date && paid.ends_on >= f.date).toBe(true);
  expect(await rows(owner, 'student_membership_periods', `student_id=eq.${f.temporary}`)).toEqual([]);
  const cards = await ok(owner, '/rest/v1/gift_cards', 'POST', [
    { id: f.card, recipient_student_id: f.temporary, code: f.code },
    { id: f.memberCard, recipient_student_id: f.member, code: `E2E-${f.memberCard}`.toUpperCase() }
  ].map(card => ({ ...card, sede_id: ownSede, buyer: f.buyer, buyer_phone: '+34600000000', buyer_email: 'e2e@pottery.local',
    recipient: 'Alex Perez', num_classes: 2, type: 'modelado', sessions_used: 0, payment_status: 'paid',
    status: 'active', validity_months: 3, activated_at: f.date })));
  expect(cards).toHaveLength(2);
  for (const card of cards) expect(card).toMatchObject({ sessions_used: 0, payment_status: 'paid', status: 'active', consumed_at: null });
  f.reservation = { p_session_id: f.session, p_request_key: f.reservationKey, p_expected_revision: 0, p_sede_id: ownSede,
    p_metadata: { date: f.date, start_time: `${f.date}T16:00:00Z`, end_time: `${f.date}T18:00:00Z`,
      class_type: 'mesa', capacity: 2, teacher_id: teacher, session_audience: 'ambos' },
    p_student_ids: [f.member, f.temporary].sort(), p_gift_card_ids: { [f.temporary]: f.card } };
  if (reserve) {
    const receipt = await rpc(owner, 'save_session_reservation', f.reservation);
    expect(receipt).toMatchObject({ session_id: f.session, request_key: f.reservationKey, revision: 1, replayed: false,
      student_ids: f.reservation.p_student_ids });
    const initial = await snapshot(f);
    assertState(f, initial, 1, 'pending', 4, 0, 0, 0, 0, 1);
  }
  return f;
}

async function snapshot(f: Fixture): Promise<Row> {
  const queries: Record<string, Promise<Row[]>> = {
    students: rows(owner, 'students', `id=${ids([f.member, f.temporary])}`, '*', 'id'),
    periods: rows(owner, 'student_membership_periods', `student_id=eq.${f.member}`, '*', 'id'),
    cards: rows(owner, 'gift_cards', `id=${ids([f.card, f.memberCard])}`, '*', 'id'),
    sessions: rows(owner, 'sessions', `id=eq.${f.session}`),
    roster: rows(owner, 'session_students', `session_id=eq.${f.session}`, '*', 'student_id'),
    receipts: rows(owner, 'session_operation_receipts', `session_id=eq.${f.session}`, '*', 'created_at,request_key'),
    credits: rows(owner, 'session_credit_movements', `session_id=eq.${f.session}`, '*', 'revision,student_id'),
    gifts: rows(owner, 'gift_card_movements', `gift_card_id=${ids([f.card, f.memberCard])}`, '*', 'created_at,id'),
    adjustments: rows(owner, 'student_membership_class_adjustments', `student_id=eq.${f.member}`, '*', 'adjusted_at,id')
  };
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([key, value]) => [key, await value])));
}

function assertState(f: Fixture, s: Row, revision: number, attendance: string, balance: number, used: number,
  creditCount: number, giftCount: number, adjustmentCount: number, receiptCount: number) {
  expect(s.students).toHaveLength(2);
  expect(s.students.find((row: Row) => row.id === f.member)).toMatchObject({ current_membership_period_id: f.period,
    student_category: 'membresia', membership_tier: 'gold', payment_status: 'paid', classes_remaining: balance, bonos_asignados: 4 });
  expect(s.students.find((row: Row) => row.id === f.temporary)).toMatchObject({ student_category: 'temporal',
    current_membership_period_id: null, membership_tier: null, classes_remaining: 1, bonos_asignados: 1 });
  expect(s.periods).toHaveLength(1);
  expect(s.periods[0]).toMatchObject({ id: f.period, student_id: f.member, sede_id: ownSede, payment_status: 'paid',
    confirmed_by: owner.id, outgoing_snapshot: null });
  expect(s.cards).toHaveLength(2);
  expect(s.cards.find((row: Row) => row.id === f.card)).toMatchObject({ recipient_student_id: f.temporary,
    sessions_used: used, num_classes: 2, status: 'active', consumed_at: null });
  expect(s.cards.find((row: Row) => row.id === f.memberCard)).toMatchObject({ recipient_student_id: f.member, sessions_used: 0, status: 'active' });
  expect(s.sessions).toHaveLength(1);
  expect(s.sessions[0]).toMatchObject({ id: f.session, sede_id: ownSede, revision, class_type: 'mesa', date: f.date, teacher_id: teacher });
  expect(s.roster).toHaveLength(2);
  expect(s.roster.map((row: Row) => row.student_id)).toEqual([f.member, f.temporary].sort());
  for (const row of s.roster) {
    expect(row).toMatchObject({ session_id: f.session, sede_id: ownSede, attendance,
      gift_card_id: row.student_id === f.temporary ? f.card : null,
      membership_period_id: row.student_id === f.member && creditCount ? f.period : null });
  }
  expect(s.receipts).toHaveLength(receiptCount);
  expect(s.receipts.filter((row: Row) => row.operation === 'reservation')).toHaveLength(1);
  expect(new Set(s.receipts.map((row: Row) => row.request_key)).size).toBe(receiptCount);
  for (const receipt of s.receipts) expect(receipt).toMatchObject({ session_id: f.session, sede_id: ownSede, created_by: owner.id });
  expect(s.credits).toHaveLength(creditCount);
  for (const credit of s.credits) {
    expect(credit).toMatchObject({ session_id: f.session, sede_id: ownSede, created_by: owner.id,
      period_id: credit.student_id === f.member ? f.period : null,
      gift_card_id: credit.student_id === f.temporary ? f.card : null });
    expect([f.member, f.temporary]).toContain(credit.student_id);
    if (credit.delta === 1) expect(s.credits).toContainEqual(expect.objectContaining({ id: credit.reverses_id,
      student_id: credit.student_id, period_id: credit.period_id, gift_card_id: credit.gift_card_id, delta: -1 }));
    else expect(credit.reverses_id).toBeNull();
  }
  expect(s.credits.filter((row: Row) => row.student_id === f.member).reduce((sum: number, row: Row) => sum + row.delta, 0)).toBe(balance - 4);
  expect(s.credits.filter((row: Row) => row.student_id === f.temporary).reduce((sum: number, row: Row) => sum + row.delta, 0)).toBe(used === 0 ? 0 : -used);
  expect(s.gifts).toHaveLength(giftCount);
  for (const gift of s.gifts) expect(gift).toMatchObject({ session_id: f.session, student_id: f.temporary, gift_card_id: f.card, sede_id: ownSede });
  expect(s.gifts.reduce((sum: number, row: Row) => sum + row.sessions_delta, 0)).toBe(used);
  expect(s.adjustments).toHaveLength(adjustmentCount);
  for (const adjustment of s.adjustments) expect(adjustment).toMatchObject({ student_id: f.member, period_id: f.period, sede_id: ownSede, adjusted_by: owner.id });
}

async function loginBrowser(page: Page, email = 'staff@pottery.local') {
  await page.goto('/login');
  await page.getByLabel('Correo electr\u00f3nico', { exact: true }).fill(email);
  await page.getByLabel('Contrase\u00f1a', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Iniciar sesi\u00f3n', exact: true }).click();
  if (email !== 'reader@pottery.local') await expect(page).toHaveURL(`${frontendUrl}/dashboard`);
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Control de asistencia', exact: true });
const attendanceRow = (page: Page, id: string) => dialog(page).locator(`[data-student-id="${id}"]`);
const mark = (page: Page, id: string, present: boolean) => attendanceRow(page, id)
  .getByRole('button', { name: present ? /^Marcar asistencia de / : /^Marcar falta de / }).click();
async function openAttendance(page: Page, f: Fixture) {
  await page.goto(`/calendar?date=${f.date}&sessionId=${f.session}&attendance=1`);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-student-id]')).toHaveCount(2);
  for (const id of [f.member, f.temporary]) await expect(attendanceRow(page, id)).toBeVisible();
}
const cardForm = (page: Page) => page.locator('form').filter({ has: page.getByRole('heading', { name: /^(Nuevo|Editar) bono temporal$/ }) });

test('1: real UI finalization, absent correction and present restoration preserve atomic funding and active gift history', async ({ page }) => {
  const f = await fixture('correction');
  await loginBrowser(page);
  await openAttendance(page, f);
  await mark(page, f.member, true);
  await expect(attendanceRow(page, f.temporary)).toHaveAttribute('data-attendance-status', 'pending');
  await mark(page, f.temporary, true);
  await dialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const finalized = await snapshot(f);
  assertState(f, finalized, 2, 'present', 3, 1, 2, 1, 1, 2);
  const completed = finalized.sessions[0].completed_at;
  expect(completed).toBeTruthy();
  expect(finalized.credits.map((row: Row) => row.delta)).toEqual([-1, -1]);

  await openAttendance(page, f);
  await dialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  await mark(page, f.member, false);
  await mark(page, f.temporary, false);
  await dialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const corrected = await snapshot(f);
  assertState(f, corrected, 3, 'absent', 4, 0, 4, 2, 2, 3);
  expect(corrected.sessions[0].completed_at).toBe(completed);
  expect(corrected.credits.filter((row: Row) => row.revision === 3).map((row: Row) => row.delta)).toEqual([1, 1]);
  for (const credit of finalized.credits) expect(corrected.credits).toContainEqual(credit);
  for (const receipt of finalized.receipts) expect(corrected.receipts).toContainEqual(receipt);

  await openAttendance(page, f);
  await dialog(page).getByRole('button', { name: 'Editar asistencia', exact: true }).click();
  await mark(page, f.member, true);
  await mark(page, f.temporary, true);
  await dialog(page).getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const restored = await snapshot(f);
  assertState(f, restored, 4, 'present', 3, 1, 6, 3, 3, 4);
  expect(restored.sessions[0].completed_at).toBe(completed);
  expect(restored.credits.filter((row: Row) => row.revision === 4).map((row: Row) => row.delta)).toEqual([-1, -1]);
  expect(restored.receipts.filter((row: Row) => row.operation === 'attendance').map((row: Row) => row.intent.expected_revision)).toEqual([1, 2, 3]);
  expect(restored.gifts.filter((row: Row) => row.movement_type === 'redeem')).toHaveLength(2);
  expect(restored.gifts.filter((row: Row) => row.movement_type === 'reverse')).toHaveLength(1);
  for (const credit of corrected.credits) expect(restored.credits).toContainEqual(credit);
  for (const gift of corrected.gifts) expect(restored.gifts).toContainEqual(gift);
  for (const adjustment of corrected.adjustments) expect(restored.adjustments).toContainEqual(adjustment);

  await page.goto('/giftcards');
  await page.getByRole('textbox', { name: 'Buscar tarjeta por nombre del comprador', exact: true }).fill(f.buyer);
  await expect(page.getByRole('tab', { name: /^Activos / })).toHaveAttribute('aria-selected', 'true');
  const card = page.getByRole('button').filter({ has: page.getByText(f.code, { exact: true }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Activo');
  await expect(card).toContainText('1/2 sesiones');
  await card.click();
  await expect(cardForm(page).getByLabel('Estado del bono', { exact: true })).toHaveValue('active');
  await expect(cardForm(page).getByLabel('Sesiones utilizadas', { exact: true })).toHaveValue('1');
  await expect(cardForm(page).getByText('Asistencia validada', { exact: true })).toHaveCount(2);
  await expect(cardForm(page).getByText('Asistencia corregida', { exact: true })).toHaveCount(1);
});

test('2: a lost real committed response retries the identical key and body without another debit or revision', async ({ page, context }) => {
  const f = await fixture('lost-response');
  await loginBrowser(page);
  await openAttendance(page, f);
  const bodies: string[] = [];
  let committed: Row | undefined;
  let deliveryLost = false;
  await context.route(`${apiUrl}/rest/v1/rpc/save_session_attendance`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postData() || '';
    if (JSON.parse(body).p_session_id !== f.session) return route.fallback();
    bodies.push(body);
    if (deliveryLost) return route.fallback();
    deliveryLost = true;
    // The only fault injection forwards the real write, waits for its receipt,
    // then drops delivery. No domain response is mocked or fabricated.
    try {
      const headers = route.request().headers();
      if (headers.apikey !== anonKey || jwtRole(headers.authorization?.replace(/^Bearer /i, '') || '') !== 'authenticated') {
        throw new Error('Lost-response forwarding requires the real browser authenticated JWT and public anon key.');
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
      if (response.status() === 200) committed = await response.json();
      await response.dispose();
    } catch { /* The assertions below require proof of an actual commit. */ }
    await route.abort('failed');
  });
  await mark(page, f.member, true);
  await mark(page, f.temporary, true);
  await dialog(page).getByRole('button', { name: 'Finalizar control', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Resultado sin confirmar');
  expect(bodies).toHaveLength(1);
  const intent = JSON.parse(bodies[0]);
  expect(intent).toMatchObject({ p_session_id: f.session, p_expected_revision: 1, p_finalize: true,
    p_attendance: [f.member, f.temporary].sort().map(student_id => ({ student_id, status: 'present' })) });
  expect(committed).toMatchObject({ session_id: f.session, request_key: intent.p_request_key, revision: 2, replayed: false });
  const beforeRetry = await snapshot(f);
  assertState(f, beforeRetry, 2, 'present', 3, 1, 2, 1, 1, 2);
  await expect(dialog(page).getByRole('button', { name: 'Cerrar modal', exact: true })).toBeDisabled();
  await expect(attendanceRow(page, f.member).getByRole('button', { name: /^Marcar falta de / })).toBeDisabled();
  await expect(page.getByLabel('Reemplazo', { exact: true })).toBeDisabled();
  const storageKey = `atomic-session-intent:${ownSede}:${f.session}`;
  const retained = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), storageKey);
  expect(retained.args).toEqual(intent);
  const replayResponse = page.waitForResponse(response => response.url() === `${apiUrl}/rest/v1/rpc/save_session_attendance`
    && response.request().method() === 'POST' && response.request().postDataJSON().p_session_id === f.session);
  await dialog(page).getByRole('button', { name: 'Reintentar guardado', exact: true }).click();
  const replay = await replayResponse;
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({ session_id: f.session, request_key: intent.p_request_key, revision: 2, replayed: true });
  await expect(dialog(page)).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(await snapshot(f)).toEqual(beforeRetry);
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
  await openAttendance(page, f);
  for (const id of [f.member, f.temporary]) await expect(attendanceRow(page, id)).toHaveAttribute('data-attendance-status', 'present');
});

test('3: real recipient UI distinguishes fresh homonyms by ID, creates no people and preserves both categories', async ({ page }) => {
  const f = await fixture('recipients', false);
  const exactPeople = await rows(owner, 'students', `id=${ids([f.member, f.temporary])}`, '*', 'id');
  const homonyms = await rows(owner, 'students', `sede_id=eq.${ownSede}&name=eq.Alex&surname=eq.Perez`, 'id,student_category', 'id');
  await loginBrowser(page);
  await page.goto('/giftcards');
  for (const target of [f.member, f.temporary]) {
    await page.getByRole('button', { name: /Nueva tarjeta/ }).click();
    const form = cardForm(page);
    await form.getByLabel('Buscar alumno destinatario', { exact: true }).fill('Alex Perez');
    const recipient = form.getByLabel('Alumno destinatario', { exact: true });
    await expect(recipient).toHaveValue('');
    for (const id of [f.member, f.temporary]) {
      await expect(recipient.locator(`option[value="${id}"]`)).toContainText('Alex Perez');
      await expect(recipient.locator(`option[value="${id}"]`)).toContainText(id);
    }
    await form.getByLabel('Nombre del destinatario', { exact: true }).fill('Alex Perez');
    await expect(form.getByRole('button', { name: 'Crear bono', exact: true })).toBeDisabled();
    await expect(form.getByRole('status')).toContainText('No se crean alumnos');
    await recipient.selectOption(target);
    await expect(recipient).toHaveValue(target);
    await expect(form.getByRole('status')).toContainText(target);
    const code = `UI-${randomUUID()}`.toUpperCase();
    await form.getByLabel('Nombre del comprador', { exact: true }).fill(f.buyer);
    await form.getByLabel('Tel\u00e9fono', { exact: true }).fill('+34600000000');
    await form.getByLabel('Email', { exact: true }).fill('e2e@pottery.local');
    await form.getByLabel('C\u00f3digo de validaci\u00f3n', { exact: true }).fill(code);
    await form.getByLabel('N\u00famero de sesiones', { exact: true }).selectOption('2');
    await form.getByLabel('Estado del pago', { exact: true }).selectOption('paid');
    await form.getByRole('button', { name: 'Crear bono', exact: true }).click();
    await expect(form).toHaveCount(0);
    const cards = await rows(owner, 'gift_cards', `sede_id=eq.${ownSede}&code=eq.${code}`);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ recipient_student_id: target, recipient: 'Alex Perez', num_classes: 2,
      type: 'modelado', payment_status: 'paid', status: 'active', sessions_used: 0 });
    expect(await rows(owner, 'gift_cards', `id=eq.${cards[0].id}`)).toEqual(cards);
    expect(await rows(owner, 'students', `id=${ids([f.member, f.temporary])}`, '*', 'id')).toEqual(exactPeople);
    expect(await rows(owner, 'students', `sede_id=eq.${ownSede}&name=eq.Alex&surname=eq.Perez`, 'id,student_category', 'id')).toEqual(homonyms);
    await page.getByRole('textbox', { name: 'Buscar tarjeta por nombre del comprador', exact: true }).fill(f.buyer);
    await page.getByRole('button').filter({ has: page.getByText(code, { exact: true }) }).click();
    await expect(cardForm(page).getByLabel('Alumno destinatario', { exact: true })).toHaveValue(target);
    await cardForm(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  }
});

test('4: foreign RLS and revoked writes preserve history; reader RPC and actual Edge expose only granted minimized data', async ({ page }) => {
  const f = await fixture('authorization');
  await rpc(owner, 'save_session_attendance', { p_session_id: f.session, p_request_key: randomUUID(), p_expected_revision: 1,
    p_attendance: [f.member, f.temporary].sort().map(student_id => ({ student_id, status: 'present' })),
    p_finalize: true, p_teacher_substitute_id: null });
  const baseline = await snapshot(f);
  assertState(f, baseline, 2, 'present', 3, 1, 2, 1, 1, 2);
  const tables = ['sede_members', 'students', 'students_with_lifecycle', 'students_effective_membership', 'student_membership_periods',
    'student_membership_class_adjustments', 'teachers', 'sessions', 'session_students', 'session_operation_receipts',
    'session_credit_movements', 'gift_cards', 'gift_card_movements', 'pieces', 'payments',
    'inventory_items', 'inventory_movements', 'workshop_schedules', 'workshop_capacity_defaults', 'workshop_schedule_exceptions'];
  for (const table of tables) {
    expect(await rows(other, table, `sede_id=eq.${ownSede}`), `Foreign JWT must not read ${table} in the owned sede`).toEqual([]);
    expect(await rows(reader, table, 'limit=1'), `Reader must have no broad ${table} access`).toEqual([]);
  }
  expect(await rows(other, 'sedes', `id=eq.${ownSede}`)).toEqual([]);
  expect(await rows(reader, 'sedes', 'limit=1')).toEqual([]);
  for (const actor of [other, reader]) {
    expect(await rows(actor, 'packages', `student_id=${ids([f.member, f.temporary, seedMember, seedTemporary])}`)).toEqual([]);
    expect(await rows(actor, 'profiles', `id=eq.${owner.id}`)).toEqual([]);
  }
  expect(await rows(reader, 'packages', 'limit=1')).toEqual([]);
  const attendance = { p_session_id: f.session, p_request_key: randomUUID(), p_expected_revision: 2,
    p_attendance: [f.member, f.temporary].sort().map(student_id => ({ student_id, status: 'absent' })),
    p_finalize: true, p_teacher_substitute_id: null };
  for (const actor of [other, reader]) {
    for (const [name, args] of [
      ['save_session_attendance', attendance],
      ['save_session_reservation', { ...f.reservation, p_expected_revision: 2, p_request_key: randomUUID() }],
      ['confirm_student_membership_payment', { period_id: f.period }]
    ] as const) {
      const denied = await http(actor, `/rest/v1/rpc/${name}`, 'POST', args);
      expect(denied.status).toBe(403);
      expect(denied.data.code).toBe('42501');
    }
  }
  // Owners are not DB admins: atomic projections/history and all eight legacy
  // standalone debit/refund endpoints remain unavailable to this real JWT.
  for (const external of [false, true]) for (const once of [false, true]) for (const action of ['redeem', 'reverse']) {
    const name = `${external ? 'external_' : ''}${action}_gift_card_session${once ? '_once' : ''}`;
    const args = { p_gift_card_id: f.card, p_session_id: f.session, p_student_id: f.temporary,
      ...(external ? { p_sede_id: ownSede } : {}), ...(once ? { p_request_key: randomUUID() } : {}) };
    const denied = await http(owner, `/rest/v1/rpc/${name}`, 'POST', args);
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe('42501');
  }
  for (const [table, filter, body] of [
    ['sessions', `id=eq.${f.session}`, { completed_at: new Date().toISOString() }],
    ['session_students', `session_id=eq.${f.session}`, { attendance: 'present' }],
    ['session_operation_receipts', `session_id=eq.${f.session}`, { result: {} }],
    ['session_credit_movements', `session_id=eq.${f.session}`, { delta: -1 }]
  ] as const) {
    const denied = await http(owner, `/rest/v1/${table}?${filter}`, 'PATCH', body);
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe('42501');
  }
  expect(await snapshot(f), 'Denied RPCs and owner bypass attempts must not change balances, revisions or receipts').toEqual(baseline);

  for (const operation of DOMAIN_READ_OPERATIONS) {
    const request = { version: 1 as const, operation, sedeId: ownSede, studentId: seedMember };
    const expected = await rpc(owner, 'domain_read_v1', { p_request: request });
    const direct = await rpc(reader, 'domain_read_v1', { p_request: request });
    expect(parseDomainReadResponse(direct, request)).toEqual(expected);
    expect(Object.keys(direct).sort()).toEqual(['data', 'operation', 'version']);
    expect(Object.keys(direct.data).sort()).toEqual((operation === 'student.summary.get'
      ? ['studentId', 'sedeId', 'category', 'archived']
      : ['studentId', 'sedeId', 'effectivePeriodId', 'tier', 'allocatedClasses', 'classesRemaining', 'startsOn', 'endsOn', 'paymentStatus']).sort());
    const edge = await http(reader, '/functions/v1/domain-read', 'POST', request);
    expect(edge.status).toBe(200);
    expect(edge.headers.get('cache-control')).toBe('no-store');
    expect(parseDomainReadResponse(edge.data, request)).toEqual(direct);
    for (const scope of [
      { sedeId: foreignSede, studentId: foreignMember },
      { sedeId: ownSede, studentId: seedTemporary },
      { sedeId: ownSede, studentId: f.member },
      { sedeId: foreignSede, studentId: seedMember },
      { sedeId: ownSede, studentId: randomUUID() }
    ]) {
      const forged = { ...request, ...scope };
      const denied = await http(reader, '/rest/v1/rpc/domain_read_v1', 'POST', { p_request: forged });
      expect(denied.status).toBe(403);
      expect(denied.data.code).toBe('42501');
      const edgeDenied = await http(reader, '/functions/v1/domain-read', 'POST', forged,
        { 'x-sede-id': ownSede, 'x-student-id': seedMember, 'x-role': 'super_admin' });
      expect(edgeDenied.status).toBe(403);
      expect(edgeDenied.data).toEqual({ error: 'forbidden' });
    }
    const invalid = await http(reader, '/functions/v1/domain-read', 'POST', { ...request, role: 'super_admin' });
    expect(invalid.status).toBe(400);
    expect(invalid.data).toEqual({ error: 'invalid_request' });
  }
  const readerRequests: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== apiUrl || !['/auth/v1/token', '/auth/v1/logout', '/rest/v1/profiles', '/rest/v1/sedes', '/rest/v1/sede_members'].includes(url.pathname)) return;
    const request = response.request();
    const role = jwtRole(request.headers().authorization?.replace(/^Bearer /i, '') || '') || 'none';
    readerRequests.push(`${request.method()} ${url.pathname} HTTP ${response.status()} auth-role=${role}`);
  });
  let readerFeedbackPassed = false;
  try {
    await loginBrowser(page, 'reader@pottery.local');
    await expect(page.getByRole('alert')).toContainText('no est\u00e1 vinculada a un taller activo');
    expect(readerRequests.filter(request => request.startsWith('GET /rest/v1/profiles'))).toEqual([
      'GET /rest/v1/profiles HTTP 200 auth-role=authenticated'
    ]);
    readerFeedbackPassed = true;
  } finally {
    if (!readerFeedbackPassed) console.log(`Reader login request diagnostics (no headers, bodies or query strings): ${readerRequests.join('; ')}`);
    // Check fail-closed access and unchanged funding even when feedback is wrong.
    await expect(page).toHaveURL(`${frontendUrl}/login`);
    await page.goto('/calendar');
    await expect(page).toHaveURL(`${frontendUrl}/login`);
    await expect(page.getByRole('button', { name: 'Iniciar sesi\u00f3n', exact: true })).toBeVisible();
    expect(await snapshot(f)).toEqual(baseline);
  }
});
