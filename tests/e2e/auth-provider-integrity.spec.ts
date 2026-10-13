import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

let server: ViteDevServer;
let origin: string;
type Gate = { promise: Promise<void>; release: () => void };
const gate = (): Gate => {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};
const tokenOwners = new Map<string, string>();
const session = (id: string, token = `${id}-initial`, claim = 'super_admin') => {
    tokenOwners.set(`synthetic-${token}`, id);
    return { access_token: `synthetic-${token}`, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
        user: { id, email: `${id}@auth.invalid`, aud: 'authenticated', created_at: '2026-10-12T00:00:00Z',
            app_metadata: { role: claim }, user_metadata: { role: claim } } };
};
type Backend = {
    profiles: Record<string, any>; owned: Record<string, any[]>; members: Record<string, any[]>;
    holds: Map<string, Gate>; failures: Map<string, any>; requests: any[]; external: string[]; errors: string[];
};
const backends = new WeakMap<Page, Backend>();
const snapshot = (page: Page) => page.evaluate(() => (window as any).__authIntegrity.snapshot());
const run = (page: Page, name: string, args: any[] = [], key = name) =>
    page.evaluate(({ name, args, key }) => (window as any).__authIntegrity.run(name, args, key), { name, args, key });
const settled = (page: Page, key: string) => expect.poll(async () => (await snapshot(page)).results[key]).toBeDefined();
const authorized = (page: Page, actor: string) => expect.poll(async () => {
    const state = await snapshot(page);
    return { profile: state.auth?.profile, actor: state.auth?.sessionActor, sdkActor: state.stored?.user.id,
        tokenMatches: state.auth?.token === state.stored?.access_token };
}).toEqual({ profile: actor, actor, sdkActor: actor, tokenMatches: true });
const cleared = (page: Page) => expect.poll(async () => (await snapshot(page)).auth).toMatchObject({
    sessionActor: null, user: null, profile: null, role: null, sede: null, loading: false,
    superAdmin: false, owner: false, staff: false
});
const requestCount = (page: Page, label: string) => backends.get(page)!.requests.filter(item => item.label === label).length;
const waitRequest = (page: Page, label: string, count = 1) => expect.poll(() => requestCount(page, label)).toBe(count);
const waitResponse = (page: Page, label: string, count = 1) => expect.poll(async () =>
    (await snapshot(page)).responses.filter((item: any) => item.label === label).length).toBe(count);
const hold = (page: Page, label: string) => {
    const pending = gate(); backends.get(page)!.holds.set(label, pending); return pending;
};
const fail = (page: Page, label: string) => backends.get(page)!.failures.set(label, { message: `Synthetic denial: ${label}` });
const paint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const open = async (page: Page, initial: any = {}) => {
    await page.addInitScript(value => { (window as any).__authInitial = value; }, initial);
    await page.goto(`${origin}/auth-provider-integrity-test`);
    await expect(page.getByTestId('auth-state')).toBeVisible();
};
const login = async (page: Page, actor = 'b', key = 'login') => {
    await run(page, 'login', [`${actor}@auth.invalid`], key);
    await settled(page, key);
    await authorized(page, actor);
    expect((await snapshot(page)).results[key]).toMatchObject({ success: true });
};
const ownProfile = async (page: Page, actor: string, key = 'own-profile') => {
    await authorized(page, actor);
    await run(page, 'own-profile', [], key); await settled(page, key);
    expect((await snapshot(page)).results[key]).toMatchObject({ data: { id: actor }, error: null });
    const request = backends.get(page)!.requests.filter(item => item.label === `profiles:${actor}`).at(-1)!;
    expect(tokenOwners.get(request.token)).toBe(actor);
};

