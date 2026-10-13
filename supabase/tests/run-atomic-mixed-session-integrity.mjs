import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.MIXED_SESSION_TEST_OUTPUT || 'C:\\Users\\elekt\\AppData\\Local\\Temp\\opencode';
assert.ok(existsSync(output), 'Output parent must exist');
const temporary = join(output, `atomic-mixed-${randomUUID()}`);
mkdirSync(temporary);
const log = join(output, 'atomic-mixed-test-output.log');
writeFileSync(log, 'Isolated PostgreSQL 17 atomic mixed-session integrity output\n');
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const exec = promisify(execFile);
const mixedFiles = [
  '20261012170342_session_activity_blocks.sql', '20261012183339_complete_mixed_sessions.sql',
  '20261012183604_patch_mixed_policy_functions.sql', '20261012190513_optimize_calendar_loading_indexes.sql',
  '20261013052806_optimize_session_students_calendar_read.sql'
];
const migration = '20261013060000_atomic_mixed_session_integrity.sql';
let container; let image; let assertions = 0; let denials = 0; let races = 0; let raceRejections = 0;
const capture = result => {
  appendFileSync(log, result.stdout + result.stderr);
  assertions += (result.stderr.match(/NOTICE:\s+PASS:/g) || []).length;
  denials += (result.stderr.match(/NOTICE:\s+PASS: reject:/g) || []).length;
  process.stderr.write(result.stderr.replace(/^.*NOTICE:\s+PASS:.*\r?\n/gm, ''));
  return result;
};
try {
  assert.match(docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}').trim(), /^(npipe:|unix:)/);
  if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^(npipe:|unix:)/);
  image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/);
  container = docker('run', '-d', '--pull=never', '--network=none', '--label', 'opencode.test=atomic-mixed-session-integrity',
    '--name', `atomic-mixed-${randomUUID()}`, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    image, 'postgres', '-c', 'listen_addresses=').trim();
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', container, 'bash', '-c', 'read -r process </proc/1/comm; [[ "$process" == postgres ]]');
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-h', '/var/run/postgresql');
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready);
  const version = docker('exec', container, 'psql', '-X', '-U', 'postgres', '-Atc', 'show server_version;').trim();
  assert.match(version, /^17\./);
  console.log(`PostgreSQL ${version}; networkless socket-only container ${container}`);
  const copy = (source, target) => docker('cp', join(root, source), `${container}:/tmp/${target}`);
  for (const [source, target] of [
    ['supabase/migrations/20260101000000_initial_schema.sql', 'atomic-baseline.sql'],
    ['supabase/migrations/20261011092140_student_membership_periods.sql', 'atomic-membership.sql'],
    ['supabase/migrations/20261011200000_gift_card_integrity.sql', 'atomic-gift.sql'],
    ['supabase/migrations/20261011220000_atomic_session_operations.sql', 'atomic-operations.sql'],
    ['supabase/tests/atomic_session_operations.fixture.psql', 'atomic-fixture.psql'],
    ['supabase/migrations/20261011210000_authorized_read_api.sql', 'business-read.sql'],
    ['supabase/migrations/20261011230000_session_business_policy.sql', 'business-policy.sql'],
    ['supabase/tests/session_business_policy.fixture.psql', 'business-fixture.psql'],
    ['supabase/migrations/20261012090000_manual_credit_reconciliation_settlement.sql', 'manual-policy.sql'],
    ['supabase/tests/manual_credit_reconciliation_settlement.fixture.psql', 'manual-fixture.psql'],
    [`supabase/migrations/${migration}`, 'atomic-mixed.sql'],
    ['supabase/tests/atomic_mixed_session_integrity.fixture.psql', 'atomic-mixed-fixture.psql']
  ]) copy(source, target);
  mixedFiles.forEach((name, i) => copy(`supabase/migrations/${name}`, `mixed-${i + 1}.sql`));
  const psql = ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=15000', container,
    'psql', '-X', '-w', '-q', '-A', '-t', '-U', 'postgres', '-h', '/var/run/postgresql', '-v', 'ON_ERROR_STOP=1'];
  const run = async (args, database = 'postgres') => {
    appendFileSync(log, `\nSQL ${JSON.stringify(args)}\n`);
    try { return capture(await exec('docker', [...psql, '-d', database, ...args], { cwd: root, maxBuffer: 32 * 1024 * 1024 })); }
    catch (error) { appendFileSync(log, `${error.stdout || ''}${error.stderr || error.message}\n`); throw error; }
  };
  await run(['-f', '/tmp/business-fixture.psql']);
  await run(['-f', '/tmp/manual-fixture.psql']);
  const before = { assertions, denials };
  await run(['-f', '/tmp/atomic-mixed-fixture.psql']);
  const mixedCounts = { assertions: assertions - before.assertions, expectedDenials: denials - before.denials };
  console.log(`PASS: mixed integrity fixture: ${mixedCounts.assertions} SQL assertions (${mixedCounts.expectedDenials} expected denials)`);
  const identity = "set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001'; set request.jwt.claim.role='authenticated';";
  const query = sql => run(['-c', identity + sql]);
  const tx = sql => query(`begin; set local role authenticated; ${sql}; select pg_sleep(0.2); commit;`);
  const block = `(select id from public.session_activity_blocks where session_id=public.business_id(2,530) and activity_type='mesa')`;
  const empty = `(select id from public.session_activity_blocks where session_id=public.business_id(2,530) and activity_type='torno')`;
  const seat = student => tx(`select public.mix_save(530,${student},1,array[530,${student}],jsonb_build_array(
    public.mix_block('mesa',null,1,array[530,${student}],${block}),public.mix_block('torno',null,1,'{}',${empty})),'{}','{}',20)`);
  const overbooked = await Promise.allSettled([seat(531), seat(532)]); races++;
  assert.equal(overbooked.filter(x => x.status === 'fulfilled').length, 0);
  for (const result of overbooked) assert.match(result.reason.stderr, /Activity block capacity exceeded/);
  raceRejections += 2;
  await query(`select public.atomic_assert(revision=1,'independent block overbooking attempts never consume global spare capacity')
    from public.sessions where id=public.business_id(2,530);`);
  const edit = key => tx(`select public.mix_save(530,${key},1,array[530],jsonb_build_array(
    public.mix_block('mesa',null,1,array[530],${block}),public.mix_block('torno',null,1,'{}',${empty})),'{}','{}',20)`);
  const same = await Promise.all([edit(800), edit(800)]); races++;
  assert.ok(same.some(x => x.stdout.includes('"replayed": true')));
  const parallel = await Promise.allSettled([
    tx(`select public.mix_save(530,801,2,array[530,531],jsonb_build_array(public.mix_block('mesa',null,1,array[530],${block}),
      public.mix_block('torno',null,1,array[531],${empty})),'{}','{}',20)`),
    tx(`select public.mix_save(530,802,2,array[530,532],jsonb_build_array(public.mix_block('mesa',null,1,array[530],${block}),
      public.mix_block('torno',null,1,array[532],${empty})),'{}','{}',20)`)
  ]); races++;
  assert.equal(parallel.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(parallel.find(x => x.status === 'rejected').reason.stderr, /Stale session revision/); raceRejections++;
  const finals = await Promise.all([tx("select public.mix_attend(533,803,1,array[533],array['present'])"),
    tx("select public.mix_attend(533,803,1,array[533],array['present'])")]); races++;
  assert.ok(finals.some(x => x.stdout.includes('"replayed": true')));
  await query(`select public.atomic_assert(count(*)=1,'duplicate mixed finalization has one original debit')
    from public.session_credit_movements where session_id=public.business_id(2,533);
    select public.atomic_assert(count(*)=0,'no atomic writer capability leaks after race commits') from private.mixed_session_writers;`);

  // Execute the complete previous runner in a generated disposable adapter. Only
  // additive roster shape and reservation arity expectations are adapted; no behavioral assertion changes.
  const replaceOnce = (text, from, to) => { assert.ok(text.includes(from), `Adapter anchor missing: ${from}`); return text.replace(from, to); };
  const includes = mixedFiles.map((_, i) => `\\i /tmp/mixed-${i + 1}.sql`).concat('\\i /tmp/atomic-mixed.sql').join('\n');
  let manual = readFileSync(join(root, 'supabase/tests/manual_credit_reconciliation_settlement.fixture.psql'), 'utf8');
  manual = replaceOnce(manual, '\\i /tmp/manual-policy.sql', `\\i /tmp/manual-policy.sql\n${includes}`);
  manual = replaceOnce(manual, 'pronargs=8 and pronargdefaults=2', 'pronargs=9 and pronargdefaults=3');
  manual = manual.replaceAll("to_jsonb(t)-'manual_credit_id' from public.session_students t", "to_jsonb(t)-array['manual_credit_id','activity_type'] from public.session_students t");
  const adaptedFixture = join(temporary, 'manual-adapted.psql'); writeFileSync(adaptedFixture, manual);
  let previous = readFileSync(join(root, 'supabase/tests/run-manual-credit-reconciliation-settlement.mjs'), 'utf8');
  previous = replaceOnce(previous, "const root = fileURLToPath(new URL('../../', import.meta.url));", `const root = ${JSON.stringify(root)};`);
  previous = replaceOnce(previous, "const path = source => fileURLToPath(new URL(`../../${source}`, import.meta.url));",
    `const path = source => source === 'supabase/tests/manual_credit_reconciliation_settlement.fixture.psql' ? ${JSON.stringify(adaptedFixture)} : join(root, source);`);
  previous = replaceOnce(previous, "['supabase/tests/manual_credit_reconciliation_settlement.fixture.psql', 'manual-fixture.psql']",
    "['supabase/tests/manual_credit_reconciliation_settlement.fixture.psql', 'manual-fixture.psql'],\n" +
    mixedFiles.map((name, i) => `['supabase/migrations/${name}', 'mixed-${i + 1}.sql']`).concat(`['supabase/migrations/${migration}', 'atomic-mixed.sql']`).join(',\n'));
  previous = replaceOnce(previous, "'business_exception_id','manual_credit_id']", "'business_exception_id','manual_credit_id','activity_type']");
  previous = replaceOnce(previous, "'p_student_ids','p_gift_card_ids','p_manual_credit_ids']", "'p_student_ids','p_gift_card_ids','p_manual_credit_ids','p_activity_blocks']");
  previous = previous.replaceAll('public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb)',
    'public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb,jsonb)');
  previous = replaceOnce(previous, "await input(business, 'manual_policy_regression');",
    `business = business.replace('\\\\i /tmp/manual-policy.sql', ${JSON.stringify(`\\i /tmp/manual-policy.sql\n${includes}`)});\n  await input(business, 'manual_policy_regression');`);
  previous = replaceOnce(previous, "'--network=none', '--name'", "'--network=none', '--label', 'opencode.test=atomic-mixed-regression', '--name'");
  previous = replaceOnce(previous,
    "const migrations = readdirSync(path('supabase/migrations')).filter(name => /^\\d+_.*\\.sql$/.test(name)).sort();",
    `const migrations = readdirSync(path('supabase/migrations')).filter(name => /^\\d+_.*\\.sql$/.test(name) && name <= '${migration}').sort();`);
  const adaptedRunner = join(temporary, 'previous-regression.mjs'); writeFileSync(adaptedRunner, previous);
  const regression = await exec(process.execPath, [adaptedRunner], { cwd: root, env: { ...process.env, MANUAL_CREDIT_TEST_OUTPUT: temporary }, maxBuffer: 32 * 1024 * 1024 });
  appendFileSync(log, '\nFULL PREVIOUS REGRESSION WITH MIXED FOLLOW-UP ACTIVE\n' + regression.stdout + regression.stderr);
  process.stdout.write(regression.stdout); process.stderr.write(regression.stderr);
  const previousCounts = JSON.parse(readFileSync(join(temporary, 'manual-credit-test-summary.json'), 'utf8'));
  assert.equal(previousCounts.assertions, 837);
  assert.equal(previousCounts.migrations, 30);
  // Later, independently authored business-rule migrations are not structural
  // adapters for the 837-case historical-preservation suite. Compile all of them
  // in a separate empty cold database without weakening those old assertions.
  const workspaceMigrations = readdirSync(join(root, 'supabase/migrations')).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  for (const name of workspaceMigrations) copy(`supabase/migrations/${name}`, `workspace-${name}`);
  await run(['-c', 'create database atomic_mixed_workspace_cold;']);
  await run(['-c', `create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'');$$;
    grant usage on schema auth to anon,authenticated,service_role;`], 'atomic_mixed_workspace_cold');
  await run(workspaceMigrations.flatMap(name => ['-f', `/tmp/workspace-${name}`]), 'atomic_mixed_workspace_cold');
  await run(['-c', `insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000001','mixed-cold@example.invalid');
    insert into public.profiles(id,email,role) values('00000000-0000-0000-0000-000000000001','mixed-cold@example.invalid','tallerista');
    insert into public.sedes(id,name,slug,owner_id) values('39000000-0000-0000-0000-000000000600','Atomic mixed cold','atomic-mixed-cold','00000000-0000-0000-0000-000000000001');
    ${identity} set role authenticated;
    do $$declare r jsonb; begin
      r:=public.save_session_reservation('29000000-0000-0000-0000-000000000600',gen_random_uuid(),0,'39000000-0000-0000-0000-000000000600',
        jsonb_build_object('date',private.membership_today()::text,'start_time',private.membership_today()::text||'T18:00:00Z',
          'end_time',private.membership_today()::text||'T19:00:00Z','class_type','mixto','teacher_id',null),
        '{}'::uuid[],'{}','{}','[{"activity_type":"mesa","teacher_id":null,"capacity":1,"student_ids":[]}]');
      if jsonb_array_length(r->'activity_blocks')<>1 or r->'session'->>'capacity'<>'1' then raise exception 'Cold mixed RPC contract failed'; end if;
      raise notice 'PASS: all-workspace cold chain compiles and atomically reserves explicit mixed blocks without financial or reader changes';
    end $$;`], 'atomic_mixed_workspace_cold');
  const schema = await query(`select jsonb_build_object('rpc_signatures',(select jsonb_agg(jsonb_build_object('name',proname,
    'arguments',pg_get_function_arguments(oid),'returns',pg_get_function_result(oid)) order by proname) from pg_proc
    where pronamespace='public'::regnamespace and proname in('save_session_reservation','save_session_attendance','approve_session_exception',
      'cancel_session_reservation','waive_session_penalty','approve_student_manual_credit','settle_student_penalty')),
    'columns',(select jsonb_agg(jsonb_build_object('schema',table_schema,'relation',table_name,'column',column_name,
      'type',data_type,'nullable',is_nullable,'default',column_default,'ordinal',ordinal_position) order by table_schema,table_name,ordinal_position)
      from information_schema.columns where (table_schema='public' and table_name in('session_activity_blocks','session_activity_block_students',
        'session_activity_business_state','session_credit_activity_state','session_students'))
        or (table_schema='private' and table_name in('mixed_session_writers','mixed_session_reservations'))),
    'example_reservation',(select result from public.session_operation_receipts where session_id=public.business_id(2,500) and operation='reservation'),
    'example_financial_activity',(select jsonb_agg(to_jsonb(v)) from public.session_credit_activity_state v where session_id=public.business_id(2,500)));`);
  writeFileSync(join(output, 'atomic-mixed-contract.json'), JSON.stringify(JSON.parse(schema.stdout.trim()), null, 2) + '\n');
  const summary = { version, image, ownAssertions: assertions, ownExpectedDenials: denials, mixedFixture: mixedCounts,
    mixedRaces: races, expectedRaceRejections: raceRejections, previousRegression: previousCounts,
    totalSqlAssertions: assertions + previousCounts.assertions, workspaceColdMigrations: workspaceMigrations.length,
    policyBoundary: migration };
  writeFileSync(join(output, 'atomic-mixed-test-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`PASS: ${assertions} own SQL assertions (${denials} expected denials), ${races} mixed races, plus ${previousCounts.assertions} prior assertions with follow-up active; 30-migration policy boundary and ${workspaceMigrations.length}-migration workspace cold chain`);
  console.log(`Full output: ${log}\nContract: ${join(output, 'atomic-mixed-contract.json')}`);
} catch (error) {
  appendFileSync(log, `FAIL\n${error.stdout || ''}${error.stderr || error.stack || error.message}\n`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (container) {
    assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "opencode.test"}}').trim(), 'atomic-mixed-session-integrity');
    assert.equal(docker('inspect', container, '--format', '{{.Image}}').trim(), image);
    docker('rm', '-f', container);
  }
}
