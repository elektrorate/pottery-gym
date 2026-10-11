import { expect, test } from '@playwright/test';
import { createDomainReadAdapter } from '../../integrations/mcp/domain-read-adapter';
import { createDomainReadBackend, createDomainReadHandler, type DomainReadAudit, type DomainReadBackend } from '../../supabase/functions/_shared/domain-read-api';
import {
  DOMAIN_READ_OPERATIONS, DomainReadError, domainReadDataSchemas, domainReadInputSchema,
  parseDomainReadRequest, parseDomainReadResponse, readDomainJson, type DomainReadRequest
} from '../../supabase/functions/_shared/domain-read-contract';

// Every test is in-memory. No browser fixtures or real fetch calls are used.
const sedeId = '30000000-0000-0000-0000-000000000001';
const studentId = '10000000-0000-0000-0000-000000000001';
const otherId = '10000000-0000-0000-0000-000000000002';
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.test';
const request: DomainReadRequest = { version: 1, operation: 'student.summary.get', sedeId, studentId };
const summary = { studentId, sedeId, category: 'membresia', archived: false };
const membership = { studentId, sedeId, effectivePeriodId: null, tier: null,
  allocatedClasses: null, classesRemaining: null, startsOn: null, endsOn: null, paymentStatus: null };
const responseFor = (input: DomainReadRequest, data: unknown = input.operation === 'student.summary.get' ? summary : membership) =>
  ({ version: 1, operation: input.operation, data });
