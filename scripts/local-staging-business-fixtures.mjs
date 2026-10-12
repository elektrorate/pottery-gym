import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertRuntime, dbContainer, projectId, redact, root } from './local-staging-runtime.mjs';

const actorEmails = {
  staff_id: 'staff@pottery.local', other_id: 'other@pottery.local', reader_id: 'reader@pottery.local',
  employee_id: 'employee@pottery.local', supervisor_id: 'supervisor@pottery.local'
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guard = `set app.local_staging = '${projectId}';
do $$ begin
  if current_setting('app.local_staging', true) is distinct from '${projectId}'
    or session_user <> 'postgres' or current_user <> 'postgres' or current_database() <> 'postgres'
    or to_regclass('private.local_staging_setup') is null then
    raise exception 'Owned local staging postgres session required';
  end if;
  if not exists (select 1 from private.local_staging_setup where version = 1)
    or not exists (select 1 from public.sedes where id = '30000000-0000-0000-0000-000000000001'
      and slug = '${projectId}' and is_active) then
    raise exception 'Existing local staging seed identity required';
  end if;
end $$;`;

// Parent-process only. No arbitrary DB target, shell, Auth admin call, or cleanup.
function postgres(input, variables = {}) {
  assertRuntime();
  if (dbContainer !== 'supabase_db_pottery-gym-local-staging' || projectId !== 'pottery-gym-local-staging') {
    throw new Error('Business fixtures require the named owned local DB.');
  }
  try {
    return execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-X', '-w', '-qAt', '-U', 'postgres',
      '-h', '/var/run/postgresql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([key, value]) => ['-v', `${key}=${value}`])], {
      cwd: root, input: `${guard}\n${input}`, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    throw new Error(`Owned local business fixture rejected: ${redact(error.stderr || error.message)}`);
  }
}

function fixture(mode, actors, manifest = {}) {
  if (!actors || Object.keys(actors).sort().join(',') !== Object.keys(actorEmails).sort().join(',')
    || Object.values(actors).some(id => !uuid.test(id)) || new Set(Object.values(actors)).size !== 5) {
    throw new Error('Five distinct actual Auth UUIDs are required; no credentials accepted.');
  }
  return postgres(readFileSync(path.join(root, 'local-staging', 'business-rules.fixture.psql'), 'utf8'), {
    mode, ...actors, manifest: JSON.stringify(manifest)
  });
}

// Call from owned setup AFTER Auth-admin account creation and the existing seed.
// Accepts the setup's ordered IDs or the explicit five-key object. Re-runs only
// validate persisted roles/memberships; revoked authority is never re-enabled.
export function seedBusinessActors(ids) {
  if (Array.isArray(ids) && ids.length !== 5) throw new Error('Setup must pass exactly five actual Auth IDs.');
  const actors = Array.isArray(ids) ? Object.fromEntries(Object.keys(actorEmails).map((key, i) => [key, ids[i]])) : ids;
  fixture('actors', actors);
  return actors;
}

export function prepareBusinessFixtures() {
  const actors = JSON.parse(postgres(`select coalesce(jsonb_object_agg(key, u.id), '{}')
    from jsonb_each_text('${JSON.stringify(actorEmails)}'::jsonb) e(key, email)
    join auth.users u on u.email = e.email;`));
  const kinds = {
    paidPresence: 'paid', paidAbsence: 'paid', pending: 'pending', unknown: 'unknown',
    expiredGrace: 'expired_grace', expiredBeyond5: 'expired_beyond5', courtesy: 'zero',
    zeroNoShow: 'zero', zeroLate: 'zero', queuedNoShow: 'queued',
    pendingNoShow: 'pending', unknownNoShow: 'unknown', graceNoShow: 'expired_grace', expiredNoShow: 'expired_beyond5',
    timely: 'paid', late: 'paid', permissions: 'paid', boundApproval: 'pending',
    uiPending: 'pending', uiCourtesy: 'zero', uiTimely: 'paid', uiWaiver: 'paid',
    uiApprovalRecovery: 'pending', uiCancelRecovery: 'paid', uiWaiverRecovery: 'paid'
  };
  const subjects = Object.fromEntries(Object.entries(kinds).map(([key, kind]) => [key, {
    kind, studentId: randomUUID(), periodId: randomUUID(),
    ...(kind === 'queued' ? { successorId: randomUUID(), cardId: randomUUID() } : {})
  }]));
  return JSON.parse(fixture('fixtures', actors, { runId: randomUUID(), subjects }));
}
