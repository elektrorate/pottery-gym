import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Dedicated ephemeral, socket-only database; never use an existing DB or pull.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const exec = promisify(execFile);
let container;
let sqlChecks = 0;
let deniedCalls = 0;
try {
  assert.match(docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}').trim(), /^(npipe:|unix:)/,
    'Refusing a remote Docker context');
  if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^(npipe:|unix:)/, 'Refusing a remote DOCKER_HOST');
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/);
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', `session-business-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image,
    'postgres', '-c', 'listen_addresses=').trim();
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', container, 'bash', '-c', 'read -r process </proc/1/comm; [[ "$process" == postgres ]]');
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-h', '/var/run/postgresql');
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, 'Disposable database did not become ready');
  for (const [source, target] of [
    ['supabase/migrations/20260101000000_initial_schema.sql', 'atomic-baseline.sql'],
    ['supabase/migrations/20261011092140_student_membership_periods.sql', 'atomic-membership.sql'],
    ['supabase/migrations/20261011200000_gift_card_integrity.sql', 'atomic-gift.sql'],
    ['supabase/migrations/20261011220000_atomic_session_operations.sql', 'atomic-operations.sql'],
    ['supabase/tests/atomic_session_operations.fixture.psql', 'atomic-fixture.psql'],
    ['supabase/migrations/20261011210000_authorized_read_api.sql', 'business-read.sql'],
    ['supabase/migrations/20261011230000_session_business_policy.sql', 'business-policy.sql'],
    ['supabase/tests/session_business_policy.fixture.psql', 'business-fixture.psql']
  ]) docker('cp', fileURLToPath(new URL(`../../${source}`, import.meta.url)), `${container}:/tmp/${target}`);
  const psql = ['exec', container, 'psql', '-X', '-w', '-q', '-A', '-t', '-U', 'postgres', '-h', '/var/run/postgresql', '-v', 'ON_ERROR_STOP=1'];
  const run = async (args, database = 'postgres') => {
    const result = await exec('docker', [...psql, '-d', database, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    sqlChecks += (result.stderr.match(/NOTICE:\s+PASS:/g) ?? []).length;
    deniedCalls += (result.stderr.match(/NOTICE:\s+PASS: reject:/g) ?? []).length;
    process.stdout.write(result.stdout); process.stdout.write(result.stderr);
    return result;
  };
  const fixture = await run(['-f', '/tmp/business-fixture.psql']);
  const legacyChecks = (fixture.stderr.match(/psql:\/tmp\/atomic-fixture\.psql:\d+: NOTICE:\s+PASS:/g) ?? []).length;
  const businessChecks = sqlChecks - legacyChecks;
  const query = sql => run(['-c', sql]);
  const auth = `set local role authenticated; set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    set local request.jwt.claim.role='authenticated';`;
  const reservation = (session, student, key) => `begin; ${auth}
    select public.save_session_reservation(public.business_id(2,${session}),public.business_id(6,${key}),0,
      public.business_id(3,1),public.business_metadata(20,12,1),array[public.business_id(1,${student})],'{}');
    select pg_sleep(0.3); commit;`;
  const seat = await Promise.allSettled([query(reservation(40, 20, 40)), query(reservation(40, 21, 41))]);
  assert.equal(seat.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(seat.find(x => x.status === 'rejected').reason.stderr, /Stale session revision/);
  await query(`select public.atomic_assert(count(*)=1,'policy2 final-seat race keeps one receipt')
    from public.session_operation_receipts where session_id=public.business_id(2,40);`);
  const conflict = await Promise.allSettled([query(reservation(41, 22, 42)), query(reservation(42, 22, 43))]);
  assert.equal(conflict.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(conflict.find(x => x.status === 'rejected').reason.stderr, /Student already reserved in an overlapping session/);
  const finalize = key => `begin; ${auth}
    select public.save_session_attendance(public.business_id(2,39),public.business_id(6,${key}),1,
      public.business_attendance(23,'absent'),true,null); select pg_sleep(0.3); commit;`;
  const identical = await Promise.all([query(finalize(44)), query(finalize(44))]);
  assert.ok(identical.some(x => x.stdout.includes('"replayed": true')));
  await query(`select public.atomic_assert(count(*)=1,'concurrent finalize charges exactly once') from public.session_credit_movements
    where session_id=public.business_id(2,39);
    select public.atomic_assert(classes_remaining=3,'concurrent no-show has one financial effect') from public.students where id=public.business_id(1,23);`);
  const lastCredit = (session, key) => `begin; ${auth}
    select public.save_session_attendance(public.business_id(2,${session}),public.business_id(6,${key}),1,
      public.business_attendance(24,'absent'),true,null); select pg_sleep(0.3); commit;`;
  await Promise.all([query(lastCredit(43,45)), query(lastCredit(44,46))]);
  await query(`select public.atomic_assert(classes_remaining=0,'different-parent no-shows cannot overspend final membership credit')
      from public.students where id=public.business_id(1,24);
    select public.atomic_assert(count(*) filter(where state='charged')=1 and count(*) filter(where state='pending')=1,
      'losing membership credit creates one durable pending incident, never a negative debit')
      from public.session_business_penalties where session_id in(public.business_id(2,43),public.business_id(2,44));`);
  const giftFinal = (session, key) => `begin; ${auth}
    select public.save_session_attendance(public.business_id(2,${session}),public.business_id(6,${key}),1,
      public.business_attendance(25,'present'),true,null); select pg_sleep(0.3); commit;`;
  const gift = await Promise.allSettled([query(giftFinal(45,47)), query(giftFinal(46,48))]);
  assert.equal(gift.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(gift.find(x => x.status === 'rejected').reason.stderr, /Presence requires valid original credit/);
  await query(`select public.atomic_assert(sessions_used=1,'different-parent presence cannot overspend final gift credit')
      from public.gift_cards where id=public.business_id(4,3);
    select public.atomic_assert(count(*)=1,'losing gift presence leaves no charge or partial funding receipt') from public.session_credit_movements
      where session_id in(public.business_id(2,45),public.business_id(2,46));
    select public.atomic_assert(classes_remaining=4,'gift race never falls back to available membership credit')
      from public.students where id=public.business_id(1,25);`);
  console.log(`PASS: ${sqlChecks} SQL assertions (${legacyChecks} legacy, ${businessChecks} business, ${sqlChecks - legacyChecks - businessChecks} race assertions; ${deniedCalls} expected denials), plus 5 concurrent scenarios`);

  // A separate cold database in this same disposable, networkless container
  // catches migration-order and real seed drift hidden by the focused fixture.
  const migrations = readdirSync(fileURLToPath(new URL('../../supabase/migrations/', import.meta.url)))
    .filter(name => /^\d+_.*\.sql$/.test(name)).map(name => `supabase/migrations/${name}`).sort();
  assert.ok(migrations.includes('supabase/migrations/20261011230000_session_business_policy.sql'));
  for (const source of migrations) docker('cp', fileURLToPath(new URL(`../../${source}`, import.meta.url)), `${container}:/tmp/cold-${source.split('/').at(-1)}`);
  docker('cp', fileURLToPath(new URL('../../local-staging/seed.psql', import.meta.url)), `${container}:/tmp/cold-seed.psql`);
  await query('create database business_cold;');
  await run(['-c', `create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
    $$;
    create function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role');
    $$;
    grant usage on schema auth to anon,authenticated,service_role;`], 'business_cold');
  await run(migrations.flatMap(source => ['-f', `/tmp/cold-${source.split('/').at(-1)}`]), 'business_cold');
  console.log(`PASS: cold full chain applied ${migrations.length} workspace migrations in a second disposable database`);
  await run(['-c', `insert into auth.users(id,email) values
    ('00000000-0000-0000-0000-000000000001','staff@pottery.local'),
    ('00000000-0000-0000-0000-000000000002','other@pottery.local'),
    ('00000000-0000-0000-0000-000000000003','reader@pottery.local');`,
    '-v', 'staff_id=00000000-0000-0000-0000-000000000001', '-v', 'other_id=00000000-0000-0000-0000-000000000002',
    '-v', 'reader_id=00000000-0000-0000-0000-000000000003',
    '-c', "set app.local_staging = 'pottery-gym-local-staging'", '-f', '/tmp/cold-seed.psql'], 'business_cold');
  console.log('PASS: unchanged local-staging seed and its authorization assertions on the cold full migration chain');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  else process.stderr.write(`${error.message}\n`);
  throw new Error('Session business policy test failed; database output is shown above.');
} finally {
  if (container) docker('rm', '-f', container);
}
