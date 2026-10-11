import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// No host credentials, mounted workspace, ports, network or existing database.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
let container;
try {
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/);
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', `domain-read-${randomUUID()}`,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image,
    'postgres', '-c', 'listen_addresses=').trim();
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker('exec', container, 'bash', '-c', 'read -r process </proc/1/comm; [[ "$process" == postgres ]]');
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-h', '/var/run/postgresql');
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready');
  for (const [source, target] of [
    ['supabase/migrations/20261011092140_student_membership_periods.sql', 'domain-membership.sql'],
    ['supabase/migrations/20261011210000_authorized_read_api.sql', 'domain-migration.sql'],
    ['supabase/tests/domain_read.fixture.psql', 'domain-fixture.psql'],
    ['supabase/tests/domain_read.assertions.psql', 'domain-assertions.psql']
  ]) docker('cp', fileURLToPath(new URL(`../../${source}`, import.meta.url)), `${container}:/tmp/${target}`);
  docker('exec', container, 'createdb', '-U', 'postgres', 'domain_read_fixture');
  const result = docker('exec', container, 'psql', '-X', '-w', '-U', 'postgres', '-h', '/var/run/postgresql',
    '-d', 'domain_read_fixture', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/domain-fixture.psql');
  process.stdout.write(result);
  console.log('PASS: scoped reads, revocation, injection rejection and unchanged historical observations');
} finally {
  if (container) docker('rm', '-f', container);
}
