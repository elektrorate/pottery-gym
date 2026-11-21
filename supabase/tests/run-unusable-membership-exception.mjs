import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Local disposable PostgreSQL only. Never reads DATABASE_URL or a hosted project.
// Production is not contacted. The database is created for this process and dropped at the end.
if (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL) {
  console.error('Ignoring DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL; this rehearsal is local-only.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const database = 'pottery_unusable_exception';
const psql = (db, args, input) => {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`psql exited ${result.status}`);
  }
  return output;
};
const file = (db, relative) => {
  const sql = readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)));
  const result = psql(db, ['-f', '-'], sql);
  process.stdout.write(result);
  return result;
};

let created = false;
try {
  const version = psql('postgres', ['-Atc', 'show server_version;']).trim();
  assert.match(version, /^17\./, `Expected local PostgreSQL 17, got ${version}`);
  psql('postgres', ['-c', `drop database if exists ${database};`]);
  psql('postgres', ['-c', `create database ${database};`]);
  created = true;
  file(database, 'supabase/tests/external_bonos_temporal_student.stubs.psql');
  psql(database, ['-c', `create or replace function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb; $$;`]);
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  assert.ok(migrations.includes('20261121054908_unusable_membership_exception.sql'));
  for (const migration of migrations) file(database, `supabase/migrations/${migration}`);
  console.log(`PASS: applied ${migrations.length} migrations on local PostgreSQL ${version}, database ${database}`);
  const fixture = file(database, 'supabase/tests/unusable_membership_exception.fixture.psql');
  const passes = (fixture.match(/NOTICE:\s+PASS:/g) || []).length;
  assert.ok(passes >= 20, `expected the fixture assertions to pass, saw ${passes}`);
  console.log(`PASS: fixture ${passes} assertions`);

  file(database, 'supabase/rollbacks/20261121054908_unusable_membership_exception_rollback.sql');
  const rolled = psql(database, ['-c', `
    set request.jwt.claim.role = 'authenticated';
    set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000001';
    select public.ux_assert(f->>'usable' = 'false' and f->>'overridable' = 'false' and f->>'no_credit_allowed' = 'false',
      'rollback restores the deadlock flags on the open probe session')
      from (select private.session_business_funding(public.ux_id('e4', 3), public.ux_id('e2', 1)) f) funding;
    set role authenticated;
    select public.ux_reject($sql$select public.approve_session_exception(public.ux_id('e4', 3), public.ux_id('e2', 1),
      public.ux_id('e6', 40), 1, 'membership_override', 'Rollback blocks override')$sql$,
      'Membership override requires known original positive credit needing an exception');
    select public.ux_reject($sql$select public.approve_session_exception(public.ux_id('e4', 3), public.ux_id('e2', 1),
      public.ux_id('e6', 41), 1, 'no_credit', 'Rollback blocks courtesy')$sql$,
      'No-credit exception cannot bypass available credit%');
  `]);
  process.stdout.write(rolled);
  assert.match(rolled, /PASS: rollback restores the deadlock flags/);
  assert.match(rolled, /PASS: reject: Membership override requires known original positive credit needing an exception/);
  console.log('PASS: rollback restores the deadlock');

  file(database, 'supabase/migrations/20261121054908_unusable_membership_exception.sql');
  const again = psql(database, ['-c', `
    select public.ux_assert(f->>'usable' = 'false' and f->>'overridable' = 'true' and f->>'no_credit_allowed' = 'true'
      and f->>'override_requires_owner' = 'true' and f->>'courtesy_requires_owner' = 'true',
      'reapplying the migration reopens both owner exceptions without making the period usable')
      from (select private.session_business_funding(public.ux_id('e4', 3), public.ux_id('e2', 1)) f) funding;
  `]);
  process.stdout.write(again);
  assert.match(again, /PASS: reapplying the migration reopens both owner exceptions/);
  console.log('PASS: forward migration reapplies after rollback');
} finally {
  if (created) {
    psql('postgres', ['-c', `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid();`]);
    psql('postgres', ['-c', `drop database if exists ${database};`]);
    console.log(`PASS: dropped local database ${database}`);
  }
}