test.beforeAll(async () => {
    const mock = fileURLToPath(new URL('../fixtures/auth-provider-integrity-mocks.ts', import.meta.url));
    server = await createServer({ configFile: false, envDir: false,
        root: fileURLToPath(new URL('../../', import.meta.url)),
        cacheDir: fileURLToPath(new URL('../../node_modules/.cache/auth-provider-integrity-vite', import.meta.url)),
        resolve: { alias: [{ find: /^.*supabaseClient(?:\.[jt]sx?)?$/, replacement: mock }], dedupe: ['react', 'react-dom'] },
        optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
        plugins: [react(), { name: 'forbid-auth-integrity-real-backend',
            resolveId(source) { if (/supabase/i.test(source)) return '\0auth-integrity-forbidden'; },
            load(id) { if (id === '\0auth-integrity-forbidden') return "throw new Error('Real backend forbidden');"; }
        }], server: { host: '127.0.0.1', port: 0, hmr: false }
    });
    await server.listen(); origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
    const profiles = Object.fromEntries([['a', 'tallerista'], ['b', 'staff'], ['admin', 'super_admin'], ['reader', 'staff']]
        .map(([id, role]) => [id, { id, role, email: `${id}@auth.invalid` }]));
    const backend: Backend = { profiles, owned: { a: [{ id: 'owned-a' }] }, members: { a: [{ sede_id: 'member-a' }], b: [{ sede_id: 'member-b' }] },
        holds: new Map(), failures: new Map(), requests: [], external: [], errors: [] };
    backends.set(page, backend);
    page.on('pageerror', error => backend.errors.push(error.message));
    await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        backend.external.push(route.request().url()); return route.abort();
    });
    await page.route('**/__auth-provider-integrity', async route => {
        const request = route.request().postDataJSON();
        const actor = request.kind === 'read' ? request.filters.find(([key]: any[]) => ['id', 'owner_id', 'user_id'].includes(key))?.[1] : undefined;
        const label = request.kind === 'read' ? `${request.table}:${actor}` : request.kind === 'session' ? `session:${request.index}`
            : request.kind.startsWith('password') ? `${request.kind}:${request.email.split('@')[0]}` : request.kind;
        request.label = label; backend.requests.push(request);
        let data: any = null;
        if (request.kind === 'session') data = request.session;
        else if (request.kind === 'password') data = session(request.email.split('@')[0], `${request.email.split('@')[0]}-login`);
        else if (request.kind === 'read') {
            if (request.table === 'profiles') data = backend.profiles[actor] ?? null;
            else if (request.table === 'sedes') data = backend.owned[actor] ?? [];
            else if (request.table === 'sede_members') data = backend.members[actor] ?? [];
            else throw new Error(`Unexpected table ${request.table}`);
        }
        // Synthetic actor-scoped reads: metadata claims cannot change the token owner.
        const error = request.kind === 'read' && tokenOwners.get(request.token) !== actor
            ? { message: `Synthetic token scope denied for ${actor}` } : backend.failures.get(label) ?? null;
        const response = structuredClone({ data: error ? null : data, error });
        await backend.holds.get(label)?.promise;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) }).catch(() => undefined);
    });
    await page.route('**/auth-provider-integrity-test', route => route.fulfill({ contentType: 'text/html', body: `
        <html lang="es"><body><div id="root"></div><script type="module">
          import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
          window.__vite_plugin_react_preamble_installed__ = true;
          await import('/tests/fixtures/auth-provider-integrity-harness.tsx');
        </script></body></html>` }));
});
test.afterEach(async ({ page }) => {
    for (const pending of backends.get(page)!.holds.values()) pending.release();
    const state = await snapshot(page);
    if (state.auth?.profile) {
        await run(page, 'sdk-session', [], 'final-sdk-session'); await settled(page, 'final-sdk-session');
        const current = await snapshot(page);
        expect(current.results['final-sdk-session'].data.session?.user.id).toBe(current.auth.profile);
        expect(current.auth.sessionActor).toBe(current.auth.profile);
        expect(current.auth.token).toBe(current.results['final-sdk-session'].data.session?.access_token);
        expect(current.stored?.user.id).toBe(current.auth.profile);
    }
    expect(backends.get(page)!.external).toEqual([]);
    expect(backends.get(page)!.errors).toEqual([]);
});

for (const [actor, role, sede] of [['a', 'tallerista', 'owned-a'], ['b', 'staff', 'member-b'], ['admin', 'super_admin', null]] as const) {
    test(`normal ${role}: bootstrap uses the backend profile and sede`, async ({ page }) => {
        await open(page, { session: session(actor) });
        await authorized(page, actor);
        expect((await snapshot(page)).auth).toMatchObject({ sessionActor: actor, role, sede, loading: false });
        expect(requestCount(page, `sedes:${actor}`)).toBe(actor === 'admin' ? 0 : 1);
        expect(requestCount(page, `sede_members:${actor}`)).toBe(actor === 'admin' ? 0 : 1);
    });
    test(`normal ${role}: explicit password login owns one authorization lookup`, async ({ page }) => {
        await open(page); await cleared(page); await login(page, actor);
        expect((await snapshot(page)).auth).toMatchObject({ role, sede, token: `synthetic-${actor}-login` });
        expect(requestCount(page, `profiles:${actor}`)).toBe(1);
        expect((await snapshot(page)).callbackReturns.every((item: any) => !item.returnedPromise)).toBe(true);
    });
}

