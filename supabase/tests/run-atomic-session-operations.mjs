import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Only a locally inspected image, no networking/ports/volumes/remote DB URLs.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const asyncExec = promisify(execFile);
const baseline = process.argv.includes('--observed-baseline')
  ? 'supabase/.temp/baseline-schema.sql' : 'supabase/migrations/20260101000000_initial_schema.sql';
let container;
try {
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/, 'Local postgres:17 required, never pull');
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', `atomic-session-${randomUUID()}`,
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
    [baseline, 'atomic-baseline.sql'],
    ['supabase/migrations/20261011092140_student_membership_periods.sql', 'atomic-membership.sql'],
    ['supabase/migrations/20261011200000_gift_card_integrity.sql', 'atomic-gift.sql'],
    ['supabase/migrations/20261011220000_atomic_session_operations.sql', 'atomic-operations.sql'],
    ['supabase/tests/atomic_session_operations.fixture.psql', 'atomic-fixture.psql']
  ]) docker('cp', fileURLToPath(new URL(`../../${source}`, import.meta.url)), `${container}:/tmp/${target}`);
  const psql = ['exec', container, 'psql', '-X', '-w', '-U', 'postgres', '-h', '/var/run/postgresql',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  const fixture = await asyncExec('docker', [...psql, '-f', '/tmp/atomic-fixture.psql'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(fixture.stdout);
  process.stdout.write(fixture.stderr);
  const query = async sql => {
    const result = await asyncExec('docker', [...psql, '-c', sql], { cwd: root, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stderr);
    return result.stdout;
  };
  const reservation = (student, key, session = '000000000005') => `begin; set local role authenticated;
    set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    select public.save_session_reservation('20000000-0000-0000-0000-${session}',
      '60000000-0000-0000-0000-${key}',0,'30000000-0000-0000-0000-000000000001','{}',
      array['10000000-0000-0000-0000-${student}'::uuid],'{}'); select pg_sleep(0.5); commit;`;
  const racing = await Promise.allSettled([
    query(reservation('000000000005','000000000010')),
    query(reservation('000000000006','000000000011'))
  ]);
  assert.equal(racing.filter(result => result.status === 'rejected').length, 1);
  assert.match(racing.find(result => result.status === 'rejected').reason.stderr, /Stale session revision/);
  await query(`select public.atomic_assert(count(*)=1,'final-seat race commits exactly one ID roster') from public.session_students
    where session_id='20000000-0000-0000-0000-000000000005';
    select public.atomic_assert(count(*)=1,'losing final-seat claim has no receipt') from public.session_operation_receipts
    where session_id='20000000-0000-0000-0000-000000000005';
    select public.atomic_assert(bool_and(classes_remaining=3),'reservation never debits credits') from public.students
    where id in ('10000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000006');`);
  await query(`begin; set local role authenticated; set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    select public.atomic_reject($q$select public.save_session_reservation('20000000-0000-0000-0000-000000000005',
      gen_random_uuid(),1,'30000000-0000-0000-0000-000000000001','{}',
      array['10000000-0000-0000-0000-000000000005'::uuid,'10000000-0000-0000-0000-000000000006'::uuid],'{}')$q$,
      'Session capacity exceeded'); commit;`);
  // Different parent sessions, same person and overlapping interval: student lock
  // serializes the conflict check even though the parent locks are independent.
  await query(`update public.sessions set start_time=(select start_time from public.sessions where id='20000000-0000-0000-0000-000000000005'),
    end_time=(select end_time from public.sessions where id='20000000-0000-0000-0000-000000000005')
    where id='20000000-0000-0000-0000-000000000007';`);
  await query(`begin; set local role authenticated; set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    select public.atomic_reject(format($q$select public.save_session_reservation('20000000-0000-0000-0000-000000000007',
      gen_random_uuid(),0,'30000000-0000-0000-0000-000000000001','{}',array[%L::uuid],'{}')$q$,
      (select student_id from public.session_students where session_id='20000000-0000-0000-0000-000000000005')),
      'Student already reserved in an overlapping session'); commit;`);
  await query(`insert into public.sessions(id,sede_id,start_time,end_time,class_type,date,capacity)
    select target,'30000000-0000-0000-0000-000000000001',start_time,end_time,class_type,date,1
    from public.sessions cross join (values ('20000000-0000-0000-0000-000000000009'::uuid),
      ('20000000-0000-0000-0000-000000000010'::uuid)) ids(target)
    where id='20000000-0000-0000-0000-000000000007';`);
  const overlapping = await Promise.allSettled([
    query(reservation('000000000007','000000000030','000000000009')),
    query(reservation('000000000007','000000000031','000000000010'))
  ]);
  assert.equal(overlapping.filter(result => result.status === 'rejected').length, 1);
  assert.match(overlapping.find(result => result.status === 'rejected').reason.stderr, /Student already reserved in an overlapping session/);
  await query(`select public.atomic_assert(count(*)=1,'different-parent concurrent conflict claims commit one reservation')
    from public.session_students where session_id in ('20000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000010');
    select public.atomic_assert(count(*)=1,'student-lock losing conflict claim leaves no receipt')
    from public.session_operation_receipts where session_id in ('20000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000010');`);
  const giftAttendance = (session, key, roster) => `begin; set local role authenticated;
    set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    select public.save_session_attendance('20000000-0000-0000-0000-${session}',
      '60000000-0000-0000-0000-${key}',2,'${JSON.stringify(roster)}',true,null);
    select pg_sleep(0.5); commit;`;
  const presentGift = { student_id: '10000000-0000-0000-0000-000000000003', status: 'present' };
  const giftRace = await Promise.allSettled([
    query(giftAttendance('000000000003','000000000040',[presentGift])),
    query(giftAttendance('000000000008','000000000041',[presentGift,
      { student_id: '10000000-0000-0000-0000-000000000004', status: 'absent' }]))
  ]);
  assert.equal(giftRace.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(giftRace.find(result => result.status === 'rejected').reason.stderr, /El bono no tiene sesiones disponibles/);
  await query(`select public.atomic_assert(sessions_used=1,'different-parent atomic attendance cannot overspend final gift credit')
    from public.gift_cards where id='40000000-0000-0000-0000-000000000001';
    select public.atomic_assert(count(*)=1,'losing final gift-credit attendance leaves no receipt') from public.session_operation_receipts
    where request_key in ('60000000-0000-0000-0000-000000000040','60000000-0000-0000-0000-000000000041');`);
  const attendance = key => `begin; set local role authenticated; set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    select public.save_session_attendance('20000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-${key}',0,
      '[{"student_id":"10000000-0000-0000-0000-000000000001","status":"absent"},{"student_id":"10000000-0000-0000-0000-000000000002","status":"absent"}]',true,null);
    select pg_sleep(0.5); commit;`;
  await Promise.all([query(attendance('000000000020')), query(attendance('000000000020'))]);
  await query(`select public.atomic_assert(revision=1,'concurrent identical attendance key advances revision once') from public.sessions
    where id='20000000-0000-0000-0000-000000000001';
    select public.atomic_assert(count(*)=1,'concurrent identical attendance returns one durable receipt') from public.session_operation_receipts
    where session_id='20000000-0000-0000-0000-000000000001';`);
  console.log(`PASS: ${baseline}, atomic rollback, ID roster, original funding, authorization, receipts and races`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
}