const httpRequest = (body: unknown = request, options: RequestInit = {}, suffix = '') =>
  new Request(`https://project.supabase.invalid/functions/v1/domain-read${suffix}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), ...options
  });

const mockBackend = (overrides: Partial<DomainReadBackend> = {}) => {
  const reads: DomainReadRequest[] = [];
  const audits: DomainReadAudit[] = [];
  const tokens: string[] = [];
  const handler = createDomainReadHandler({
    authenticate: async value => { tokens.push(value); return true; },
    read: async (value, input) => {
      tokens.push(value); reads.push(input);
      return { data: responseFor(input), error: null };
    },
    audit: event => audits.push(event), ...overrides
  });
  return { handler, reads, audits, tokens };
};

test('strict versioned input and published schemas share an exact allowlist', () => {
  expect(domainReadInputSchema.required).toEqual(['version', 'operation', 'sedeId', 'studentId']);
  expect(domainReadInputSchema.additionalProperties).toBe(false);
  expect(domainReadInputSchema.properties.operation.enum).toEqual(DOMAIN_READ_OPERATIONS);
  expect(parseDomainReadRequest({ ...request, studentId: studentId.toUpperCase() })).toEqual(request);
  for (const operation of DOMAIN_READ_OPERATIONS) {
    expect(parseDomainReadRequest({ ...request, operation }).operation).toBe(operation);
    expect(domainReadDataSchemas[operation].additionalProperties).toBe(false);
    expect(Object.keys(domainReadDataSchemas[operation].properties)).toEqual(domainReadDataSchemas[operation].required);
  }
});

test('input rejects absent, extra, malformed, write, scope and SQL-dispatch fields', () => {
  const injection = "' OR true; DROP TABLE public.students; --";
  const invalid: unknown[] = [null, [], 'string', 1, {}, { ...request, version: '1' }, { ...request, version: 2 },
    { ...request, operation: 'student.update' }, { ...request, operation: injection },
    { ...request, studentId: injection }, { ...request, sedeId: injection },
    { ...request, studentId: null }, { ...request, sedeId: ['tenant'] }, { ...request, studentId: '*' }];
  for (const field of ['studentId', 'sedeId', 'version', 'operation']) {
    const value = { ...request } as Record<string, unknown>; delete value[field]; invalid.push(value);
  }
  for (const key of ['sql', 'table', 'select', 'fields', 'limit', 'url', 'authorization', 'role', 'userId', 'grant']) {
    invalid.push({ ...request, [key]: injection });
  }
  for (const value of invalid) expect(() => parseDomainReadRequest(value)).toThrow('invalid_request');
});

test('bounded JSON parser rejects malformed, oversized, multibyte and chunked payloads', async () => {
  expect(await readDomainJson(httpRequest())).toEqual(request);
  for (const value of ['{', '', '"' + 'x'.repeat(4096) + '"', '"' + '\u00e1'.repeat(2100) + '"']) {
    await expect(readDomainJson(new Response(value))).rejects.toBeInstanceOf(DomainReadError);
  }
  const chunks = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(3000)); controller.enqueue(new Uint8Array(3000)); controller.close();
  } });
  await expect(readDomainJson(new Response(chunks))).rejects.toMatchObject({ status: 413 });
  await expect(readDomainJson(new Response(new Uint8Array([0xff])))).rejects.toMatchObject({ code: 'invalid_json' });
});

test('response contract preserves unknown membership observations and nonmembership null', () => {
  expect(parseDomainReadResponse(responseFor(request), request).data).toEqual(summary);
  const input = { ...request, operation: 'membership.status.get' } as const;
  expect(parseDomainReadResponse(responseFor(input), input).data).toEqual(membership);
  expect(parseDomainReadResponse(responseFor(input, null), input).data).toBeNull();
  const dated = { ...membership, effectivePeriodId: otherId, tier: 'gold', allocatedClasses: 4,
    classesRemaining: 2, startsOn: '2028-02-29', endsOn: '2028-03-28', paymentStatus: 'pending' };
  expect(parseDomainReadResponse(responseFor(input, dated), input).data).toEqual(dated);
});

test('response rejects every extra/absent field and foreign tenant/student/operation', () => {
  const forbidden = ['name', 'email', 'phone', 'notes', 'observations', 'price', 'confirmedBy', 'metadata', 'legacySnapshot'];
  for (const operation of DOMAIN_READ_OPERATIONS) {
    const input = { ...request, operation };
    const data = operation === 'student.summary.get' ? summary : membership;
    for (const key of forbidden) {
      expect(() => parseDomainReadResponse(responseFor(input, { ...data, [key]: 'secret' }), input)).toThrow('invalid_upstream_response');
    }
    for (const key of Object.keys(data)) {
      const partial: Record<string, unknown> = { ...data }; delete partial[key];
      expect(() => parseDomainReadResponse(responseFor(input, partial), input)).toThrow('invalid_upstream_response');
    }
    for (const changed of [{ ...data, studentId: otherId }, { ...data, sedeId: otherId }]) {
      expect(() => parseDomainReadResponse(responseFor(input, changed), input)).toThrow('invalid_upstream_response');
    }
  }
  for (const value of [null, [], responseFor(request, null), { ...responseFor(request), version: 2 },
    { ...responseFor(request), operation: 'membership.status.get' }, { ...responseFor(request), secret: 'PII' }]) {
    expect(() => parseDomainReadResponse(value, request)).toThrow('invalid_upstream_response');
  }
});

test('field validators reject invalid enum, boolean, date, UUID and integer values', () => {
  for (const changed of [{ category: 'unknown' }, { archived: 'false' }]) {
    expect(() => parseDomainReadResponse(responseFor(request, { ...summary, ...changed }), request)).toThrow();
  }
  const input = { ...request, operation: 'membership.status.get' } as const;
  for (const changed of [{ tier: 'admin' }, { effectivePeriodId: 'not-id' }, { allocatedClasses: '4' },
    { classesRemaining: 1.5 }, { classesRemaining: Number.MAX_SAFE_INTEGER + 1 },
    { paymentStatus: 'inferred_paid' }, { startsOn: '2027-02-29' }, { endsOn: 'infinity' }, { endsOn: 42 }]) {
    expect(() => parseDomainReadResponse(responseFor(input, { ...membership, ...changed }), input)).toThrow();
  }
});

test('handler performs only authenticated fixed read and returns minimized no-store response', async () => {
  const backend = mockBackend();
  const response = await backend.handler(httpRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(responseFor(request));
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(backend.reads).toEqual([request]);
  expect(backend.tokens).toEqual([token, token]);
  expect(backend.audits).toEqual([{ event: 'domain_read', requestId: response.headers.get('x-request-id'),
    operation: request.operation, status: 200 }]);
});

test('handler blocks unauthenticated, malformed, write and query requests before reads', async () => {
  const backend = mockBackend();
  const attempts: Array<[Request, number]> = [
    [httpRequest(request, { method: 'GET', body: undefined }), 405],
    [httpRequest(request, { method: 'PATCH' }), 405],
    [httpRequest(request, { headers: { 'content-type': 'application/json' } }), 401],
    [httpRequest(request, { headers: { authorization: 'Bearer service_key', 'content-type': 'application/json' } }), 401],
    [httpRequest(request, { headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } }), 415],
    [httpRequest({ ...request, operation: 'student.delete' }), 400],
    [httpRequest(request, {}, '?sql=select'), 400],
    [httpRequest(request, { body: 'x'.repeat(4097) }), 413]
  ];
  for (const [attempt, status] of attempts) expect((await backend.handler(attempt)).status).toBe(status);
  expect(backend.reads).toEqual([]);
  expect(backend.tokens).toEqual([]);
  expect(backend.audits).toHaveLength(attempts.length);
});

test('handler propagates invalid Auth and denied tenant/student/operation without PII', async () => {
  const unauthenticated = mockBackend({ authenticate: async () => false });
  expect((await unauthenticated.handler(httpRequest())).status).toBe(401);
  expect(unauthenticated.reads).toEqual([]);
  const denied = mockBackend({ read: async () => ({ data: { name: 'PRIVATE' },
    error: { code: '42501', message: 'PRIVATE token and resource' } }) });
  for (const changed of [{ sedeId: otherId }, { studentId: otherId }, { operation: 'membership.status.get' }]) {
    const response = await denied.handler(httpRequest({ ...request, ...changed }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  }
  const logs = JSON.stringify(denied.audits);
  for (const sensitive of [token, studentId, sedeId, otherId, 'PRIVATE']) expect(logs).not.toContain(sensitive);
  for (const event of denied.audits) expect(Object.keys(event)).toEqual(['event', 'requestId', 'operation', 'status']);
});

test('handler redacts backend exceptions and rejects untrusted response fields', async () => {
  for (const backend of [mockBackend({ authenticate: async () => { throw new Error('secret@example.invalid'); } }),
    mockBackend({ read: async () => ({ data: responseFor(request, { ...summary, notes: 'PII' }), error: null }) }),
    mockBackend({ read: async () => ({ data: null, error: { code: 'PGRST202' } }) })]) {
    const response = await backend.handler(httpRequest());
    expect([502, 503]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain('secret'); expect(body).not.toContain('PII');
  }
});

test('real HTTP backend verifies Auth then calls only the fixed RPC with anon key and caller JWT', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const audits: DomainReadAudit[] = [];
  const handler = createDomainReadHandler(createDomainReadBackend({
    supabaseOrigin: 'https://project.supabase.invalid/', anonKey: 'public-project-key', audit: event => audits.push(event),
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return String(url).endsWith('/auth/v1/user') ? Response.json({ id: otherId, email: 'PRIVATE' }) : Response.json(responseFor(request));
    }) as typeof fetch
  }));
  expect((await handler(httpRequest())).status).toBe(200);
  expect(calls.map(call => call.url)).toEqual([
    'https://project.supabase.invalid/auth/v1/user', 'https://project.supabase.invalid/rest/v1/rpc/domain_read_v1'
  ]);
  expect(calls.map(call => call.init.method)).toEqual(['GET', 'POST']);
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ p_request: request });
  for (const call of calls) {
    expect(call.init.redirect).toBe('error');
    expect(new Headers(call.init.headers).get('apikey')).toBe('public-project-key');
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${token}`);
  }
  expect(JSON.stringify(audits)).not.toContain('PRIVATE');
});