test('owned and membership lookups run in parallel and ownership retains priority', async ({ page }) => {
    const owned = hold(page, 'sedes:a'); const member = hold(page, 'sede_members:a');
    await open(page, { session: session('a') });
    await waitRequest(page, 'sedes:a'); await waitRequest(page, 'sede_members:a');
    member.release(); await waitResponse(page, 'sede_members:a');
    expect((await snapshot(page)).auth.profile).toBeNull();
    owned.release(); await authorized(page, 'a');
    expect((await snapshot(page)).auth.sede).toBe('owned-a');
});

test('bootstrap exceeds eight seconds; locked focus SIGNED_IN returns, lookup and logout do not freeze', async ({ page }) => {
    await page.clock.install();
    const profile = hold(page, 'profiles:a');
    await open(page, { session: session('a') }); await waitRequest(page, 'profiles:a');
    await page.clock.runFor(8100);
    expect((await snapshot(page)).auth.loading).toBe(false);
    await run(page, 'emit', ['SIGNED_IN', session('a', 'a-focus')], 'focus');
    await settled(page, 'focus');
    expect(requestCount(page, 'profiles:a')).toBe(1);
    profile.release(); await authorized(page, 'a');
    expect((await snapshot(page)).auth.token).toBe('synthetic-a-focus');
    await run(page, 'logout'); await settled(page, 'logout'); await cleared(page);
    const state = await snapshot(page);
    expect(state.locked).toBe(false);
    expect(state.callbackReturns.every((item: any) => !item.returnedPromise)).toBe(true);
});

test('listener authorization starts outside the awaited SDK lock', async ({ page }) => {
    await open(page); await cleared(page);
    await run(page, 'emit', ['SIGNED_IN', session('a')], 'focus');
    await settled(page, 'focus'); await authorized(page, 'a');
    expect(backends.get(page)!.requests.filter(item => item.kind === 'read').every(item => !item.startedUnderLock)).toBe(true);
    await run(page, 'logout'); await settled(page, 'logout'); await cleared(page);
});

test('unlinked listener authorization rejects and signs out outside the SDK notification lock', async ({ page }) => {
    await open(page); await cleared(page);
    await run(page, 'emit', ['SIGNED_IN', session('reader')], 'reader-event'); await settled(page, 'reader-event');
    await waitRequest(page, 'logout'); await waitResponse(page, 'logout'); await cleared(page);
    expect((await snapshot(page)).auth.error).toContain('no est\u00e1 vinculada');
    expect((await snapshot(page)).callbackReturns.every((item: any) => !item.returnedPromise)).toBe(true);
});

test('bootstrap success arriving after SIGNED_OUT cannot restore A', async ({ page }) => {
    const owned = hold(page, 'sedes:a'); const member = hold(page, 'sede_members:a');
    await open(page, { session: session('a') }); await waitRequest(page, 'sede_members:a');
    await run(page, 'emit', ['SIGNED_OUT', null], 'out'); await settled(page, 'out'); await cleared(page);
    owned.release(); member.release(); await waitResponse(page, 'sedes:a'); await waitResponse(page, 'sede_members:a');
    await paint(page); await cleared(page);
    expect(requestCount(page, 'logout')).toBe(0);
});

for (const rejection of ['profiles', 'sede'] as const) {
    test(`stale A ${rejection} rejection after same-tab B login cannot sign out B or publish an error`, async ({ page }) => {
        const label = rejection === 'profiles' ? 'profiles:a' : 'sedes:a';
        if (rejection === 'profiles') fail(page, label);
        else { backends.get(page)!.owned.a = []; backends.get(page)!.members.a = []; }
        const pending = hold(page, label);
        await open(page, { session: session('a') }); await waitRequest(page, label);
        await run(page, 'emit', ['SIGNED_OUT', null], 'out'); await settled(page, 'out');
        await login(page, 'b', 'b-login');
        pending.release(); await waitResponse(page, label); await paint(page);
        expect((await snapshot(page)).auth).toMatchObject({ profile: 'b', role: 'staff', sede: 'member-b', error: null });
        expect(requestCount(page, 'logout')).toBe(0);
    });
}

