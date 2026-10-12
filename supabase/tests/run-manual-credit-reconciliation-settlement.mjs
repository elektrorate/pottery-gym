import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Never connect to a current database, publish ports, pull images, or use a remote daemon.
const root = fileURLToPath(new URL('../../', import.meta.url));
const path = source => fileURLToPath(new URL(`../../${source}`, import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const exec = promisify(execFile);
const migration = '20261012090000_manual_credit_reconciliation_settlement.sql';
let container;
let assertions = 0;
let denials = 0;
let races = 0;
let policyRaces = 0;
let raceRejections = 0;
const outputDirectory = process.env.MANUAL_CREDIT_TEST_OUTPUT;
if (outputDirectory) assert.ok(existsSync(outputDirectory), 'Test output parent must already exist');
const outputLog = outputDirectory && join(outputDirectory, 'manual-credit-test-output.log');
if (outputLog) writeFileSync(outputLog, 'Isolated PostgreSQL 17 manual credit / settlement test output\n');
const phases = [];
const phase = (name, before) => {
  const counts = { name, assertions: assertions - before.assertions, expectedDenials: denials - before.denials };
  phases.push(counts);
  const line = `PASS: ${name}: ${counts.assertions} SQL assertions (${counts.expectedDenials} expected denials)`;
  console.log(line);
  if (outputLog) appendFileSync(outputLog, line + '\n');
};
const counts = () => ({ assertions, denials });
const capture = result => {
  assertions += (result.stderr.match(/NOTICE:\s+PASS:/g) ?? []).length;
  denials += (result.stderr.match(/NOTICE:\s+PASS: reject:/g) ?? []).length;
  if (outputLog) appendFileSync(outputLog, result.stdout + result.stderr);
  if (process.env.MANUAL_CREDIT_TEST_VERBOSE === '1') {
    process.stdout.write(result.stdout);
    process.stdout.write(result.stderr);
  } else {
    process.stderr.write(result.stderr.replace(/^.*NOTICE:\s+PASS:.*\r?\n/gm, ''));
  }
  return result;
};
try {
  assert.match(docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}').trim(), /^(npipe:|unix:)/);
  if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^(npipe:|unix:)/);
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/);
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', `manual-credit-${randomUUID()}`,
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
  assert.ok(ready, 'Disposable PostgreSQL did not become ready');
  for (const [source, target] of [
    ['supabase/migrations/20260101000000_initial_schema.sql', 'atomic-baseline.sql'],
    ['supabase/migrations/20261011092140_student_membership_periods.sql', 'atomic-membership.sql'],
    ['supabase/migrations/20261011200000_gift_card_integrity.sql', 'atomic-gift.sql'],
    ['supabase/migrations/20261011220000_atomic_session_operations.sql', 'atomic-operations.sql'],
    ['supabase/tests/atomic_session_operations.fixture.psql', 'atomic-fixture.psql'],
    ['supabase/migrations/20261011210000_authorized_read_api.sql', 'business-read.sql'],
    ['supabase/migrations/20261011230000_session_business_policy.sql', 'business-policy.sql'],
    ['supabase/tests/session_business_policy.fixture.psql', 'business-fixture.psql'],
    [`supabase/migrations/${migration}`, 'manual-policy.sql'],
    ['supabase/tests/manual_credit_reconciliation_settlement.fixture.psql', 'manual-fixture.psql']
  ]) docker('cp', path(source), `${container}:/tmp/${target}`);
  const version = docker('exec', container, 'psql', '-X', '-U', 'postgres', '-Atc', 'show server_version;').trim();
  assert.match(version, /^17\./);
  console.log(`PostgreSQL ${version}; isolated socket-only container ${container}`);
  const psql = ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=15000', container,
    'psql', '-X', '-w', '-q', '-A', '-t', '-U', 'postgres', '-h', '/var/run/postgresql', '-v', 'ON_ERROR_STOP=1'];
  const run = async (args, database = 'postgres') => {
    if (outputLog) appendFileSync(outputLog, `\nSQL ${database}: ${JSON.stringify(args)}\n`);
    try {
      return capture(await exec('docker', [...psql, '-d', database, ...args],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
    } catch (error) {
      if (outputLog) appendFileSync(outputLog, `SQL rejected (checked by runner):\n${error.stdout ?? ''}${error.stderr ?? error.message}\n`);
      throw error;
    }
  };
  const input = (text, database) => new Promise((resolve, reject) => {
    const child = spawn('docker', [...psql, '-d', database], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(capture({ stdout, stderr })) : reject(Object.assign(new Error(`psql exited ${code}`), { stdout, stderr })));
    child.stdin.end(text);
  });
  const identity = "set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001'; set request.jwt.claim.role='authenticated';";
  const query = sql => run(['-c', identity + sql]);
  let before = counts();
  await run(['-f', '/tmp/business-fixture.psql']);
  phase('unchanged v1 / policy2 fixtures before manual migration', before);
  before = counts();
  await run(['-f', '/tmp/manual-fixture.psql']);
  phase('manual fixture and historical preservation', before);
  before = counts();
  const auth = `set local role authenticated; set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    set local request.jwt.claim.role='authenticated';`;
  const tx = sql => query(`begin; ${auth} ${sql} select pg_sleep(0.2); commit;`);
  const whileLocked = async (label, sourceLock, operation, release, restore, expected,
    actor = '00000000-0000-0000-0000-000000000001', verification = null) => {
    const fingerprint = (await query('select public.manual_financial_fingerprint();')).stdout.trim();
    const application = `manual-revocation-${randomUUID()}`;
    const blocker = spawn('docker', [...psql, '-d', 'postgres'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let releaseReady; let rejectReady;
    const ready = new Promise((resolve, reject) => { releaseReady = resolve; rejectReady = reject; });
    const closed = new Promise((resolve, reject) => {
      blocker.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('MANUAL_SOURCE_LOCKED')) releaseReady();
      });
      blocker.stderr.on('data', chunk => { stderr += chunk; });
      blocker.on('error', error => { rejectReady(error); reject(error); });
      blocker.on('close', code => {
        if (code === 0) resolve(capture({ stdout, stderr }));
        else {
          const error = Object.assign(new Error(`Lock holder exited ${code}`), { stdout, stderr });
          rejectReady(error); reject(error);
        }
      });
    });
    let worker;
    try {
      if (outputLog) appendFileSync(outputLog, `\nSynchronized lock scenario: ${label}\n`);
      blocker.stdin.write(`begin; ${sourceLock}; select 'MANUAL_SOURCE_LOCKED';\n`);
      await ready;
      worker = query(`set application_name='${application}'; begin; ${auth}
        set local request.jwt.claim.sub='${actor}'; ${operation}; commit;`)
        .then(result => ({ status: 'fulfilled', result }), error => ({ status: 'rejected', error }));
      let waiting = false;
      for (let i = 0; i < 50; i++) {
        const state = await query(`select exists(select 1 from pg_stat_activity
          where application_name='${application}' and wait_event_type='Lock');`);
        if (state.stdout.trim() === 't') { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(waiting, `${label}: actor must actually wait on the held source/student lock`);
      blocker.stdin.end(`${release}; commit;\n`);
      await closed;
      const outcome = await worker;
      if (expected) {
        assert.equal(outcome.status, 'rejected', `${label}: blocked operation must reject after release`);
        assert.match(outcome.error.stderr, expected);
        raceRejections++;
      } else assert.equal(outcome.status, 'fulfilled', `${label}: lock-order-safe operation must commit`);
      races++;
    } finally {
      if (!blocker.stdin.writableEnded) blocker.stdin.end('rollback;\n');
      await closed;
      if (worker) await worker;
      if (restore) await query(restore);
    }
    if (verification) await query(verification);
    else await query(`select public.atomic_assert(public.manual_financial_fingerprint()='${fingerprint}',
      '${label}: post-lock revocation preserves full financial/history fingerprint');`);
  };
  const finalize = (session, student, key, status = 'absent') => tx(`select public.save_session_attendance(public.business_id(2,${session}),
    public.business_id(6,${key}),1,public.business_attendance(${student},'${status}'),true,null);`);
  await Promise.all([finalize(120,120,620), finalize(121,120,621)]); races++;
  await query(`select public.atomic_assert(remaining_classes=0,'concurrent manual no-shows cannot overspend last class')
      from public.manual_credit_entitlements_with_balance where entitlement_id=public.manual_entitlement(120,120);
    select public.atomic_assert(count(*) filter(where state='charged')=1 and count(*) filter(where state='pending')=1,
      'last manual class yields one charge and one pending incident') from public.session_business_penalties
      where session_id in(public.business_id(2,120),public.business_id(2,121));`);
  const finals = await Promise.all([finalize(122,121,622,'present'), finalize(122,121,622,'present')]); races++;
  assert.ok(finals.some(result => result.stdout.includes('"replayed": true')));
  await query(`select public.atomic_assert(count(*)=1,'concurrent identical manual finalization has one debit')
    from public.session_credit_movements where session_id=public.business_id(2,122);`);
  const settled = await Promise.all([tx('select public.manual_settle(124,623,2);'), tx('select public.manual_settle(124,623,2);')]); races++;
  assert.ok(settled.some(result => result.stdout.includes('"replayed": true')));
  const distinct = await Promise.allSettled([tx('select public.manual_settle(126,624,2);'), tx('select public.manual_settle(126,625,2);')]); races++;
  assert.equal(distinct.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(distinct.find(result => result.status === 'rejected').reason.stderr, /Stale session revision/);
  raceRejections++;
  await query(`select public.atomic_assert(count(*)=1,'different settlement keys cannot settle same penalty twice')
    from public.student_penalty_settlements where session_id=public.business_id(2,126);`);
  const twoIncidents = await Promise.allSettled([tx('select public.manual_settle(128,626,2);'), tx('select public.manual_settle(129,627,2);')]); races++;
  assert.equal(twoIncidents.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(twoIncidents.find(result => result.status === 'rejected').reason.stderr, /Original incident source is not usable/);
  raceRejections++;
  await query(`select public.atomic_assert(remaining_classes=0,'concurrent distinct incidents cannot overspend same manual source')
    from public.manual_credit_entitlements_with_balance where entitlement_id=public.manual_entitlement(124,124);`);
  const reconcile = await Promise.allSettled([tx("select public.manual_approve(125,628,'reconcile_legacy',3,3);"),
    tx("select public.manual_approve(125,629,'reconcile_legacy',3,3);")]); races++;
  assert.equal(reconcile.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(reconcile.find(result => result.status === 'rejected').reason.stderr, /Legacy balance is already reconciled/);
  raceRejections++;
  await query(`select public.atomic_assert(count(*)=1,'concurrent legacy reconciliation cannot double-allocate')
    from public.student_manual_credit_entitlements where student_id=public.business_id(1,125) and mode='reconcile_legacy';`);
  const waivers = await Promise.all([tx(`select public.waive_session_penalty(public.business_id(2,124),public.business_id(1,122),
    public.business_id(6,630),3,'Concurrent settled manual waiver');`), tx(`select public.waive_session_penalty(public.business_id(2,124),public.business_id(1,122),
    public.business_id(6,630),3,'Concurrent settled manual waiver');`)]); races++;
  assert.ok(waivers.some(result => result.stdout.includes('"replayed": true')));
  await query(`select public.atomic_assert(remaining_classes=1,'concurrent post-settlement waiver restores exactly once')
    from public.manual_credit_entitlements_with_balance where entitlement_id=public.manual_entitlement(122,122);
    select public.atomic_assert(count(*)=1,'manual settlement reversal is unique') from public.session_credit_movements
    where session_id=public.business_id(2,124) and delta=1;`);
  const approvals = await Promise.all([tx("select public.manual_approve(127,631,'new_manual',2,0);"),
    tx("select public.manual_approve(127,631,'new_manual',2,0);")]); races++;
  assert.ok(approvals.some(result => result.stdout.includes('"replayed": true')));
  await query(`select public.atomic_assert(count(*)=1 and sum(quantity)=2,'concurrent identical manual approval allocates once')
    from public.student_manual_credit_entitlements where student_id=public.business_id(1,127);`);
  const resolution = await Promise.allSettled([tx('select public.manual_settle(140,632,2);'),
    tx(`select public.waive_session_penalty(public.business_id(2,140),public.business_id(1,126),
      public.business_id(6,633),2,'Owner resolves competing settlement by waiver');`)]); races++;
  assert.equal(resolution.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(resolution.find(result => result.status === 'rejected').reason.stderr, /Stale session revision/);
  raceRejections++;
  await query(`select public.atomic_assert((select remaining_classes from public.manual_credit_entitlements_with_balance
      where entitlement_id=public.manual_entitlement(126,126)) = case when settlement_id is null then 1 else 0 end
      and ((penalty_state='waived' and not is_pending and is_waived and settlement_id is null)
        or (penalty_state='charged' and not is_pending and not is_waived and settlement_id is not null)),
      'concurrent waiver/settlement has exactly one audited resolution and correct original balance')
      from public.session_pending_penalties where session_id=public.business_id(2,140);`);
  const transfer = "update public.sedes set owner_id=public.business_id(0,2) where id=public.business_id(3,1)";
  const restoreOwner = "update public.sedes set owner_id='00000000-0000-0000-0000-000000000001' where id=public.business_id(3,1)";
  await whileLocked('approval owner', 'select 1 from public.students where id=public.business_id(1,130) for update',
    "select public.manual_approve(130,730,'new_manual',1,0)", transfer, restoreOwner, /Only this workshop owner may approve manual credits/);
  await whileLocked('settlement owner', 'select 1 from public.student_manual_credit_entitlements where id=public.manual_entitlement(128,128) for update',
    'select public.manual_settle(142,731,2)', transfer, restoreOwner, /Only this workshop owner may settle penalties/);
  const manualLock = 'select 1 from public.student_manual_credit_entitlements where id=public.manual_entitlement(129,129) for update';
  await whileLocked('attendance employee', manualLock,
    "select public.save_session_attendance(public.business_id(2,143),public.business_id(6,732),1,public.business_attendance(129,'present'),true,null)",
    'delete from public.sede_members where sede_id=public.business_id(3,1) and user_id=public.business_id(0,1)',
    "insert into public.sede_members(sede_id,user_id,role) values(public.business_id(3,1),public.business_id(0,1),'staff')",
    /Session not accessible/, '01000000-0000-0000-0000-000000000001');
  await whileLocked('reservation owner', manualLock,
    'select public.manual_reserve(144,129,129,18,12)', transfer, restoreOwner, /Session not accessible/);
  await tx("select public.save_session_attendance(public.business_id(2,143),gen_random_uuid(),1,public.business_attendance(129,'absent'),true,null);");
  await whileLocked('waiver owner', manualLock,
    "select public.waive_session_penalty(public.business_id(2,143),public.business_id(1,129),public.business_id(6,733),2,'Revoked owner cannot waive')",
    transfer, restoreOwner, /Session not accessible/);
  await tx(`insert into public.students(id,sede_id,full_name,name,student_category,classes_remaining)
    select public.business_id(1,n),public.business_id(3,1),'Veto Race '||n,'Veto Race '||n,'temporal',
      case when n=181 then 0 else 4 end from generate_series(180,182) n;
    insert into public.gift_cards(id,sede_id,recipient,recipient_student_id,num_classes,type,activated_at,payment_status)
    select public.business_id(4,n),public.business_id(3,1),'Unrelated Race Stock '||n,public.business_id(1,181),4,'modelado',private.membership_today(),'paid'
      from unnest(array[180,182]) n;`);
  const associateAndErase = n => `update public.gift_cards set recipient_student_id=public.business_id(1,${n})
      where id=public.business_id(4,${n});
    update public.gift_cards set recipient_student_id=public.business_id(1,181),recipient='Erased Race Association ${n}',
      recipient_email='erased-${n}@example.invalid' where id=public.business_id(4,${n})`;
  const verifyVetoRace = n => `
    select public.atomic_assert(st.classes_remaining=4 and st.student_category='temporal' and st.payment_status is null
      and g.recipient_student_id=public.business_id(1,181) and g.num_classes=4 and g.sessions_used=0
      and not private.manual_gift_veto_match(g,st), 'gift race ${n}: only requested source metadata changed; no live A association remains')
      from public.students st join public.gift_cards g on g.id=public.business_id(4,${n}) where st.id=public.business_id(1,${n});
    select public.atomic_assert(not can_reconcile_legacy,'gift race ${n}: durable denial cannot toggle away after lock waiting')
      from public.student_credit_profile where student_id=public.business_id(1,${n});
    select public.atomic_reject($q$select public.manual_approve(${n},${n+800},'reconcile_legacy',4,4)$q$,
      'Legacy balance may mirror a historical gift card; reconciliation is forbidden');
    select public.atomic_assert(count(*)=0,'gift race ${n}: no duplicate legacy/manual allocation')
      from public.student_manual_credit_entitlements where student_id=public.business_id(1,${n});
    select public.atomic_assert(count(*)=1 and bool_and(observed_balance=4 and observation='gift_write'
      and recorded_by=public.business_id(0,1) and gift_snapshot->>'recipient_student_id'=student_id::text),
      'gift race ${n}: one immutable original-association denial snapshot')
      from private.manual_legacy_gift_vetoes where student_id=public.business_id(1,${n}) and gift_card_id=public.business_id(4,${n});`;
  await whileLocked('association erased while reconciliation waits', `set local role authenticated;
    set local request.jwt.claim.sub='01000000-0000-0000-0000-000000000001'; set local request.jwt.claim.role='authenticated';
    ${associateAndErase(180)}`, "select public.manual_approve(180,780,'reconcile_legacy',4,4)", 'select 1', null,
    /Legacy balance may mirror a historical gift card/, '00000000-0000-0000-0000-000000000001', verifyVetoRace(180));
  await whileLocked('observer waits on approval-style student lock', 'select 1 from public.students where id=public.business_id(1,182) for update',
    associateAndErase(182), 'select 1', null, null, '01000000-0000-0000-0000-000000000001', verifyVetoRace(182));
  await tx(`insert into public.students(id,sede_id,full_name,name,student_category,classes_remaining)
    select public.business_id(1,n),public.business_id(3,1),'Cross Swap Student '||n,'Cross Swap '||n,'temporal',4 from unnest(array[184,185]) n;
    insert into public.gift_cards(id,sede_id,recipient,recipient_student_id,num_classes,type,activated_at,payment_status)
    select public.business_id(4,n),public.business_id(3,1),'Unrelated Cross Stock '||n,public.business_id(1,n),4,'modelado',private.membership_today(),'paid'
      from unnest(array[184,185]) n;`);
  await Promise.all([tx('update public.gift_cards set recipient_student_id=public.business_id(1,185) where id=public.business_id(4,184);'),
    tx('update public.gift_cards set recipient_student_id=public.business_id(1,184) where id=public.business_id(4,185);')]); races++;
  await query(`select public.atomic_assert(count(*)=4 and bool_and(observed_balance=4),
      'opposite gift reassignments keep all denial pairs without FK key-share / student observer deadlock')
      from private.manual_legacy_gift_vetoes where student_id in(public.business_id(1,184),public.business_id(1,185))
        and gift_card_id in(public.business_id(4,184),public.business_id(4,185));
    select public.atomic_assert(count(*)=2 and bool_and(not can_reconcile_legacy and legacy_observed_balance=4),
      'opposite gift reassignments never reopen either original scalar') from public.student_credit_profile
      where student_id in(public.business_id(1,184),public.business_id(1,185));`);
  phase('manual concurrent scenarios', before);

  // Rerun every shipped behavioral assertion with this block active. Only adapt
  // additive-column exclusions and the deliberately changed reservation signature.
  // Sources on disk stay untouched; the adapter is sent to disposable psql stdin.
  await run(['-c', 'create database manual_policy_regression;']);
  const atomic = readFileSync(path('supabase/tests/atomic_session_operations.fixture.psql'), 'utf8')
    .replace(/^create role .*;\r?\n/gm, '');
  let business = readFileSync(path('supabase/tests/session_business_policy.fixture.psql'), 'utf8')
    .replace('\\i /tmp/atomic-fixture.psql', () => atomic)
    .replace('\\i /tmp/business-policy.sql', '\\i /tmp/business-policy.sql\n\\i /tmp/manual-policy.sql')
    .replace("'cancelled_by','business_exception_id']", "'cancelled_by','business_exception_id','manual_credit_id']")
    .replace("select 'credits',to_jsonb(m) from public.session_credit_movements m", "select 'credits',to_jsonb(m)-'manual_credit_id' from public.session_credit_movements m")
    .replace("'p_student_ids','p_gift_card_ids']", "'p_student_ids','p_gift_card_ids','p_manual_credit_ids']")
    .replace("oid='public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb)'::regprocedure",
      "oid='public.save_session_reservation(uuid,uuid,bigint,uuid,jsonb,uuid[],jsonb,jsonb)'::regprocedure")
    .replace("'waived_by','waived_at','finalized_revision']", "'waived_by','waived_at','finalized_revision'," +
      "'funding_manual_credit_id','exception_manual_credit_id','penalty_manual_credit_id','settlement_id','settlement_debit_id'," +
      "'settlement_reason','settled_by','settled_at','settlement_revision']");
  // The before-snapshot predates BOTH additive migrations in this variant.
  assert.ok(business.includes("to_jsonb(m)-'manual_credit_id'"));
  before = counts();
  await input(business, 'manual_policy_regression');
  phase('complete prior policy2 fixture with manual active (structural adapter only)', before);

  before = counts();
  const oldQuery = sql => run(['-c', identity + sql], 'manual_policy_regression');
  const oldTx = sql => oldQuery(`begin; ${auth} ${sql} select pg_sleep(0.2); commit;`);
  const oldReserve = (session, student, key) => oldTx(`select public.save_session_reservation(public.business_id(2,${session}),
    public.business_id(6,${key}),0,public.business_id(3,1),public.business_metadata(20,12,1),array[public.business_id(1,${student})],'{}');`);
  const seat = await Promise.allSettled([oldReserve(40,20,40),oldReserve(40,21,41)]); policyRaces++;
  assert.equal(seat.filter(x => x.status === 'fulfilled').length,1);
  assert.match(seat.find(x => x.status === 'rejected').reason.stderr,/Stale session revision/);
  raceRejections++;
  const overlap = await Promise.allSettled([oldReserve(41,22,42),oldReserve(42,22,43)]); policyRaces++;
  assert.equal(overlap.filter(x => x.status === 'fulfilled').length,1);
  assert.match(overlap.find(x => x.status === 'rejected').reason.stderr,/Student already reserved in an overlapping session/);
  raceRejections++;
  const oldFinal = (session, student, key, status = 'absent') => oldTx(`select public.save_session_attendance(public.business_id(2,${session}),
    public.business_id(6,${key}),1,public.business_attendance(${student},'${status}'),true,null);`);
  const sameFinal = await Promise.all([oldFinal(39,23,44),oldFinal(39,23,44)]); policyRaces++;
  assert.ok(sameFinal.some(x => x.stdout.includes('"replayed": true')));
  await oldQuery(`select public.atomic_assert(count(*)=1,'policy2 concurrent finalization still has one original debit')
    from public.session_credit_movements where session_id=public.business_id(2,39);`);
  await Promise.all([oldFinal(43,24,45),oldFinal(44,24,46)]); policyRaces++;
  await oldQuery(`select public.atomic_assert(classes_remaining=0,'policy2 membership race still cannot overspend')
    from public.students where id=public.business_id(1,24);
    select public.atomic_assert(count(*) filter(where state='charged')=1 and count(*) filter(where state='pending')=1,
    'policy2 last membership class still leaves one pending incident') from public.session_business_penalties
    where session_id in(public.business_id(2,43),public.business_id(2,44));`);
  const giftRace = await Promise.allSettled([oldFinal(45,25,47,'present'),oldFinal(46,25,48,'present')]); policyRaces++;
  assert.equal(giftRace.filter(x => x.status === 'fulfilled').length,1);
  assert.match(giftRace.find(x => x.status === 'rejected').reason.stderr,/Presence requires valid original credit/);
  raceRejections++;
  await oldQuery(`select public.atomic_assert(sessions_used=1,'policy2 original gift race still cannot overspend')
    from public.gift_cards where id=public.business_id(4,3);
    select public.atomic_assert(classes_remaining=4,'policy2 gift race still never falls back to membership')
    from public.students where id=public.business_id(1,25);`);
  phase('prior policy2 concurrent scenarios with manual active', before);

  // All actual workspace migrations, including dirty previous-phase migrations,
  // in a third cold database. This is not the existing local staging database.
  const migrations = readdirSync(path('supabase/migrations')).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  assert.ok(migrations.includes(migration));
  for (const name of migrations) docker('cp', path(`supabase/migrations/${name}`), `${container}:/tmp/cold-${name}`);
  docker('cp', path('local-staging/seed.psql'), `${container}:/tmp/cold-seed.psql`);
  await run(['-c', 'create database manual_cold;']);
  await run(['-c', `create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$;
    create function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'); $$;
    grant usage on schema auth to anon,authenticated,service_role;`], 'manual_cold');
  before = counts();
  const giftMigrationIndex = migrations.indexOf('20261011200000_gift_card_integrity.sql');
  assert.ok(giftMigrationIndex > 0);
  await run(migrations.slice(0, giftMigrationIndex).flatMap(name => ['-f', `/tmp/cold-${name}`]), 'manual_cold');
  await run(['-v', 'manual_legacy_seed=true', '-f', '/tmp/manual-fixture.psql'], 'manual_cold');
  await run(migrations.slice(giftMigrationIndex).flatMap(name => ['-f', `/tmp/cold-${name}`]), 'manual_cold');
  phase('real legacy gift-trigger seed and cold migration chain', before);
  await run(['-c', `insert into auth.users(id,email) values
    ('00000000-0000-0000-0000-000000000001','staff@pottery.local'),
    ('00000000-0000-0000-0000-000000000002','other@pottery.local'),
    ('00000000-0000-0000-0000-000000000003','reader@pottery.local');`,
    '-v', 'staff_id=00000000-0000-0000-0000-000000000001', '-v', 'other_id=00000000-0000-0000-0000-000000000002',
    '-v', 'reader_id=00000000-0000-0000-0000-000000000003',
    '-c', "set app.local_staging='pottery-gym-local-staging'", '-f', '/tmp/cold-seed.psql'], 'manual_cold');
  console.log(`PASS: cold full chain (${migrations.length} migrations) and unchanged staging seed in isolated database`);
  before = counts();
  await run(['-v', 'manual_legacy_verify=true', '-f', '/tmp/manual-fixture.psql'], 'manual_cold');
  phase('historical gift-mirror reconciliation and null activation regressions', before);
  before = counts();
  await run(['-c', `begin; ${auth}
    insert into public.students(id,sede_id,full_name,name,student_category,classes_remaining,payment_status)
      values ('10000000-0000-0000-0000-000000000999','30000000-0000-0000-0000-000000000001','Cold Manual','Cold','temporal',null,'pending');
    do $$ declare c jsonb; r jsonb; p uuid; raw jsonb; rejected boolean := false;
    begin
      select to_jsonb(st) into raw from public.students st where id='10000000-0000-0000-0000-000000000999';
      begin
        perform public.approve_student_manual_credit('10000000-0000-0000-0000-000000000999',gen_random_uuid(),'reconcile_legacy',1,null,
          'mesa',private.membership_today()-1,private.membership_today()+30,'Not proof of a known balance','Unknown observation');
      exception when raise_exception then
        rejected := sqlerrm='Known legacy reconciliation must allocate the exact positive observed balance';
      end;
      if not rejected or not exists(select 1 from public.student_credit_profile
        where student_id='10000000-0000-0000-0000-000000000999' and not can_reconcile_legacy and can_approve_manual_credit)
        then raise exception 'Cold unknown reconciliation did not fail closed'; end if;
      raise notice 'PASS: cold full-chain unknown legacy reconciliation and UI capability fail closed';
       c := public.approve_student_manual_credit('10000000-0000-0000-0000-000000000999',gen_random_uuid(),'new_manual',1,null,
        'mesa',private.membership_today()-1,private.membership_today()+30,'Cold owner approval','Cold evidence');
      r := public.save_session_reservation('20000000-0000-0000-0000-000000000999',gen_random_uuid(),0,'30000000-0000-0000-0000-000000000001',
        jsonb_build_object('date',private.membership_today()::text,'start_time',private.membership_today()::text||'T16:00:00Z',
          'end_time',private.membership_today()::text||'T17:00:00Z','class_type','mesa','capacity',1),
        array['10000000-0000-0000-0000-000000000999'::uuid],'{}',jsonb_build_object('10000000-0000-0000-0000-000000000999',c->>'entitlement_id'));
      perform public.save_session_attendance('20000000-0000-0000-0000-000000000999',gen_random_uuid(),1,
        '[{"student_id":"10000000-0000-0000-0000-000000000999","status":"absent"}]',true,null);
      if not exists(select 1 from public.manual_credit_entitlements_with_balance where entitlement_id=(c->>'entitlement_id')::uuid and remaining_classes=0)
        then raise exception 'Cold manual debit failed'; end if;
      perform public.save_session_reservation('20000000-0000-0000-0000-000000000998',gen_random_uuid(),0,'30000000-0000-0000-0000-000000000001',
        jsonb_build_object('date',private.membership_today()::text,'start_time',private.membership_today()::text||'T18:00:00Z',
          'end_time',private.membership_today()::text||'T19:00:00Z','class_type','mesa','capacity',1),
        array['10000000-0000-0000-0000-000000000999'::uuid],'{}',jsonb_build_object('10000000-0000-0000-0000-000000000999',c->>'entitlement_id'));
      perform public.save_session_attendance('20000000-0000-0000-0000-000000000998',gen_random_uuid(),1,
        '[{"student_id":"10000000-0000-0000-0000-000000000999","status":"absent"}]',true,null);
      select penalty_id into p from public.session_pending_penalties where session_id='20000000-0000-0000-0000-000000000998' and is_pending;
      if p is null then raise exception 'Cold exhausted original source did not produce pending incident'; end if;
      perform public.waive_session_penalty('20000000-0000-0000-0000-000000000999','10000000-0000-0000-0000-000000000999',gen_random_uuid(),2,'Cold owner waiver');
      if not exists(select 1 from public.manual_credit_entitlements_with_balance where entitlement_id=(c->>'entitlement_id')::uuid and remaining_classes=1)
        or not exists(select 1 from public.students st where id='10000000-0000-0000-0000-000000000999' and to_jsonb(st)=raw)
        then raise exception 'Cold manual reversal or raw preservation failed'; end if;
      raise notice 'PASS: cold full-chain independent manual grant, debit, owner waiver and unknown raw preservation';
      perform public.settle_student_penalty(p,gen_random_uuid(),2,'Cold owner settles restored original entitlement');
      if not exists(select 1 from public.session_pending_penalties where penalty_id=p and original_penalty_state='pending'
        and penalty_state='charged' and settlement_id is not null and not is_pending)
        or not exists(select 1 from public.manual_credit_entitlements_with_balance where entitlement_id=(c->>'entitlement_id')::uuid and remaining_classes=0)
        then raise exception 'Cold original-only settlement projection/debit failed'; end if;
      raise notice 'PASS: cold full-chain original-only settlement retains original pending incident';
      perform public.waive_session_penalty('20000000-0000-0000-0000-000000000998','10000000-0000-0000-0000-000000000999',gen_random_uuid(),3,'Cold owner waives settlement');
      if not exists(select 1 from public.manual_credit_entitlements_with_balance where entitlement_id=(c->>'entitlement_id')::uuid and remaining_classes=1)
        or not exists(select 1 from public.session_pending_penalties where penalty_id=p and is_waived and settlement_id is not null)
        or not exists(select 1 from public.students st where id='10000000-0000-0000-0000-000000000999' and to_jsonb(st)=raw)
        then raise exception 'Cold post-settlement waiver/raw preservation failed'; end if;
      raise notice 'PASS: cold full-chain post-settlement waiver preserves audit and raw unknown balance';
    end $$; commit;`], 'manual_cold');
  phase('cold full-chain behavioral smoke', before);
  const contract = await query(`select jsonb_build_object(
     'rpc_signatures', (select jsonb_agg(jsonb_build_object('name', p.proname,
       'arguments', pg_get_function_arguments(p.oid), 'returns', pg_get_function_result(p.oid)) order by p.proname)
       from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in
         ('approve_student_manual_credit','settle_student_penalty','save_session_reservation','save_session_attendance',
          'approve_session_exception','cancel_session_reservation','waive_session_penalty')),
      'columns', (select jsonb_agg(jsonb_build_object('relation', c.table_name, 'column', c.column_name,
        'schema', c.table_schema, 'type', c.data_type, 'nullable', c.is_nullable, 'default', c.column_default, 'ordinal', c.ordinal_position)
        order by c.table_schema, c.table_name, c.ordinal_position) from information_schema.columns c where (c.table_schema='public'
        and c.table_name in ('student_manual_credit_entitlements','student_penalty_settlements',
          'manual_credit_entitlements_with_balance','student_credit_profile','session_pending_penalties','session_business_state',
          'session_credit_movements','session_students','session_business_penalties','session_business_exceptions',
          'session_business_waivers','session_business_billing','session_business_events','session_operation_receipts','students'))
        or (c.table_schema='private' and c.table_name='manual_legacy_gift_vetoes')),
    'private_audit_policy', jsonb_build_object('table','private.manual_legacy_gift_vetoes',
      'purpose','Conservative denial observations only; never financial ownership or allocation',
      'client_access','none','unique_pair',jsonb_build_array('student_id','gift_card_id')),
    'projection_examples', jsonb_build_object(
      'unknown_legacy_profile', (select to_jsonb(v) from public.student_credit_profile v where student_id=public.business_id(1,101)),
      'missing_original_source_pending', (select to_jsonb(v) from public.session_pending_penalties v where session_id=public.business_id(2,107)),
      'manual_settled', (select to_jsonb(v) from public.session_pending_penalties v
        where session_id in(public.business_id(2,128),public.business_id(2,129)) and settlement_id is not null),
      'manual_settled_then_waived', (select to_jsonb(v) from public.session_pending_penalties v where session_id=public.business_id(2,106)),
      'manual_business_state_after_waiver', (select to_jsonb(v) from public.session_business_state v where session_id=public.business_id(2,106)),
      'manual_settlement_funding_snapshot', (select funding_snapshot from public.student_penalty_settlements
        where session_id=public.business_id(2,106))),
    'receipt_examples', jsonb_build_object(
      'approve_student_manual_credit', (select result from public.student_manual_credit_entitlements where id=public.manual_entitlement(105,105)),
      'settle_student_penalty', (select result from public.session_operation_receipts
        where session_id=public.business_id(2,106) and operation='settle_student_penalty'),
      'save_session_reservation', (select result from public.session_operation_receipts
        where session_id=public.business_id(2,106) and operation='reservation')));`);
  const schema = JSON.parse(contract.stdout.trim());
  const summary = { version, image, migrations: migrations.length, assertions, expectedDenials: denials,
    manualRaces: races, policy2Races: policyRaces, expectedRaceRejections: raceRejections, phases };
  if (outputDirectory) {
    writeFileSync(join(outputDirectory, 'manual-credit-contract.json'), JSON.stringify(schema, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'manual-credit-test-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  }
  console.log(`PASS: ${assertions} SQL assertions (${denials} expected denials), ${races} manual + ${policyRaces} prior policy2 concurrent scenarios (${raceRejections} expected race rejections); image ${image}`);
  if (outputLog) {
    appendFileSync(outputLog, JSON.stringify(summary, null, 2) + '\n');
    console.log(`Full SQL output: ${outputLog}`);
    console.log(`Frontend schema: ${join(outputDirectory, 'manual-credit-contract.json')}`);
  }
} catch (error) {
  if (outputLog) appendFileSync(outputLog, `FAIL\n${error.stdout ?? ''}${error.stderr ?? error.stack ?? error.message}\n`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  else process.stderr.write(`${error.stack ?? error.message}\n`);
  throw new Error('Manual credit/settlement test failed; disposable database output is shown above.');
} finally {
  if (container) docker('rm', '-f', container);
}
