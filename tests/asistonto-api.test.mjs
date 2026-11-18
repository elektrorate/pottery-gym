import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundles the shipped shared handler; the Supabase transport is a fake. No env file,
// database or network is used. Keys are random per run and never printed.
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['supabase/functions/_shared/asistonto-api.ts'], bundle: true, write: false, platform: 'node', format: 'esm'
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const sede = '30000000-0000-0000-0000-000000000001';
const asistontoKey = randomBytes(32).toString('hex');
const rioKey = randomBytes(32).toString('hex');
const otherKey = randomBytes(32).toString('hex');
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
let env;
let calls;
let reply;
const makeClient = () => ({ rpc: async (fn, args) => { calls.push({ fn, args }); return reply(fn, args); } });
const getEnv = (name) => env[name];
const read = (query, key = asistontoKey, method = 'GET') => api.handleRead(new Request(`https://edge.invalid/asistonto-read?${query}`,
  { method, headers: key ? { authorization: `Bearer ${key}` } : {} }), getEnv, makeClient);
const write = (body, key = asistontoKey) => api.handleWrite(new Request('https://edge.invalid/asistonto-write', {
  method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) }), getEnv, makeClient);

beforeEach(() => {
  env = { SUPABASE_URL: 'https://offline.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only', BONOS_API_SEDE_ID: sede,
    ASISTONTO_KEY_SHA256: `${sha(asistontoKey)}, not-a-hash`, RIO_APPROVER_KEY_SHA256: sha(rioKey).toUpperCase(),
    ASISTONTO_WRITES_ENABLED: 'true' };
  calls = [];
  reply = () => ({ data: { data: [], count: 0 }, error: null });
});

test('fingerprint lists ignore malformed entries and normalize case', () => {
  assert.deepEqual(api.fingerprints(` ${'A'.repeat(64)},x,${'a'.repeat(64)}`), ['a'.repeat(64)]);
});

test('401 without key, with short key, with unknown key, or with a fingerprint used as key', async () => {
  for (const key of [null, 'short', otherKey, sha(asistontoKey)]) {
    const response = await read('op=bonos', key);
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
});

test('a key listed for both actors is refused', async () => {
  env.RIO_APPROVER_KEY_SHA256 = sha(asistontoKey);
  assert.equal((await read('op=bonos')).status, 401);
});

test('read: GET only, scoped to configured sede, query params whitelisted', async () => {
  assert.equal((await read('op=bonos', asistontoKey, 'POST')).status, 405);
  const ok = await read('op=bonos&code=CR-1&limit=5');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.at(-1), { fn: 'asistonto_read', args: { p_sede_id: sede, p_op: 'bonos', p_params: { code: 'CR-1', limit: '5' } } });
  assert.equal((await read('op=bonos&buyer_email=x')).status, 400);
  assert.equal((await read('op=bonos&code=a&code=b')).status, 400);
  assert.equal((await read('op=gift_cards')).status, 400);
  assert.equal((await read('op=alumnos&sede_id=00000000-0000-0000-0000-000000000002')).status, 400);
  assert.equal(calls.length, 1);
});

test('RIO may read too; missing configuration is 503 with the variable name only', async () => {
  assert.equal((await read('op=clases', rioKey)).status, 200);
  delete env.BONOS_API_SEDE_ID;
  const response = await read('op=clases');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body.missing, ['ASISTONTO_SEDE_ID']);
  assert.ok(!JSON.stringify(body).includes('synthetic-only'));
});

test('database errors map to HTTP codes; unexpected errors are not leaked', async () => {
  const cases = [['AS400', 400], ['AS403', 403], ['AS404', 404], ['AS409', 409], ['AS410', 410], ['42501', 403], ['P0001', 409], ['XX000', 500]];
  for (const [code, status] of cases) {
    reply = () => ({ data: null, error: { code, message: `secret internal detail ${code}` } });
    const response = await read('op=bonos');
    assert.equal(response.status, status);
    if (status === 500) assert.deepEqual(await response.json(), { error: 'Internal error' });
  }
});

test('write gate: anything but ASISTONTO_WRITES_ENABLED=true is 403 before any database call', async () => {
  for (const value of [undefined, 'false', 'TRUE', '1']) {
    env.ASISTONTO_WRITES_ENABLED = value;
    assert.equal((await write({ op: 'draft', kind: 'student.create', payload: { name: 'PRUEBA RIO – no usar' } })).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('write: actor rules, body validation and RPC arguments', async () => {
  assert.equal((await write({ op: 'approve', draftId: 'x', approvalRef: 't1u' })).status, 403, 'asistonto cannot approve');
  assert.equal((await write({ op: 'draft', kind: 'student.create', payload: {} }, rioKey)).status, 403, 'RIO cannot draft');
  assert.equal((await write({ op: 'draft', kind: 'x', payload: {}, actor: 'rio' })).status, 400, 'actor is never taken from the body');
  assert.equal((await write('[1]')).status, 400);
  assert.equal((await write('{bad')).status, 400);
  assert.equal((await write({ op: 'drop' })).status, 400);
  assert.equal((await write(JSON.stringify({ op: 'draft', kind: 'student.create', payload: { name: 'x'.repeat(9000) } }))).status, 413);
  assert.equal(calls.length, 0);
  reply = () => ({ data: { data: { draftId: 'd1', status: 'pending' } }, error: null });
  const created = await write({ op: 'draft', kind: 'bono.create', payload: { recipient: 'PRUEBA RIO – no usar', numClasses: 1 } });
  assert.equal(created.status, 201);
  assert.deepEqual(calls.at(-1).args, { p_sede_id: sede, p_actor: 'asistonto', p_op: 'draft',
    p_params: { kind: 'bono.create', payload: { recipient: 'PRUEBA RIO – no usar', numClasses: 1 } } });
  assert.equal((await write({ op: 'approve', draftId: 'd1', approvalRef: 't1u' }, rioKey)).status, 200);
  assert.equal(calls.at(-1).args.p_actor, 'rio');
  assert.equal((await write({ op: 'commit', draftId: 'd1' })).status, 200);
  assert.equal((await write({ op: 'commit', draftId: 'd1' }, rioKey)).status, 200);
});

test('write: GET is 405 and an unknown key is 401 even when writes are enabled', async () => {
  const response = await api.handleWrite(new Request('https://edge.invalid/asistonto-write', { headers: { 'x-api-key': asistontoKey } }), getEnv, makeClient);
  assert.equal(response.status, 405);
  assert.equal((await write({ op: 'list' }, otherKey)).status, 401);
});