test('real HTTP backend fails closed on incomplete config, invalid Auth and RPC authorization errors', async () => {
  for (const authResponse of [new Response('PRIVATE', { status: 401 }), Response.json({ email: 'PRIVATE' }),
    new Response('PRIVATE', { status: 503 })]) {
    let calls = 0;
    const handler = createDomainReadHandler(createDomainReadBackend({
      supabaseOrigin: 'https://project.supabase.invalid', anonKey: 'public-key', audit: () => {},
      fetch: (async () => { calls++; return authResponse; }) as typeof fetch
    }));
    expect([401, 503]).toContain((await handler(httpRequest())).status);
    expect(calls).toBe(1);
  }
  for (const config of [{ supabaseOrigin: 'https://project.supabase.invalid' }, { anonKey: 'public-key' }]) {
    const handler = createDomainReadHandler(createDomainReadBackend({ ...config, audit: () => {},
      fetch: (async () => { throw new Error('must not call transport'); }) as typeof fetch }));
    expect((await handler(httpRequest())).status).toBe(503);
  }
  const handler = createDomainReadHandler(createDomainReadBackend({
    supabaseOrigin: 'https://project.supabase.invalid', anonKey: 'public-key', audit: () => {},
    fetch: (async url => String(url).endsWith('/auth/v1/user') ? Response.json({ id: otherId })
      : Response.json({ code: '42501', message: 'PRIVATE' }, { status: 403 })) as typeof fetch
  }));
  const response = await handler(httpRequest());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'forbidden' });
});

