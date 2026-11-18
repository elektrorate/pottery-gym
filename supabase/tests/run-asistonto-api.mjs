import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Disposable, networkless postgres:17 container; never a remote or live project.
// 1) stubs + every migration in order + the unchanged local-staging synthetic seed
// 2) SQL assertions (supabase/tests/asistonto_api.fixture.psql)
// 3) HTTP-level checks of the shipped Edge handler with an RPC transport that calls the
//    same database as service_role (PostgREST is not part of this runner).
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
let container;
let httpChecks = 0;
try {
  assert.match(docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}').trim(), /^(npipe:|unix:)/, 'Refusing a remote Docker context');
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/, 'A local postgres:17 image is required; never pull');
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', `asistonto-api-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image, 'postgres', '-c', 'listen_addresses=').trim();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { docker('exec', container, 'pg_isready', '-U', 'postgres', '-h', '/var/run/postgresql'); ready = true; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, 'Fresh disposable database did not become ready');
  const psql = (...args) => docker('exec', container, 'psql', '-X', '-q', '-w', '-U', 'postgres', '-h', '/var/run/postgresql',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', ...args);
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
  assert.ok(migrations.includes('20261118210000_asistonto_api.sql'));
  docker('cp', 'supabase/tests/external_bonos_temporal_student.stubs.psql', `${container}:/tmp/asistonto-000-stubs.sql`);
  migrations.forEach((file, index) => docker('cp', `supabase/migrations/${file}`, `${container}:/tmp/asistonto-${String(index + 1).padStart(3, '0')}.sql`));
  docker('cp', 'local-staging/seed.psql', `${container}:/tmp/asistonto-seed.psql`);
  docker('cp', 'supabase/tests/asistonto_api.fixture.psql', `${container}:/tmp/asistonto-fixture.psql`);
  psql('-f', '/tmp/asistonto-000-stubs.sql');
  // Same auth helpers as the Supabase platform (claim.sub first, then the claims JSON).
  psql('-c', `create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'); $$;`);
  psql(...migrations.flatMap((_, index) => ['-f', `/tmp/asistonto-${String(index + 1).padStart(3, '0')}.sql`]));
  console.log(`PASS: cold chain applied ${migrations.length} migrations including 20261118210000_asistonto_api.sql`);
  const seeded = psql('-c', `insert into auth.users(id,email) values
      ('00000000-0000-0000-0000-000000000001','staff@pottery.local'),
      ('00000000-0000-0000-0000-000000000002','other@pottery.local'),
      ('00000000-0000-0000-0000-000000000003','reader@pottery.local');`,
    '-v', 'staff_id=00000000-0000-0000-0000-000000000001', '-v', 'other_id=00000000-0000-0000-0000-000000000002',
    '-v', 'reader_id=00000000-0000-0000-0000-000000000003',
    '-c', "set app.local_staging = 'pottery-gym-local-staging'", '-f', '/tmp/asistonto-seed.psql');
  console.log('PASS: unchanged local-staging seed installed with its own authorization checks');
  void seeded;
  const run = spawnSync('docker', ['exec', container, 'psql', '-X', '-w', '-U', 'postgres', '-h', '/var/run/postgresql',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/asistonto-fixture.psql'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const notices = `${run.stdout}\n${run.stderr}`;
  if (run.status !== 0) { process.stderr.write(notices); throw new Error('Asistonto SQL fixture failed'); }
  assert.match(notices, /ALL ASISTONTO API TESTS PASSED/);
  const sqlPasses = (notices.match(/NOTICE:\s+PASS: /g) || []).length;
  console.log(`PASS: ${sqlPasses} SQL assertions (grants, sede scope, PII, limits, roles, expiry, idempotency, capacity, W1/W2/W3, actor safety, audit)`);

  // ---- HTTP-level checks through the shipped handler ----
  const bundle = await build({ absWorkingDir: root, entryPoints: ['supabase/functions/_shared/asistonto-api.ts'], bundle: true,
    write: false, platform: 'node', format: 'esm' });
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const rpc = (fn, args) => {
    assert.ok(['asistonto_read', 'asistonto_write'].includes(fn));
    const argSql = fn === 'asistonto_read' ? `:'sede'::uuid, :'op', :'params'::jsonb` : `:'sede'::uuid, :'actor', :'op', :'params'::jsonb`;
    try {
      const out = execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-h', '/var/run/postgresql',
        '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-v', `sede=${args.p_sede_id}`, '-v', `op=${args.p_op}`,
        '-v', `actor=${args.p_actor ?? ''}`, '-v', `params=${JSON.stringify(args.p_params)}`],
        { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          input: `set request.jwt.claims = '{"role":"service_role"}';\nset role service_role;\nselect public.${fn}(${argSql});\n` });
      return { data: JSON.parse(out.trim().split('\n').at(-1)), error: null };
    } catch (error) {
      const match = String(error.stderr).match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
      return { data: null, error: { code: match?.[1], message: match?.[2] } };
    }
  };
  const asistontoKey = randomBytes(32).toString('hex');
  const rioKey = randomBytes(32).toString('hex');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const env = { SUPABASE_URL: 'http://local.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
    BONOS_API_SEDE_ID: '30000000-0000-0000-0000-000000000001', ASISTONTO_KEY_SHA256: sha(asistontoKey),
    RIO_APPROVER_KEY_SHA256: sha(rioKey), ASISTONTO_WRITES_ENABLED: 'false' };
  const client = () => ({ rpc: async (fn, args) => rpc(fn, args) });
  const get = async (query, key = asistontoKey) => {
    const response = await api.handleRead(new Request(`http://local.invalid/asistonto-read?${query}`, { headers: { authorization: `Bearer ${key}` } }), n => env[n], client);
    httpChecks++; return { status: response.status, body: await response.json() };
  };
  const post = async (body, key = asistontoKey) => {
    const response = await api.handleWrite(new Request('http://local.invalid/asistonto-write', { method: 'POST',
      headers: { 'x-api-key': key }, body: JSON.stringify(body) }), n => env[n], client);
    httpChecks++; return { status: response.status, body: await response.json() };
  };
  const today = new Date().toISOString().slice(0, 10);
  const reads = [await get('op=bonos'), await get('op=bonos&code=STAGING-TEMP'), await get(`op=calendario&from=${today}`),
    await get('op=clases'), await get('op=alumnos&q=alex'), await get('op=alumno&id=10000000-0000-0000-0000-000000000001')];
  reads.forEach(read => assert.equal(read.status, 200, JSON.stringify(read.body)));
  assert.doesNotMatch(JSON.stringify(reads), /@|email|phone|buyer|notes|internal|metadata|dedication|birth|observ|price/i, 'HTTP reads carry no PII');
  assert.equal((await get('op=bonos&code=NOPE-0000')).status, 404);
  assert.equal((await get('op=calendario&from=2026-01-01&to=2026-03-01')).status, 400);
  assert.equal((await get('op=bonos', randomBytes(32).toString('hex'))).status, 401);
  assert.equal((await post({ op: 'draft', kind: 'student.create', payload: { name: 'PRUEBA RIO – no usar' } })).status, 403, 'write gate off');
  env.ASISTONTO_WRITES_ENABLED = 'true';
  const draft = await post({ op: 'draft', kind: 'bono.create', payload: { recipient: 'PRUEBA RIO – no usar', numClasses: 1 } });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const draftId = draft.body.data.draftId;
  assert.equal((await post({ op: 'commit', draftId })).status, 403, 'commit before approval');
  assert.equal((await post({ op: 'approve', draftId, approvalRef: 'http-t1u' })).status, 403, 'asistonto cannot approve');
  assert.equal((await post({ op: 'approve', draftId, approvalRef: 'http-t1u' }, rioKey)).status, 200);
  const commit = await post({ op: 'commit', draftId });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.data.result.bono.recipient, 'PRUEBA RIO – no usar');
  const replay = await post({ op: 'commit', draftId }, rioKey);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.data.result.bono.id, commit.body.data.result.bono.id);
  const book = await post({ op: 'draft', kind: 'session.book', payload: { sessionId: '20000000-0000-0000-0000-000000000001', studentId: '10000000-0000-0000-0000-000000000004' } });
  assert.equal(book.status, 409, 'full session via HTTP');
  const count = psql('-qAt', '-c', `select count(*) from public.gift_cards where external_reference = 'asistonto:${draftId}'`).trim();
  assert.equal(count, '1');
  psql('-c', `set request.jwt.claims = '{"role":"service_role"}'; set role service_role; select public.external_cancel_gift_card('30000000-0000-0000-0000-000000000001', id) from public.gift_cards where external_reference = 'asistonto:${draftId}'`);
  console.log(`PASS: ${httpChecks} HTTP-level checks through the shipped handler (401/403/404/409, gate, approve, idempotent commit, no PII)`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
}