for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED'] as const) {
    test(`${event} B without SIGNED_OUT clears A authority immediately and authorizes B`, async ({ page }) => {
        await open(page, { session: session('a') }); await authorized(page, 'a');
        const pending = hold(page, 'profiles:b');
        await run(page, 'emit', [event, session('b', 'b-event')], 'replace'); await settled(page, 'replace');
        await waitRequest(page, 'profiles:b');
        expect((await snapshot(page)).auth).toMatchObject({ sessionActor: 'b', profile: null, role: null, sede: null,
            loading: true, owner: false, superAdmin: false, staff: false });
        pending.release(); await authorized(page, 'b');
        expect((await snapshot(page)).auth).toMatchObject({ token: 'synthetic-b-event', role: 'staff', sede: 'member-b' });
        expect((await snapshot(page)).history.filter((item: any) => item.sessionActor === 'b').every((item: any) => item.profile !== 'a')).toBe(true);
    });
}

test('same-ID refresh during authorization keeps the latest token, duplicate events do not reload', async ({ page }) => {
    const pending = hold(page, 'profiles:a');
    await open(page, { session: session('a') }); await waitRequest(page, 'profiles:a');
    await run(page, 'emit', ['TOKEN_REFRESHED', session('a', 'a-refreshed')], 'refresh'); await settled(page, 'refresh');
    await run(page, 'emit', ['SIGNED_IN', session('a', 'a-focus')], 'focus'); await settled(page, 'focus');
    pending.release(); await authorized(page, 'a');
    expect((await snapshot(page)).auth.token).toBe('synthetic-a-focus');
    await run(page, 'emit', ['TOKEN_REFRESHED', session('a', 'a-newest')], 'last'); await settled(page, 'last');
    expect((await snapshot(page)).auth.token).toBe('synthetic-a-newest');
    await run(page, 'emit', ['SIGNED_IN', session('a', 'a-final-focus')], 'duplicate'); await settled(page, 'duplicate');
    expect(requestCount(page, 'profiles:a')).toBe(1);
});

