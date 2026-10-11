import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// No DB_URL, remote hosts, existing containers, ports, or persisted volumes.
// Both baselines are read-only schema observations, never connections.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const asyncExec = promisify(execFile);
const name = `gift-integrity-${randomUUID()}`;
const baseline = process.argv.includes('--observed-baseline')
  ? 'supabase/.temp/baseline-schema.sql' : 'supabase/migrations/20260101000000_initial_schema.sql';
let container;
try {
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/, 'A local postgres:17 image is required; never pull');
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    image, 'postgres', '-c', 'listen_addresses=').trim();
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', container, 'bash', '-c', 'read -r process </proc/1/comm; [[ "$process" == postgres ]]');
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-h', '/var/run/postgresql');
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, 'Fresh disposable database did not become ready');
  for (const [source, target] of [
    [baseline, 'gift-baseline.sql'],
    ['supabase/migrations/20261011092140_student_membership_periods.sql', 'gift-membership.sql'],
    ['supabase/migrations/20261011200000_gift_card_integrity.sql', 'gift-integrity.sql'],
    ['supabase/tests/gift_card_integrity.fixture.psql', 'gift-fixture.psql']
  ]) docker('cp', fileURLToPath(new URL(`../../${source}`, import.meta.url)), `${container}:/tmp/${target}`);
  const psql = ['exec', container, 'psql', '-X', '-w', '-U', 'postgres', '-h', '/var/run/postgresql',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  const fixture = await asyncExec('docker', [...psql, '-f', '/tmp/gift-fixture.psql'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(fixture.stdout);
  process.stdout.write(fixture.stderr);
  const query = async sql => {
    const result = await asyncExec('docker', [...psql, '-c', sql], { cwd: root, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stderr);
    return result.stdout;
  };
  const transaction = (card, session, key) => `begin; set local role authenticated;
    set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    select public.redeem_gift_card_session_once('40000000-0000-0000-0000-${card}',
      '20000000-0000-0000-0000-${session}','10000000-0000-0000-0000-000000000002',
      '60000000-0000-0000-0000-${key}'); select pg_sleep(0.5); commit;`;
  await Promise.all([query(transaction('000000000013','000000000013','000000000013')),
    query(transaction('000000000013','000000000013','000000000013'))]);
  await query(`select public.gift_test_assert(sessions_used=1,'concurrent identical receipt debits once')
    from public.gift_cards where id='40000000-0000-0000-0000-000000000013';
    select public.gift_test_assert(count(*)=1,'concurrent identical request preserves one receipt')
    from public.gift_card_operation_receipts where gift_card_id='40000000-0000-0000-0000-000000000013';`);
  const competing = await Promise.allSettled([
    query(transaction('000000000014','000000000014','000000000014')),
    query(transaction('000000000014','000000000015','000000000015'))
  ]);
  assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
  const failure = competing.find(result => result.status === 'rejected');
  assert.match(failure.reason.stderr, /El bono no tiene sesiones disponibles/);
  await query(`select public.gift_test_assert(sessions_used=1,'competing final-session claims cannot overspend')
    from public.gift_cards where id='40000000-0000-0000-0000-000000000014';
    select public.gift_test_assert(count(*)=1,'losing claim leaves no movement') from public.gift_card_movements
    where gift_card_id='40000000-0000-0000-0000-000000000014';`);
  const sameEnrollment = await Promise.allSettled([
    query(transaction('000000000022','000000000002','000000000040')),
    query(transaction('000000000023','000000000002','000000000041'))
  ]);
  assert.equal(sameEnrollment.filter(result => result.status === 'rejected').length, 1);
  assert.match(sameEnrollment.find(result => result.status === 'rejected').reason.stderr, /Session is not linked/);
  await query(`select public.gift_test_assert(sum(sessions_used)=1,'one enrollment cannot spend two different cards')
    from public.gift_cards where id in ('40000000-0000-0000-0000-000000000022','40000000-0000-0000-0000-000000000023');
    select public.gift_test_assert(count(*)=1,'losing enrollment race rolls back its entire receipt and ledger')
    from public.gift_card_operation_receipts where request_key in
    ('60000000-0000-0000-0000-000000000040','60000000-0000-0000-0000-000000000041');`);
  console.log(`PASS: ${baseline}, existing membership + gift follow-up, identity, history, authorization, receipts and concurrency`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
}
