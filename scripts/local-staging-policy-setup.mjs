import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertRuntime, localStatus, dbContainer, redact, runtime, projectId } from './local-staging-runtime.mjs';

// Fingerprints only: no contacts, notes, password hashes or tokens leave the DB.
const tables = ['students', 'student_membership_periods', 'student_membership_class_adjustments',
  'gift_cards', 'gift_card_movements', 'gift_card_operation_receipts', 'sessions', 'session_students',
  'session_operation_receipts', 'session_credit_movements', 'profiles', 'sedes', 'sede_members',
  'teachers', 'workshop_schedules', 'workshop_capacity_defaults', 'workshop_schedule_exceptions',
  'session_business_exceptions', 'session_business_penalties', 'session_business_waivers',
  'session_business_billing', 'session_business_events', 'student_manual_credit_entitlements',
  'student_penalty_settlements', 'private.domain_read_principals', 'private.domain_read_grants',
  'private.manual_legacy_gift_vetoes'];
const manualColumnTables = new Set(['session_students', 'session_credit_movements',
  'session_business_penalties', 'session_business_exceptions']);
const relation = table => table.includes('.') ? table : `public.${table}`;
const query = sql => JSON.parse(execFileSync('docker', ['exec', dbContainer, 'psql', '-X', '-w', '-U', 'postgres',
  '-h', '/var/run/postgresql', '-d', 'postgres', '-Atc', sql], {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
}));
const fingerprints = () => {
  // New relations may not exist BEFORE rollout. Existing policy/cancellation
  // fields are never masked; only this migration's four nullable additions are.
  const existing = query(`select coalesce(json_agg(name), '[]') from unnest(array[${tables.map(table =>
    `'${table}'`).join(',')}]) name where to_regclass(case when name like '%.%' then name else 'public.' || name end) is not null`);
  if (tables.some(table => !existing.includes(table)
    && !['student_manual_credit_entitlements', 'student_penalty_settlements', 'private.manual_legacy_gift_vetoes'].includes(table))) {
    throw new Error('Previous local policy schema and read grants required before manual-credit rollout.');
  }
  return query(`select coalesce(json_object_agg(label, hashes), '{}') from (${existing.map(table => {
    const excluded = manualColumnTables.has(table) ? " - 'manual_credit_id'" : '';
    return `select '${table}' label, coalesce(json_agg(hash order by hash), '[]') hashes
      from (select md5((to_jsonb(t)${excluded})::text) hash from ${relation(table)} t) h`;
  }).join(' union all ')} union all
    select 'row_security_policies', coalesce(json_agg(hash order by hash), '[]') from (
      select md5(to_jsonb(p)::text) hash from pg_catalog.pg_policies p
      where p.schemaname || '.' || p.tablename in (${existing.map(table => `'${relation(table)}'`).join(',')})
    ) p union all
    select 'row_security_settings', coalesce(json_agg(hash order by hash), '[]') from (
      select md5(jsonb_build_object('table', n.nspname || '.' || c.relname,
        'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity)::text) hash
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname || '.' || c.relname in (${existing.map(table => `'${relation(table)}'`).join(',')})
    ) r) snapshot`);
};

const backup = () => {
  if (process.platform !== 'win32') throw new Error('This owned backup uses Windows CurrentUser DPAPI; configure protected backup storage before migrating elsewhere.');
  const protect = (bytes, reverse = false) => Buffer.from(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); try { $result=[Security.Cryptography.ProtectedData]::${reverse ? 'Unprotect' : 'Protect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($result)) } finally { [Array]::Clear($bytes,0,$bytes.Length) }`],
  { input: bytes.toString('base64'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(), 'base64');
  const dump = execFileSync('docker', ['exec', dbContainer, 'pg_dump', '-U', 'postgres', '-d', 'postgres'], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const key = randomBytes(32); const nonce = randomBytes(12);
  let restoredKey; let restored;
  try {
    const protectedKey = protect(key);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
    const tag = cipher.getAuthTag();
    restoredKey = protect(protectedKey, true);
    const decipher = createDecipheriv('aes-256-gcm', restoredKey, nonce); decipher.setAuthTag(tag);
    restored = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (!createHash('sha256').update(restored).digest().equals(createHash('sha256').update(dump).digest())) throw new Error('Encrypted backup verification failed.');
    const directory = path.join(runtime, 'backups'); mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `before-policy-${Date.now()}`);
    writeFileSync(`${filename}.aes`, Buffer.concat([nonce, tag, encrypted]));
    writeFileSync(`${filename}.key.dpapi`, protectedKey);
    writeFileSync(`${filename}.json`, JSON.stringify({ projectId, format: 'AES-256-GCM, nonce12/tag16; key Windows CurrentUser DPAPI', verifiedDecryption: true, restorationRehearsed: false }, null, 2));
    console.log('Owned local backup encrypted and decryption verified; files and protected key stay outside Git.');
  } finally { dump.fill(0); key.fill(0); restoredKey?.fill(0); restored?.fill(0); }
};

try {
  assertRuntime();
  if (projectId !== 'pottery-gym-local-staging' || dbContainer !== 'supabase_db_pottery-gym-local-staging') {
    throw new Error('Policy rollout requires the named owned local DB.');
  }
  localStatus();
  const before = fingerprints();
  const policies = query("select coalesce(json_object_agg(id,coalesce((to_jsonb(s)->>'attendance_policy_version')::integer,1)), '{}') from public.sessions s");
  backup();
  await import('./local-staging-setup.mjs');
  if (process.exitCode) throw new Error('Owned staging setup failed; no reset or rollback of history will be attempted.');
  const after = fingerprints();
  for (const [table, hashes] of Object.entries(before)) {
    if (!Array.isArray(after[table])) throw new Error(`Pre-existing ${table} relation disappeared. Stop and inspect; do not reset.`);
    const remaining = [...after[table]];
    for (const hash of hashes) {
      const index = remaining.indexOf(hash);
      if (index < 0) throw new Error(`Pre-existing ${table} observation changed. Stop and inspect; do not reset.`);
      remaining.splice(index, 1);
    }
  }
  const current = query("select coalesce(json_object_agg(id,attendance_policy_version), '{}') from public.sessions");
  for (const [id, policy] of Object.entries(policies)) {
    if (current[id] !== policy) throw new Error('An existing session policy changed; do not rebill historical sessions.');
  }
  console.log('PASS: every pre-existing business observation and session policy was preserved in owned local staging.');
} catch (error) { console.error(redact(error.stderr || error.message)); process.exitCode = 1; }