test('same-ID refresh during explicit password authorization keeps the refreshed token', async ({ page }) => {
    await open(page); await cleared(page);
    const pending = hold(page, 'profiles:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'profiles:a');
    await run(page, 'emit', ['TOKEN_REFRESHED', session('a', 'a-latest')], 'refresh'); await settled(page, 'refresh');
    pending.release(); await settled(page, 'a-login'); await authorized(page, 'a');
    expect((await snapshot(page)).auth.token).toBe('synthetic-a-latest');
    expect(requestCount(page, 'profiles:a')).toBe(1);
});

test('delayed refresh of the logged-out actor cannot restore authority; a different refreshed actor is authorized', async ({ page }) => {
    await open(page, { session: session('a') }); await authorized(page, 'a');
    await run(page, 'logout'); await settled(page, 'logout'); await cleared(page);
    await run(page, 'emit', ['TOKEN_REFRESHED', session('a', 'a-delayed')], 'late'); await settled(page, 'late');
    await paint(page); await cleared(page);
    expect(requestCount(page, 'profiles:a')).toBe(1);
    await run(page, 'emit', ['TOKEN_REFRESHED', session('b')], 'b-refresh'); await settled(page, 'b-refresh');
    await authorized(page, 'b');
});

test('SIGNED_OUT while a password response is pending cancels both its callback and a subsequent refresh', async ({ page }) => {
    await open(page); await cleared(page);
    const pending = hold(page, 'password:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password:a');
    await run(page, 'emit', ['SIGNED_OUT', null], 'out'); await settled(page, 'out');
    pending.release(); await settled(page, 'a-login'); await cleared(page);
    expect((await snapshot(page)).results['a-login'].success).toBe(false);
    expect((await snapshot(page)).stored).toBeNull();
    await run(page, 'emit', ['TOKEN_REFRESHED', session('a', 'a-delayed')], 'late'); await settled(page, 'late');
    await paint(page); await cleared(page);
    expect(requestCount(page, 'profiles:a')).toBe(0);
});

test('cancelled password persistence of A replaces B authority with SDK-coherent A without signing out B', async ({ page }) => {
    await open(page); await cleared(page);
    const pending = hold(page, 'password:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password:a');
    await run(page, 'emit', ['SIGNED_IN', session('b')], 'b-event'); await settled(page, 'b-event'); await authorized(page, 'b');
    pending.release(); await settled(page, 'a-login'); await paint(page);
    expect((await snapshot(page)).results['a-login'].success).toBe(false);
    expect(requestCount(page, 'logout')).toBe(0);
    await ownProfile(page, 'a');
    expect((await snapshot(page)).auth).toMatchObject({ profile: 'a', sessionActor: 'a', role: 'tallerista', sede: 'owned-a', error: null });
});

test('old password HTTP delivery cannot restore A when the SDK has already selected B', async ({ page }) => {
    await open(page); await cleared(page);
    const delivery = hold(page, 'password-delivery:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password-delivery:a');
    await run(page, 'emit', ['SIGNED_IN', session('b', 'b-current')], 'b-event'); await settled(page, 'b-event'); await authorized(page, 'b');
    delivery.release(); await settled(page, 'a-login');
    expect((await snapshot(page)).results['a-login'].success).toBe(false);
    await ownProfile(page, 'b');
    expect((await snapshot(page)).auth.token).toBe('synthetic-b-current');
    expect(requestCount(page, 'profiles:a')).toBe(0);
    expect(requestCount(page, 'logout')).toBe(0);
});

test('duplicate cancelled A notifications followed by newer B sign-ins select SDK storage, not the captured A event', async ({ page }) => {
    await open(page); await cleared(page);
    const password = hold(page, 'password:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password:a');
    await run(page, 'emit', ['SIGNED_IN', session('b')], 'b-first'); await settled(page, 'b-first'); await authorized(page, 'b');
    await page.clock.install(); await page.clock.pauseAt(new Date());
    password.release(); await settled(page, 'a-login');
    expect((await snapshot(page)).auth).toMatchObject({ profile: null, role: null, sede: null, loading: true });
    await run(page, 'emit', ['SIGNED_IN', session('b', 'b-next')], 'b-next'); await settled(page, 'b-next');
    await run(page, 'emit', ['SIGNED_IN', session('a'), 'locked', false], 'a-replay-1'); await settled(page, 'a-replay-1');
    await run(page, 'emit', ['SIGNED_IN', session('a'), 'locked', false], 'a-replay-2'); await settled(page, 'a-replay-2');
    await run(page, 'emit', ['SIGNED_IN', session('b', 'b-newest')], 'b-last'); await settled(page, 'b-last');
    await page.clock.runFor(5); await ownProfile(page, 'b');
    expect((await snapshot(page)).auth.token).toBe('synthetic-b-newest');
    expect(requestCount(page, 'profiles:a')).toBe(0);
    expect(requestCount(page, 'logout')).toBe(0);
    expect((await snapshot(page)).callbackReturns.every((item: any) => !item.returnedPromise)).toBe(true);
});

for (const rejection of ['profiles', 'sedes'] as const) {
    test(`cancelled password A ${rejection} rejection and old refresh replay cannot override a newer SDK B`, async ({ page }) => {
        await open(page); await cleared(page);
        const password = hold(page, 'password:a');
        await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password:a');
        await run(page, 'emit', ['SIGNED_IN', session('b')], 'b-first'); await settled(page, 'b-first'); await authorized(page, 'b');
        const label = `${rejection}:a`;
        if (rejection === 'profiles') fail(page, label);
        else { backends.get(page)!.owned.a = []; backends.get(page)!.members.a = []; }
        const oldRead = hold(page, label);
        password.release(); await settled(page, 'a-login'); await waitRequest(page, label);
        await run(page, 'emit', ['SIGNED_IN', session('b', 'b-later')], 'b-later'); await settled(page, 'b-later'); await authorized(page, 'b');
        oldRead.release(); await waitResponse(page, label); await paint(page);
        await run(page, 'emit', ['TOKEN_REFRESHED', session('a', 'a-old-refresh'), 'locked', false], 'old-refresh');
        await settled(page, 'old-refresh'); await ownProfile(page, 'b');
        expect((await snapshot(page)).auth).toMatchObject({ role: 'staff', sede: 'member-b', error: null, token: 'synthetic-b-later' });
        expect(requestCount(page, label)).toBe(1);
        expect(requestCount(page, 'logout')).toBe(0);
    });
}

test('SDK A snapshot delayed during reconciliation is invalidated by a newer B event before any A profile read', async ({ page }) => {
    await open(page); await cleared(page);
    const password = hold(page, 'password:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password:a');
    await run(page, 'emit', ['SIGNED_IN', session('b')], 'b-first'); await settled(page, 'b-first'); await authorized(page, 'b');
    const nextSession = Math.max(...backends.get(page)!.requests.filter(item => item.kind === 'session').map(item => item.index)) + 1;
    const oldSession = hold(page, `session:${nextSession}`);
    password.release(); await settled(page, 'a-login'); await waitRequest(page, `session:${nextSession}`);
    await run(page, 'emit', ['SIGNED_IN', session('b', 'b-newest')], 'b-last'); await settled(page, 'b-last'); await authorized(page, 'b');
    oldSession.release(); await waitResponse(page, `session:${nextSession}`); await paint(page); await ownProfile(page, 'b');
    expect(requestCount(page, 'profiles:a')).toBe(0);
    expect(requestCount(page, 'logout')).toBe(0);
});

test('same-email password guard cannot publish the returned A actor when the actual SDK ID is B', async ({ page }) => {
    await open(page); await cleared(page);
    const delivery = hold(page, 'password-delivery:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password-delivery:a');
    const b = session('b', 'b-same-email'); b.user.email = 'a@auth.invalid';
    await run(page, 'emit', ['SIGNED_IN', b], 'b-event'); await settled(page, 'b-event');
    delivery.release(); await settled(page, 'a-login'); await ownProfile(page, 'b');
    expect((await snapshot(page)).results['a-login'].success).toBe(false);
    expect((await snapshot(page)).auth).toMatchObject({ role: 'staff', token: 'synthetic-b-same-email' });
    expect(requestCount(page, 'profiles:a')).toBe(0);
    expect(requestCount(page, 'logout')).toBe(0);
});

test('fake own-profile endpoint denies a foreign actor even with synthetic super-admin metadata claims', async ({ page }) => {
    await open(page, { session: session('b') }); await ownProfile(page, 'b');
    await run(page, 'own-profile', ['a'], 'foreign-profile'); await settled(page, 'foreign-profile');
    expect((await snapshot(page)).results['foreign-profile']).toEqual({ data: null,
        error: { message: 'Synthetic token scope denied for a' } });
    await authorized(page, 'b');
});

for (const stage of ['selection', 'verification'] as const) {
    test(`rejected SDK session read during ${stage} fails closed without an unhandled listener rejection`, async ({ page }) => {
        // Admin needs one profile query and no sede queries: reads 2 and 4 are
        // the authorization selector and final pre-publication verification.
        backends.get(page)!.failures.set(`session:${stage === 'selection' ? 2 : 4}`,
            { message: 'Synthetic SDK lock rejection', throws: true });
        await open(page); await cleared(page);
        await run(page, 'emit', ['SIGNED_IN', session('admin')], 'admin-event'); await settled(page, 'admin-event'); await cleared(page);
        expect((await snapshot(page)).auth.error).toContain('No se pudo verificar');
        expect(requestCount(page, 'profiles:admin')).toBe(stage === 'selection' ? 0 : 1);
        expect(requestCount(page, 'logout')).toBe(0);
    });
}

for (const event of ['SIGNED_OUT', 'SIGNED_IN', 'TOKEN_REFRESHED'] as const) {
    test(`old bootstrap getSession snapshot after ${event} cannot override the event`, async ({ page }) => {
        const pending = hold(page, 'session:1');
        await open(page, { session: session('a') }); await waitRequest(page, 'session:1');
        await run(page, 'emit', [event, event === 'SIGNED_OUT' ? null : session('b')], 'event'); await settled(page, 'event');
        if (event === 'SIGNED_OUT') await cleared(page); else await authorized(page, 'b');
        pending.release(); await waitResponse(page, 'session:1'); await paint(page);
        if (event === 'SIGNED_OUT') await cleared(page); else await authorized(page, 'b');
        expect(requestCount(page, 'profiles:a')).toBe(0);
    });
}

for (const stage of ['password', 'profiles', 'sedes'] as const) {
    test(`logout while explicit login waits for ${stage}: late response cannot return success or restore A`, async ({ page }) => {
        await open(page); await cleared(page);
        const label = stage === 'password' ? 'password:a' : `${stage}:a`;
        const pending = hold(page, label);
        await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, label);
        await run(page, 'logout'); await cleared(page);
        pending.release(); await settled(page, 'a-login'); await settled(page, 'logout'); await paint(page);
        await cleared(page);
        expect((await snapshot(page)).results['a-login'].success).toBe(false);
        expect((await snapshot(page)).stored).toBeNull();
    });
}

