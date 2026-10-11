import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, runtime, projectId, dbContainer, apiUrl, cli, assertRuntime, localStatus, localFetch,
  testPassword, testEmails, redact } from './local-staging-runtime.mjs';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  if (!existsSync(path.dirname(runtime))) throw new Error('Pre-approved temporary parent directory is missing.');
  if (existsSync(runtime)) assertRuntime();
  else {
    mkdirSync(path.join(runtime, 'supabase', 'migrations'), { recursive: true });
    copyFileSync(path.join(root, 'local-staging', 'supabase', 'config.toml'), path.join(runtime, 'supabase', 'config.toml'));
    writeFileSync(path.join(runtime, 'local-staging.json'), JSON.stringify({ projectId, source: root, createdAt: new Date().toISOString() }, null, 2));
  }
  const sourceConfig = path.join(root, 'local-staging', 'supabase', 'config.toml');
  const runtimeConfig = path.join(runtime, 'supabase', 'config.toml');
  if (hash(sourceConfig) !== hash(runtimeConfig)) {
    console.log('Applying owned staging configuration; stopping only this local stack and retaining its snapshot.');
    cli(['stop']);
    copyFileSync(sourceConfig, runtimeConfig);
  }
  const migrations = readdirSync(path.join(root, 'supabase', 'migrations')).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const source = path.join(root, 'supabase', 'migrations', name);
    const target = path.join(runtime, 'supabase', 'migrations', name);
    if (existsSync(target) && hash(source) !== hash(target)) throw new Error(`Migration ${name} changed. Create a follow-up migration; existing staging is never reset.`);
    if (!existsSync(target)) copyFileSync(source, target);
  }
  cpSync(path.join(root, 'supabase', 'functions'), path.join(runtime, 'supabase', 'functions'), { recursive: true });
  mkdirSync(path.join(runtime, 'supabase', 'tests'), { recursive: true });
  for (const name of ['student_payment_lifecycle.sql', 'workshop_availability.sql']) {
    copyFileSync(path.join(root, 'supabase', 'tests', name), path.join(runtime, 'supabase', 'tests', name));
  }
  console.log(`Starting isolated local Supabase ${projectId}; existing projects are not touched.`);
  cli(['start', '--exclude', 'logflare,vector,imgproxy,supavisor']);
  const status = localStatus();
  const applied = JSON.parse(execFileSync('docker', ['exec', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc',
    "select coalesce(json_agg(version order by version), '[]') from supabase_migrations.schema_migrations;"], { encoding: 'utf8' }));
  const pending = migrations.filter(name => !applied.includes(name.split('_')[0]));
  if (pending.length) {
    // The explicit local flag uses this checked runtime's 55322 database and
    // lets the CLI own transaction/history handling, never a remote link/reset.
    console.log(`Applying ${pending.length} follow-up migration(s) to owned local staging only.`);
    cli(['db', 'push', '--local', '--skip-vault', '--yes']);
  }
  const users = await localFetch('/auth/v1/admin/users?page=1&per_page=1000', { key: status.SERVICE_ROLE_KEY });
  const ids = [];
  for (const email of testEmails) {
    let user = users.users.find(item => item.email === email);
    if (!user) user = await localFetch('/auth/v1/admin/users', { key: status.SERVICE_ROLE_KEY, method: 'POST',
      body: JSON.stringify({ email, password: testPassword, email_confirm: true, user_metadata: { full_name: 'Synthetic local staging user' } }) });
    if (!/^[0-9a-f-]{36}$/i.test(user.id)) throw new Error('Auth did not return a valid synthetic identity.');
    ids.push(user.id);
  }
  execFileSync('docker', ['cp', path.join(root, 'local-staging', 'seed.psql'), `${dbContainer}:/tmp/local-staging-seed.psql`]);
  execFileSync('docker', ['exec', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-v', `staff_id=${ids[0]}`, '-v', `other_id=${ids[1]}`, '-v', `reader_id=${ids[2]}`,
    '-c', `set app.local_staging = '${projectId}';`, '-f', '/tmp/local-staging-seed.psql'], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`Local staging ready: API ${apiUrl}; Studio http://127.0.0.1:55323`);
  console.log('Synthetic login: staff@pottery.local / LocalStaging2026!');
  console.log('No remote link, reset, production data or administrative key was written to frontend configuration.');
} catch (error) {
  console.error(redact(error.stderr || error.message));
  process.exitCode = 1;
}
