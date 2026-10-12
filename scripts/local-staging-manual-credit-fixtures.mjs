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
    or to_regclass('private.local_staging_setup') is null
    or to_regclass('private.local_staging_business_actors') is null then
    raise exception 'Existing owned local staging and business actors required';
  end if;
  if not exists (select 1 from private.local_staging_setup where version = 1)
    or not exists (select 1 from public.sedes where id = '30000000-0000-0000-0000-000000000001'
      and slug = '${projectId}' and is_active) then
    raise exception 'Existing local staging seed identity required';
  end if;
end $$;`;

// Parent-only bootstrap. No CLI target override, Auth admin, credentials or cleanup.
function postgres(input, variables = {}) {
  assertRuntime();
  if (dbContainer !== 'supabase_db_pottery-gym-local-staging' || projectId !== 'pottery-gym-local-staging') {
    throw new Error('Manual credit fixtures require the named owned local DB.');
  }
  try {
    return execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-X', '-w', '-qAt', '-U', 'postgres',
      '-h', '/var/run/postgresql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([key, value]) => ['-v', `${key}=${value}`])], {
      cwd: root, input: `${guard}\n${input}`, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    throw new Error(`Owned local manual credit fixture rejected: ${redact(error.stderr || error.message)}`);
  }
}

export function prepareManualCreditFixtures() {
  const actors = JSON.parse(postgres(`select coalesce(jsonb_object_agg(key, u.id), '{}')
    from jsonb_each_text('${JSON.stringify(actorEmails)}'::jsonb) e(key, email)
    join auth.users u on u.email = e.email;`));
  if (Object.keys(actors).sort().join(',') !== Object.keys(actorEmails).sort().join(',')
    || Object.values(actors).some(id => !uuid.test(id)) || new Set(Object.values(actors)).size !== 5) {
    throw new Error('Five distinct existing actual Auth UUIDs required; no actors are created or repaired.');
  }
  const kinds = { known: 'known', unknown: 'unknown', manualAttendance: 'zero', giftSettlement: 'gift',
    blockedSuccessor: 'queued', missingSource: 'zero', approvalRecovery: 'known',
    settlementRecovery: 'gift', waiverRecovery: 'gift', approvalRefreshRecovery: 'known',
    settlementRefreshRecovery: 'gift', waiverRefreshRecovery: 'gift', approvalRejectedRefreshRecovery: 'known',
    settlementRejectedRefreshRecovery: 'gift', waiverRejectedRefreshRecovery: 'gift' };
  const subjects = Object.fromEntries(Object.entries(kinds).map(([key, kind]) => [key, {
    kind, studentId: randomUUID(), ...(kind === 'queued' ? { periodId: randomUUID(), successorId: randomUUID() } : {}),
    ...(['gift', 'queued'].includes(kind) ? { cardId: randomUUID(), alternativeCardId: randomUUID() } : {})
  }]));
  return JSON.parse(postgres(readFileSync(path.join(root, 'local-staging', 'manual-credit.fixture.psql'), 'utf8'), {
    ...actors, manifest: JSON.stringify({ runId: randomUUID(), subjects })
  }));
}
