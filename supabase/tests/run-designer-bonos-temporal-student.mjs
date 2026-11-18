import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Disposable, networkless postgres:17 container; never a remote or live project.
// Applies the Supabase stubs, every migration in order, then the assertions fixture.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
const name = `designer-bonos-${randomUUID()}`;
let container;
try {
  const image = docker('image', 'inspect', 'postgres:17', '--format', '{{.Id}}').trim();
  assert.match(image, /^sha256:/, 'A local postgres:17 image is required; never pull');
  container = docker('run', '-d', '--pull=never', '--network=none', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    image, 'postgres', '-c', 'listen_addresses=').trim();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { docker('exec', container, 'pg_isready', '-U', 'postgres', '-h', '/var/run/postgresql'); ready = true; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, 'Fresh disposable database did not become ready');
  const psql = file => docker('exec', container, 'psql', '-X', '-q', '-w', '-U', 'postgres', '-h', '/var/run/postgresql',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', file);
  const files = [
    'supabase/tests/external_bonos_temporal_student.stubs.psql',
    ...readdirSync(new URL('../migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()
      .map(file => `supabase/migrations/${file}`),
    'supabase/tests/designer_bonos_temporal_student.psql'
  ];
  files.forEach((file, index) => docker('cp', file, `${container}:/tmp/${String(index).padStart(3, '0')}.sql`));
  let output = '';
  files.forEach((_, index) => { output = psql(`/tmp/${String(index).padStart(3, '0')}.sql`); });
  assert.match(output, /ALL DESIGNER BONOS TESTS PASSED/);
  console.log('PASS: designer bonos (authenticated + sede check, temporal student, same code, no orphan)');
} finally {
  if (container) docker('rm', '-f', container);
}