test('MCP adapter is a two-tool wrapper of the same API, with fixed destination and server auth', async () => {
  const backend = mockBackend();
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const config = {
    supabaseOrigin: 'https://project.supabase.invalid', getAccessToken: async () => token,
    fetch: (async (url, init) => {
      sent.push({ url: String(url), init: init! });
      return backend.handler(new Request(url, init));
    }) as typeof fetch
  };
  const adapter = createDomainReadAdapter(config);
  config.supabaseOrigin = 'https://attacker.invalid';
  config.getAccessToken = async () => 'other.token.value';
  const tools = adapter.listTools();
  expect(tools.map(tool => tool.name)).toEqual(['get_student_summary', 'get_membership_status']);
  for (const tool of tools) {
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }
  tools[0].inputSchema.required.push('url');
  expect(adapter.listTools()[0].inputSchema.required).toEqual(['sedeId', 'studentId']);
  const result = await adapter.callTool('get_student_summary', { sedeId, studentId });
  expect(result.structuredContent).toEqual(responseFor(request));
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  await adapter.callTool('get_membership_status', { sedeId, studentId });
  expect(backend.reads.map(input => input.operation)).toEqual(DOMAIN_READ_OPERATIONS);
  for (const call of sent) {
    expect(call.url).toBe('https://project.supabase.invalid/functions/v1/domain-read');
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${token}`);
  }
});

test('MCP rejects writes, extra auth/URL/operation fields and injection without requesting credentials', async () => {
  let tokens = 0; let sends = 0;
  const adapter = createDomainReadAdapter({ supabaseOrigin: 'https://project.supabase.invalid',
    getAccessToken: async () => { tokens++; return token; },
    fetch: (async () => { sends++; throw new Error('no network'); }) as typeof fetch });
  for (const name of ['execute_sql', 'update_student', 'fetch', '__proto__', 'constructor']) {
    await expect(adapter.callTool(name, { sedeId, studentId })).rejects.toThrow('unknown_tool');
  }
  for (const key of ['url', 'authorization', 'bearer', 'operation', 'version', 'sql', 'fields']) {
    await expect(adapter.callTool('get_student_summary', { sedeId, studentId, [key]: 'arbitrary' })).rejects.toThrow('invalid_request');
  }
  for (const args of [null, [], { sedeId }, { sedeId, studentId: "' OR 1=1 --" }]) {
    await expect(adapter.callTool('get_student_summary', args)).rejects.toThrow('invalid_request');
  }
  expect(tokens).toBe(0); expect(sends).toBe(0);
});

test('MCP rejects insecure configured origins and never exposes credential/transport errors', async () => {
  for (const origin of ['http://project.invalid', 'https://user:pass@project.invalid',
    'https://project.invalid/functions/v1/bonos-write', 'https://project.invalid?url=x',
    'https://project.invalid#fragment', 'https://project.invalid:8443']) {
    expect(() => createDomainReadAdapter({ supabaseOrigin: origin, getAccessToken: async () => token })).toThrow();
  }
  for (const provider of [async () => { throw new Error('SECRET in provider'); }, async () => 'service_role_key']) {
    const adapter = createDomainReadAdapter({ supabaseOrigin: 'https://project.supabase.invalid', getAccessToken: provider,
      fetch: (async () => { throw new Error('SECRET in transport'); }) as typeof fetch });
    await expect(adapter.callTool('get_student_summary', { sedeId, studentId })).rejects.not.toThrow('SECRET');
  }
  const adapter = createDomainReadAdapter({ supabaseOrigin: 'https://project.supabase.invalid', getAccessToken: async () => token,
    fetch: (async () => { throw new Error('SECRET in redirect/transport'); }) as typeof fetch });
  await expect(adapter.callTool('get_student_summary', { sedeId, studentId })).rejects.toThrow('domain_read_failed');
});

test('MCP redacts upstream error bodies and rejects successful foreign/PII responses', async () => {
  for (const response of [new Response('PRIVATE bearer', { status: 403 }),
    new Response('PRIVATE bearer', { status: 302, headers: { location: 'https://attacker.invalid' } }),
    Response.json(responseFor(request, { ...summary, email: 'PRIVATE' })),
    Response.json(responseFor(request, { ...summary, studentId: otherId }))]) {
    const adapter = createDomainReadAdapter({ supabaseOrigin: 'https://project.supabase.invalid', getAccessToken: async () => token,
      fetch: (async () => response) as typeof fetch });
    await expect(adapter.callTool('get_student_summary', { sedeId, studentId })).rejects.not.toThrow('PRIVATE');
  }
});