test('stale login finally cannot release the newer login guard', async ({ page }) => {
    await open(page); await cleared(page);
    const a = hold(page, 'profiles:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'profiles:a');
    await run(page, 'logout'); await settled(page, 'logout');
    const b = hold(page, 'profiles:b');
    await run(page, 'login', ['b@auth.invalid'], 'b-login'); await waitRequest(page, 'profiles:b');
    a.release(); await settled(page, 'a-login');
    await run(page, 'login', ['admin@auth.invalid'], 'duplicate'); await settled(page, 'duplicate');
    expect((await snapshot(page)).results.duplicate.success).toBe(false);
    expect(requestCount(page, 'password:admin')).toBe(0);
    b.release(); await settled(page, 'b-login'); await authorized(page, 'b');
});

test('different actor invalidates explicit login even without an intervening SIGNED_OUT', async ({ page }) => {
    await open(page); await cleared(page);
    const pending = hold(page, 'profiles:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'profiles:a');
    await run(page, 'emit', ['SIGNED_IN', session('b')], 'b-event'); await settled(page, 'b-event'); await authorized(page, 'b');
    pending.release(); await settled(page, 'a-login');
    expect((await snapshot(page)).results['a-login'].success).toBe(false);
    expect((await snapshot(page)).auth).toMatchObject({ profile: 'b', role: 'staff', sede: 'member-b', error: null });
});

for (const rejection of ['profiles', 'sedes'] as const) {
    test(`cancelled explicit A ${rejection} failure cannot sign out a subsequent B login`, async ({ page }) => {
        await open(page); await cleared(page);
        const label = `${rejection}:a`;
        if (rejection === 'profiles') fail(page, label);
        else { backends.get(page)!.owned.a = []; backends.get(page)!.members.a = []; }
        const pending = hold(page, label);
        await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, label);
        await run(page, 'logout'); await settled(page, 'logout');
        await login(page, 'b', 'b-login');
        pending.release(); await settled(page, 'a-login'); await paint(page);
        expect((await snapshot(page)).results['a-login'].success).toBe(false);
        expect(backends.get(page)!.requests.filter(item => item.kind === 'logout').map(item => item.actor)).toEqual(['a']);
        expect((await snapshot(page)).auth).toMatchObject({ profile: 'b', error: null });
    });
}

test('bootstrap success delayed past timeout cannot replace a newer explicit B login', async ({ page }) => {
    await page.clock.install();
    const pending = hold(page, 'sedes:a');
    await open(page, { session: session('a') }); await waitRequest(page, 'sedes:a');
    await page.clock.runFor(8100);
    await login(page, 'b', 'b-login');
    pending.release(); await waitResponse(page, 'sedes:a'); await paint(page);
    expect((await snapshot(page)).auth).toMatchObject({ profile: 'b', sessionActor: 'b', token: 'synthetic-b-login' });
});

test('duplicate explicit password login is blocked before the first password response', async ({ page }) => {
    await open(page); await cleared(page); const pending = hold(page, 'password:a');
    await run(page, 'login', ['a@auth.invalid'], 'first'); await waitRequest(page, 'password:a');
    await run(page, 'login', ['b@auth.invalid'], 'second'); await settled(page, 'second');
    expect((await snapshot(page)).results.second.success).toBe(false);
    expect(requestCount(page, 'password:b')).toBe(0);
    pending.release(); await settled(page, 'first'); await authorized(page, 'a');
});

test('logout clears React authority before SDK completion and blocks a competing password request until completion', async ({ page }) => {
    await open(page, { session: session('a') }); await authorized(page, 'a');
    const pending = hold(page, 'logout');
    await run(page, 'logout'); await waitRequest(page, 'logout'); await cleared(page);
    await run(page, 'login', ['b@auth.invalid'], 'blocked'); await settled(page, 'blocked');
    expect((await snapshot(page)).results.blocked.success).toBe(false);
    expect(requestCount(page, 'password:b')).toBe(0);
    pending.release(); await settled(page, 'logout');
    await login(page, 'b', 'b-login');
});

test('failure waiting for the SDK session lock is invalidated before it can sign out B', async ({ page }) => {
    const profile = hold(page, 'profiles:a'); fail(page, 'profiles:a');
    await open(page, { session: session('a') }); await waitRequest(page, 'profiles:a');
    const lock = hold(page, 'lock'); await run(page, 'lock', [], 'lock'); await waitRequest(page, 'lock');
    profile.release(); await waitResponse(page, 'profiles:a'); await paint(page);
    await run(page, 'emit', ['SIGNED_IN', session('b'), 'broadcast'], 'b-event'); await settled(page, 'b-event');
    lock.release(); await settled(page, 'lock'); await authorized(page, 'b');
    expect(requestCount(page, 'logout')).toBe(0);
    expect((await snapshot(page)).auth.error).toBeNull();
});

for (const mode of ['unlinked', 'foreign-id', 'invalid-role', 'missing-profile'] as const) {
    test(`authorization fails closed for ${mode}, ignoring synthetic metadata authority claims`, async ({ page }) => {
        const backend = backends.get(page)!;
        if (mode === 'foreign-id') backend.profiles.a = { ...backend.profiles.admin };
        if (mode === 'invalid-role') backend.profiles.a.role = 'unknown';
        if (mode === 'missing-profile') delete backend.profiles.a;
        const actor = mode === 'unlinked' ? 'reader' : 'a';
        await open(page); await cleared(page);
        await run(page, 'login', [`${actor}@auth.invalid`], 'rejected'); await settled(page, 'rejected'); await cleared(page);
        const state = await snapshot(page);
        expect(state.results.rejected.success).toBe(false);
        expect(state.auth.error).toContain(mode === 'unlinked' ? 'no est\u00e1 vinculada' : 'perfil');
        expect(backend.requests.filter(item => item.kind === 'logout').map(item => item.actor)).toEqual([actor]);
    });
}

test('StrictMode cleanup invalidates its first bootstrap snapshot and unsubscribes', async ({ page }) => {
    const first = hold(page, 'session:1');
    await open(page, { session: session('a'), strict: true });
    await authorized(page, 'a');
    expect((await snapshot(page)).subscriptions).toBe(1);
    first.release(); await waitResponse(page, 'session:1'); await paint(page);
    expect(requestCount(page, 'profiles:a')).toBe(1);
    await run(page, 'unmount'); await expect.poll(async () => (await snapshot(page)).subscriptions).toBe(0);
});

test('unmount cancels a scheduled listener task before it can query or write state', async ({ page }) => {
    await open(page); await cleared(page);
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await run(page, 'emit', ['SIGNED_IN', session('a')], 'event'); await settled(page, 'event');
    await run(page, 'unmount'); await expect.poll(async () => (await snapshot(page)).subscriptions).toBe(0);
    await page.clock.runFor(10);
    expect(requestCount(page, 'profiles:a')).toBe(0);
});

test('unmount invalidates a pending bootstrap rejection, with no SDK sign-out after cleanup', async ({ page }) => {
    const profile = hold(page, 'profiles:a'); fail(page, 'profiles:a');
    await open(page, { session: session('a') }); await waitRequest(page, 'profiles:a');
    await run(page, 'unmount'); await expect.poll(async () => (await snapshot(page)).subscriptions).toBe(0);
    const historyCount = (await snapshot(page)).history.length;
    profile.release(); await waitResponse(page, 'profiles:a'); await paint(page);
    expect(requestCount(page, 'logout')).toBe(0);
    expect((await snapshot(page)).history).toHaveLength(historyCount);
});

test('unmount while password login is pending suppresses its callback, lookup and result success', async ({ page }) => {
    await open(page); await cleared(page);
    const pending = hold(page, 'password:a');
    await run(page, 'login', ['a@auth.invalid'], 'a-login'); await waitRequest(page, 'password:a');
    await run(page, 'unmount'); await expect.poll(async () => (await snapshot(page)).subscriptions).toBe(0);
    const historyCount = (await snapshot(page)).history.length;
    pending.release(); await settled(page, 'a-login'); await paint(page);
    expect((await snapshot(page)).results['a-login'].success).toBe(false);
    expect(requestCount(page, 'profiles:a')).toBe(0);
    expect(requestCount(page, 'logout')).toBe(0);
    expect((await snapshot(page)).history).toHaveLength(historyCount);
});
