import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntime, localStatus, dbContainer, projectId, runtime, root, testEmails, testPassword } from './local-staging-runtime.mjs';

const label = 'pottery.restore-rehearsal';
const expectedImage = 'public.ecr.aws/supabase/postgres:17.6.1.159';
const expectedImageId = 'sha256:86a2e078779e5bdccda1f6f6c5063aa9779a322d1fface5fb408d051909b230f';
const hash = value => createHash('sha256').update(value).digest('hex');
const lit = value => "'" + String(value).replaceAll("'", "''") + "'";
const ident = value => '"' + String(value).replaceAll('"', '""') + '"';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|DB_URL|JWT|SUPABASE|^VITE_|^PG|^DEBUG$|PWDEBUG)/i.test(key)));

// Child output is always captured. Errors never include SQL, config, rows or credentials.
function command(file, args, input, timeout = 120_000) {
  try { return execFileSync(file, args, { input, timeout, env: cleanEnv(), maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
  catch (error) {
    // pg_restore --schema-only can finish before Windows finishes piping data
    // blocks. Node reports EOF even though the reader exited successfully.
    if (input && error.status === 0 && error.code === 'EOF' && !error.signal && Buffer.isBuffer(error.stdout)) return error.stdout;
    const code = String(error.stderr || '').match(/(?:ERROR|FATAL):\s+([^\r\n]+)/)?.[1];
    const diagnostic = code ? hash(code).slice(0, 16) : 'none';
    throw new Error(`${file} ${args.find(a => ['exec', 'create', 'inspect', 'pg_dump', 'pg_dumpall', 'pg_restore'].includes(a)) || 'operation'} command failed (exit ${error.status ?? 'unknown'}, code ${error.code || 'none'}, signal ${error.signal || 'none'}, diagnostic hash ${diagnostic}).`);
  }
}
const docker = (args, input, timeout) => command('docker', args, input, timeout);
const inspect = name => JSON.parse(docker(['inspect', name]).toString())[0];

export function assertLocalDocker(host, override) {
  if (override || !/^(?:npipe:\/\/\/\/\.\/pipe\/[^\s]+|unix:\/\/\/[^\s]+)$/.test(host || '')) {
    throw new Error('Only a local npipe/unix Docker context with no DOCKER_HOST override is allowed.');
  }
}

function sourceIdentity() {
  if (process.platform !== 'win32') throw new Error('CurrentUser DPAPI requires this Windows local runtime.');
  const context = JSON.parse(docker(['context', 'inspect']).toString())[0];
  assertLocalDocker(context.Endpoints?.docker?.Host, process.env.DOCKER_HOST);
  if (process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== context.Name) throw new Error('Docker context override mismatch.');
  assertRuntime();
  const status = localStatus();
  const db = inspect(dbContainer);
  const auth = inspect(`supabase_auth_${projectId}`);
  const rest = inspect(`supabase_rest_${projectId}`);
  if (projectId !== 'pottery-gym-local-staging' || db.Name !== '/supabase_db_pottery-gym-local-staging'
    || !db.State.Running || !auth.State.Running || !rest.State.Running
    || !db.NetworkSettings.Ports['5432/tcp']?.some(p => p.HostPort === '55322')
    || db.Config.Image !== expectedImage || db.Image !== expectedImageId) throw new Error('Exact local source identity/image mismatch.');
  for (const container of [db, auth, rest]) {
    const image = JSON.parse(docker(['image', 'inspect', container.Image]).toString())[0];
    if (image.Id !== container.Image) throw new Error('Source image is not locally available.');
  }
  return { status, db, auth, rest };
}

function psql(id, database, sql) {
  const input = Buffer.from(sql);
  try { return docker(['exec', '-i', id, 'psql', '-X', '-w', '-qAt', '-U', 'supabase_admin', '-d', database,
    '-v', 'ON_ERROR_STOP=1'], input); }
  finally { input.fill(0); }
}

// The exporter stays alive until the dump and every baseline query have finished.
function snapshotSession(id, database) {
  const child = spawn('docker', ['exec', '-i', id, 'psql', '-X', '-w', '-qAt', '-U', 'supabase_admin',
    '-d', database, '-v', 'ON_ERROR_STOP=1'], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let pending;
  let closed = false;
  child.stderr.resume();
  child.on('error', () => { closed = true; pending?.reject(new Error('Snapshot transport failed.')); });
  child.on('exit', () => { closed = true; pending?.reject(new Error('Snapshot transaction closed unexpectedly.')); });
  lines.on('line', line => {
    if (!pending) return;
    const current = pending; pending = undefined; clearTimeout(current.timer);
    try { current.resolve(JSON.parse(line)); } catch { current.reject(new Error('Snapshot result is not JSON.')); }
  });
  return {
    query(sql) {
      if (pending || closed) throw new Error('Snapshot connection unavailable.');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending = undefined; reject(new Error('Snapshot query timeout.')); }, 120_000);
        pending = { resolve, reject, timer };
        child.stdin.write(`${sql}\n`);
      });
    },
    async close() {
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Snapshot cancelled.')); pending = undefined; }
      if (!closed) child.stdin.end('ROLLBACK;\n');
      await Promise.race([new Promise(resolve => child.once('close', resolve)), pause(3000)]);
      if (!closed) child.kill();
      lines.close();
    }
  };
}

const namespaceFilter = "n.nspname !~ '^pg_' and n.nspname <> 'information_schema'";
const roleSQL = `select jsonb_build_object('attributes', (select jsonb_agg(to_jsonb(r)-'oid' order by rolname) from pg_authid r),
  'memberships',(select coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),
  'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,
  'inherit',inherit_option,'set',set_option) order by pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]') from pg_auth_members));`;
const inventorySQL = `select jsonb_build_object('tables', (select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname)
  order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p') and ${namespaceFilter}),
  'sequences',(select coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname) order by n.nspname,c.relname),'[]')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and ${namespaceFilter}));`;

function rowsSQL(tables) {
  return `select jsonb_object_agg(name,evidence) from (${tables.map(t => `select ${lit(`${t.schema}.${t.name}`)} name,
    jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,E'\\n' order by h),''),'UTF8')),'hex')) evidence
    from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h from ONLY ${ident(t.schema)}.${ident(t.name)} t) hashed`).join(' union all ')}) all_tables;`;
}
function sequencesSQL(sequences) {
  if (!sequences.length) return "select '{}'::jsonb;";
  return `select jsonb_object_agg(name,value) from (${sequences.map(t => `select ${lit(`${t.schema}.${t.name}`)} name,
    jsonb_build_object('last_value',last_value,'is_called',is_called) value from ${ident(t.schema)}.${ident(t.name)}`).join(' union all ')}) sequences;`;
}

const databaseSQL = `select jsonb_build_object('owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),
  'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',datlocale,'acl',coalesce(datacl,acldefault('d',datdba)),
  'grants',(select jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then null else pg_get_userbyid(a.grantee) end,
    'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
    order by pg_get_userbyid(a.grantor),pg_get_userbyid(a.grantee),a.privilege_type)
    from aclexplode(coalesce(datacl,acldefault('d',datdba))) a),
  'settings',(select coalesce(jsonb_agg(jsonb_build_object('role',case when setrole=0 then null else pg_get_userbyid(setrole) end,
  'config',setconfig) order by pg_get_userbyid(setrole)),'[]') from pg_db_role_setting where setdatabase=d.oid))
  from pg_database d where datname=current_database();`;
const catalogSQL = `select jsonb_build_object(
  'extensions',(select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'owner',pg_get_userbyid(e.extowner),
    'schema',n.nspname,'relocatable',extrelocatable,'config',(select jsonb_agg(c::regclass::text order by c::regclass::text)
    from unnest(e.extconfig) c),'condition',extcondition) order by extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace),
  'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',coalesce(n.nspacl,acldefault('n',n.nspowner)))
    order by n.nspname) from pg_namespace n where ${namespaceFilter}),
  'relations',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',relkind,'owner',pg_get_userbyid(relowner),
    'acl',coalesce(relacl,acldefault(case when relkind='S' then 's' else 'r' end::"char",relowner)),
    'rls',relrowsecurity,'forceRls',relforcerowsecurity,'options',reloptions,'replicaIdentity',relreplident)
    order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${namespaceFilter}),
  'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname),'[]') from pg_policies p
    where schemaname !~ '^pg_' and schemaname<>'information_schema'),
  'constraints',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',conname,'def',pg_get_constraintdef(k.oid,true),
    'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred) order by n.nspname,c.relname,conname)
    from pg_constraint k join pg_namespace n on n.oid=k.connamespace left join pg_class c on c.oid=k.conrelid where ${namespaceFilter}),
  'routines',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'args',pg_get_function_identity_arguments(p.oid),
    'owner',pg_get_userbyid(proowner),'acl',coalesce(proacl,acldefault('f',proowner)),'securityDefiner',prosecdef,'config',proconfig,'volatility',provolatile,
    'definition',case when p.prokind<>'a' then pg_get_functiondef(p.oid) else null end)
    order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where ${namespaceFilter}),
  'views',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'def',pg_get_viewdef(c.oid,true))
    order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('v','m') and ${namespaceFilter}),
  'defaultAcls',(select jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(defaclrole),'schema',coalesce(n.nspname,''),
    'type',defaclobjtype,'acl',defaclacl) order by pg_get_userbyid(defaclrole),n.nspname,defaclobjtype)
    from pg_default_acl a left join pg_namespace n on n.oid=a.defaclnamespace),
  'sequenceDefinitions',(select jsonb_agg(to_jsonb(s)-'last_value' order by schemaname,sequencename) from pg_sequences s
    where schemaname !~ '^pg_' and schemaname<>'information_schema'));`;

export function canonical(value, key = '') {
  if (Array.isArray(value)) {
    const items = value.map(item => canonical(item));
    return ['acl', 'schemas', 'routines', 'relations', 'views', 'policies', 'constraints', 'extensions', 'defaultAcls',
      'sequenceDefinitions'].includes(key) ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], k)]));
  return value;
}
const same = (a, b) => hash(JSON.stringify(canonical(a)) ?? 'undefined') === hash(JSON.stringify(canonical(b)) ?? 'undefined');
function requireSame(a, b, title) {
  if (!same(a, b)) {
    const changed = Object.keys(a).filter(key => !same(a[key], b?.[key]));
    const detail = changed.map(key => {
      if (!Array.isArray(a[key]) || !Array.isArray(b?.[key])) return key;
      const differences = a[key].flatMap((item, index) => same(item, b[key][index]) ? [] :
        [{ item: [item.schema, item.table, item.name, item.owner, item.type].filter(Boolean).join('.'),
          fields: Object.keys(item).filter(field => !same(item[field], b[key][index]?.[field])),
          ...(item.args ? { sourceArgs: item.args, targetArgs: b[key][index]?.args } : {}),
          ...(item.acl !== undefined && !same(item.acl, b[key][index]?.acl) ? { sourceAcl: item.acl, targetAcl: b[key][index]?.acl } : {}) }]);
      return `${key} (${differences.length} changed; ${JSON.stringify(differences.slice(0, 5))})`;
    });
    throw new Error(`${title} mismatch: ${detail.join(', ') || 'inventory'}.`);
  }
}
export const schemaText = buffer => buffer.toString('utf8').replace(/^\\(?:un)?restrict .*\r?\n/gm, '')
  .replace(/^-- (?:Started on|Completed on|Dumped from database version|Dumped by pg_dump version).*\r?\n/gm, '')
  // Effective ACLs are verified separately, including extension initial grants.
  .replace(/^(?:GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) [^\r\n]+\r?\n/gm, '')
  .replace(/^--[^\r\n]*\r?\n/gm, '')
  .replace(/\r\n/g, '\n').replace(/^\s*\n/gm, '');

function protect(bytes, reverse = false) {
  const input = Buffer.from(bytes.toString('base64'));
  let output;
  try {
    output = command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); try { $r=[Security.Cryptography.ProtectedData]::${reverse ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r)) } finally { [Array]::Clear($b,0,$b.Length); if($r){[Array]::Clear($r,0,$r.Length)} }`], input);
    return Buffer.from(output.toString().trim(), 'base64');
  } finally { input.fill(0); output?.fill(0); }
}

function encryptedBackup(filename, payload) {
  const plain = Buffer.from(JSON.stringify(payload));
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  let disk; let restoredKey; let decoded;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    writeFileSync(`${filename}.key.dpapi`, protect(key), { flag: 'wx', mode: 0o600 });
    writeFileSync(`${filename}.aes`, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]), { flag: 'wx', mode: 0o600 });
    ciphertext.fill(0);
    // Restore input must come from the persisted archive, not the original buffers.
    disk = readFileSync(`${filename}.aes`);
    restoredKey = protect(readFileSync(`${filename}.key.dpapi`), true);
    const decipher = createDecipheriv('aes-256-gcm', restoredKey, disk.subarray(0, 12));
    decipher.setAuthTag(disk.subarray(12, 28));
    decoded = Buffer.concat([decipher.update(disk.subarray(28)), decipher.final()]);
    if (hash(decoded) !== hash(plain)) throw new Error('On-disk encrypted backup round trip mismatch.');
    return { payload: JSON.parse(decoded.toString()), archiveSha256: hash(disk), bytes: disk.length };
  } finally { plain.fill(0); key.fill(0); disk?.fill(0); restoredKey?.fill(0); decoded?.fill(0); }
}

export function assertOwned(container, expected, runId) {
  if (container.Id !== expected.id || container.Name !== `/${expected.name}` || container.Config?.Labels?.[label] !== runId
    || !expected.name.startsWith(`restore-${runId}-`)) throw new Error('Disposable container ownership mismatch; refusing operation.');
}

async function run() {
  if (process.argv.length !== 2) throw new Error('No arguments accepted. This is a fixed local-only restoration rehearsal.');
  const source = sourceIdentity();
  const runId = randomUUID();
  const directory = path.join(runtime, 'backups');
  if (!existsSync(runtime) || !existsSync(directory)) throw new Error('Verified runtime/backups parent must already exist.');
  const filename = path.join(directory, `restore-rehearsal-${runId}`);
  const report = { version: 1, projectId, runId, status: 'FAILED', startedAt: new Date().toISOString(),
    source: { containerId: source.db.Id, image: source.db.Image, readOnly: true },
    format: 'AES-256-GCM, nonce12/tag16; key Windows CurrentUser DPAPI; JSON archive v1',
    checks: {}, cleanup: { containers: [], network: false },
    limits: ['Logical database restore only; no PITR certification.', 'No external storage payloads or secondary _supabase database included.',
      'Sequences and cluster roles are non-MVCC; bracketed equality checks are required.',
      'Node strings cannot be reliably zeroized; sensitive buffers are zeroed and no plaintext files are written.'] };
  const owned = [];
  const children = [];
  let network; let exporter; let server; let vite; let browser;
  let baseline; let inventory; let restored;
  const dbName = 'restored';
  const saveReport = () => writeFileSync(`${filename}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  const assertSource = () => {
    const current = inspect(source.db.Id);
    if (current.Id !== source.db.Id || current.Name !== source.db.Name || current.Image !== source.db.Image || !current.State.Running) {
      throw new Error('Source container identity/running state changed.');
    }
  };
  const create = (kind, image, args, cmd = []) => {
    const name = `restore-${runId}-${kind}`;
    const id = docker(['create', '-i', '--pull=never', '--name', name, '--label', `${label}=${runId}`, '--network', network.id,
      '--log-driver', 'none', ...args, image, ...cmd]).toString().trim();
    const entry = { name, id }; owned.push(entry); report.resources = { network, containers: owned }; saveReport();
    assertOwned(inspect(id), entry, runId); return entry;
  };
  const attach = (entry, input) => {
    assertOwned(inspect(entry.id), entry, runId);
    const child = spawn('docker', ['start', '-a', '-i', entry.id], { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.ramOutput = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      child.ramOutput.push(chunk);
      while (child.ramOutput.reduce((sum, b) => sum + b.length, 0) > 128 * 1024) child.ramOutput.shift().fill(0);
    });
    children.push(child);
    child.stdin.on('error', () => {});
    child.stdin.end(input, () => input.fill(0));
    child.on('error', () => {});
    return child;
  };
  try {
    console.log('Capturing one exported repeatable-read, read-only source snapshot; no source login or writes.');
    exporter = snapshotSession(source.db.Id, 'postgres');
    const snapshot = await exporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL search_path=pg_catalog; select jsonb_build_object('id',pg_export_snapshot(),'readOnly',current_setting('transaction_read_only'));");
    if (snapshot.readOnly !== 'on') throw new Error('Snapshot is not read-only.');
    inventory = await exporter.query(inventorySQL);
    const beforeSequences = await exporter.query(sequencesSQL(inventory.sequences));
    const roles = await exporter.query(roleSQL);
    const dbConfig = await exporter.query(databaseSQL);
    const catalog = await exporter.query(catalogSQL);
    const schemaGrants = await exporter.query(`select jsonb_agg(jsonb_build_object('schema',n.nspname,'grantee',case when a.grantee=0 then null
      else pg_get_userbyid(a.grantee) end,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by n.nspname,a.grantee,a.privilege_type) from pg_namespace n,
      lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where ${namespaceFilter};`);
    const rows = await exporter.query(rowsSQL(inventory.tables));
    const migrations = await exporter.query("select jsonb_build_object('count',count(*),'manualCredit',bool_or(version='20261012090000')) from supabase_migrations.schema_migrations;");
    if (migrations.count !== 24 || !migrations.manualCredit) throw new Error('Expected 24 migrations including manual-credit version are required.');
    const media = await exporter.query("select jsonb_build_object('objects',(select count(*) from storage.objects),'buckets',(select count(*) from storage.buckets),'vaultSecrets',(select count(*) from vault.secrets),'largeObjects',(select count(*) from pg_largeobject_metadata));");
    if (media.vaultSecrets !== 0) throw new Error('Nonempty Vault requires a separate cryptographic root-key recovery design.');
    report.phase = 'source_custom_dump';
    const dump = docker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', source.db.Id, 'pg_dump',
      '-U', 'supabase_admin', '-d', 'postgres', '-Fc', '--snapshot', snapshot.id]);
    report.phase = 'source_roles_dump';
    const rolesDump = docker(['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', source.db.Id,
      'pg_dumpall', '-U', 'supabase_admin', '--roles-only']);
    report.phase = 'source_schema_decode';
    const sourceSchema = docker(['exec', '-i', source.db.Id, 'pg_restore', '--schema-only', '--file=-'], dump);
    const afterSequences = await exporter.query(sequencesSQL(inventory.sequences));
    requireSame(beforeSequences, afterSequences, 'Source sequence bracket');
    const currentRoles = JSON.parse(psql(source.db.Id, 'postgres', `begin read only; ${roleSQL} rollback;`).toString());
    requireSame(roles, currentRoles, 'Source role bracket');
    baseline = { rows, catalog, roles, database: dbConfig, sequences: beforeSequences,
      schemaSha256: hash(schemaText(sourceSchema)), schemaGrants, migrations, media };
    report.checks.snapshotCoherent = true;
    report.checks.sequencesStableDuringBackup = true;
    report.checks.rolesStableDuringBackup = true;
    report.coverage = { tables: inventory.tables.length, rows: Object.values(rows).reduce((sum, e) => sum + e.count, 0),
      sequences: inventory.sequences.length, roles: roles.attributes.length, memberships: roles.memberships.length,
      catalog: Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, v?.length ?? 0])), migrations, media };
    report.fingerprints = { rowsSha256: hash(JSON.stringify(rows)), schemaSha256: baseline.schemaSha256,
      catalogSha256: hash(JSON.stringify(catalog)), rolesSha256: hash(JSON.stringify(roles)),
      sequencesSha256: hash(JSON.stringify(beforeSequences)), tables: rows };
    try {
      const backup = encryptedBackup(filename, { version: 1, runId, sourceImage: source.db.Image,
        dump: dump.toString('base64'), rolesDump: rolesDump.toString('base64'), inventory, baseline });
      restored = backup.payload;
      report.backup = { path: `${filename}.aes`, protectedKeyPath: `${filename}.key.dpapi`,
        sha256: backup.archiveSha256, bytes: backup.bytes, verifiedDecryptionFromDisk: true };
    } finally { dump.fill(0); rolesDump.fill(0); sourceSchema.fill(0); }
    await exporter.close(); exporter = undefined;
    saveReport();
    assertSource();

    console.log('Encrypted backup persisted and reopened. Bootstrapping an empty, RAM-backed disposable PostgreSQL cluster.');
    const networkName = `restore-${runId}-network`;
    const networkId = docker(['network', 'create', '--internal', '--label', `${label}=${runId}`, networkName]).toString().trim();
    network = { id: networkId, name: networkName };
    report.resources = { network, containers: owned }; saveReport();
    // Bypass Supabase image initialization: it precreates managed schemas/roles.
    // The same image's binaries/extensions are used against a fresh tmpfs cluster.
    const dbEntry = create('db', source.db.Image, ['--user', 'postgres', '--tmpfs', '/tmp:rw,mode=1777',
      '--entrypoint', '/bin/sh']);
    const bootstrap = "initdb -D /tmp/rehearsal-pg -U supabase_admin --auth-local=trust --auth-host=md5 >/dev/null && printf '\\nhost all all 0.0.0.0/0 md5\\n' >> /tmp/rehearsal-pg/pg_hba.conf && exec postgres -D /tmp/rehearsal-pg -c listen_addresses='*' -c unix_socket_directories=/tmp -c port=5432 -c shared_preload_libraries=pg_stat_statements";
    // Set a non-secret command using the Engine-created container's stdin shell.
    attach(dbEntry, Buffer.from(`${bootstrap}\n`));
    for (let i = 0; i < 100; i++) {
      try { docker(['exec', dbEntry.id, 'pg_isready', '-h', '/tmp', '-U', 'supabase_admin', '-d', 'postgres']); break; }
      catch { if (i === 99) throw new Error('Disposable PostgreSQL did not become ready.'); await pause(300); }
    }
    // All target SQL uses its exact owned ID and socket, never a supplied endpoint.
    const targetSQL = sql => {
      assertOwned(inspect(dbEntry.id), dbEntry, runId);
      const input = Buffer.from(sql);
      try { return docker(['exec', '-i', dbEntry.id, 'psql', '-h', '/tmp', '-X', '-w', '-qAt', '-U', 'supabase_admin',
        '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input); } finally { input.fill(0); }
    };
    const roleBuffer = Buffer.from(restored.rolesDump, 'base64');
    try {
      const roleScript = roleBuffer.toString().replace(/^CREATE ROLE supabase_admin;\r?\n/m, '');
      targetSQL(roleScript);
    } finally { roleBuffer.fill(0); restored.rolesDump = null; }
    const provider = { b: 'builtin', c: 'libc', i: 'icu' }[dbConfig.provider];
    if (!provider) throw new Error('Unsupported source locale provider.');
    targetSQL(`create database ${ident(dbName)} with template template0 owner ${ident(dbConfig.owner)} encoding ${lit(dbConfig.encoding)}
      locale_provider ${provider} lc_collate ${lit(dbConfig.collate)} lc_ctype ${lit(dbConfig.ctype)}
      ${provider === 'builtin' ? `builtin_locale ${lit(dbConfig.locale)}` : provider === 'icu' ? `icu_locale ${lit(dbConfig.locale)}` : ''};`);
    targetSQL(`set role ${ident(dbConfig.owner)}; revoke all on database ${ident(dbName)} from PUBLIC,
      ${baseline.roles.attributes.filter(r => !r.rolname.startsWith('pg_')).map(r => ident(r.rolname)).join(',')}; reset role;`);
    for (const grant of restored.baseline.database.grants) {
      targetSQL(`set role ${ident(grant.grantor)}; grant ${grant.privilege} on database ${ident(dbName)}
        to ${grant.grantee ? ident(grant.grantee) : 'PUBLIC'} ${grant.grantable ? 'with grant option' : ''}; reset role;`);
    }
    // Source database-level role settings may contain JWT config: stdin only.
    for (const setting of dbConfig.settings) for (const item of setting.config) {
      const equals = item.indexOf('=');
      targetSQL(`alter ${setting.role ? `role ${ident(setting.role)} in` : ''} database ${ident(dbName)}
        set ${ident(item.slice(0, equals))} to ${lit(item.slice(equals + 1))};`);
    }
    const targetQuery = sql => {
      assertOwned(inspect(dbEntry.id), dbEntry, runId);
      const input = Buffer.from(sql);
      try { return docker(['exec', '-i', dbEntry.id, 'psql', '-h', '/tmp', '-X', '-w', '-qAt', '-U', 'supabase_admin',
        '-d', dbName, '-v', 'ON_ERROR_STOP=1'], input); } finally { input.fill(0); }
    };
    const customDump = Buffer.from(restored.dump, 'base64');
    report.phase = 'target_custom_restore';
    try {
      assertOwned(inspect(dbEntry.id), dbEntry, runId);
      docker(['exec', '-i', dbEntry.id, 'pg_restore', '-h', '/tmp', '-U', 'supabase_admin', '-d', dbName,
        '--exit-on-error', '--single-transaction'], customDump);
    } finally { customDump.fill(0); restored.dump = null; }
    const targetEvidence = sql => JSON.parse(targetQuery(`begin isolation level repeatable read read only; set local timezone='UTC'; set local datestyle='ISO, YMD'; set local search_path=pg_catalog; ${sql} rollback;`).toString());
    // Some image-provisioned schema privileges are recorded as extension initial
    // privileges and omitted by pg_dump. Reapply only differing schemas from the
    // encrypted snapshot evidence; never weaken a comparison or touch the source.
    const initialCatalog = targetEvidence(catalogSQL);
    report.phase = 'target_initial_privileges';
    for (const schema of baseline.catalog.schemas) {
      if (same({ acl: schema.acl }, { acl: initialCatalog.schemas.find(s => s.name === schema.name)?.acl })) continue;
      const principals = [null, ...baseline.roles.attributes.filter(r => !r.rolname.startsWith('pg_')).map(r => r.rolname)];
      targetQuery(`set role ${ident(schema.owner)}; revoke all on schema ${ident(schema.name)} from ${principals.map(p => p ? ident(p) : 'PUBLIC').join(',')}; reset role;`);
      for (const grant of restored.baseline.schemaGrants.filter(g => g.schema === schema.name)) {
        targetQuery(`set role ${ident(grant.grantor)}; grant ${grant.privilege} on schema ${ident(grant.schema)}
          to ${grant.grantee ? ident(grant.grantee) : 'PUBLIC'} ${grant.grantable ? 'with grant option' : ''}; reset role;`);
      }
    }
    report.phase = 'target_baseline_comparison';
    requireSame(inventory, targetEvidence(inventorySQL), 'Restored inventory');
    requireSame(baseline.rows, targetEvidence(rowsSQL(inventory.tables)), 'Restored rows');
    requireSame(baseline.roles, targetEvidence(roleSQL), 'Restored role attributes/passwords/memberships');
    requireSame(baseline.catalog, targetEvidence(catalogSQL), 'Restored security/schema catalogs');
    requireSame(baseline.sequences, targetEvidence(sequencesSQL(inventory.sequences)), 'Restored sequences');
    requireSame(baseline.database, targetEvidence(databaseSQL), 'Restored database settings/owner');
    report.phase = 'target_schema_dump'; saveReport();
    const targetSchema = docker(['exec', dbEntry.id, 'pg_dump', '-h', '/tmp', '-U', 'supabase_admin', '-d', dbName,
      '--schema-only', '--lock-wait-timeout=10s']);
    try {
      if (hash(schemaText(targetSchema)) !== baseline.schemaSha256) throw new Error('Restored full logical schema fingerprint mismatch.');
    } finally { targetSchema.fill(0); }
    report.checks.restoredAllRows = true; report.checks.restoredSchemaSecurity = true;
    report.checks.restoredRolesPasswordsIdentities = true; report.checks.restoredSequences = true;
    saveReport();
    console.log(`Restored baseline matches: ${report.coverage.tables} tables, ${report.coverage.rows} rows, 24 migrations. Starting restored-only Auth/REST probes.`);
    report.phase = 'target_auth_rest_browser';
    await probeRestored({ source, runId, network, create, attach, dbEntry, dbName, targetEvidence, report,
      setResources: resources => { server = resources.server; vite = resources.vite; browser = resources.browser; } });
    const finalRows = targetEvidence(rowsSQL(inventory.tables));
    const protectedRows = Object.fromEntries(Object.entries(baseline.rows).filter(([name]) => !name.startsWith('auth.')));
    requireSame(protectedRows, Object.fromEntries(Object.keys(protectedRows).map(name => [name, finalRows[name]])), 'Post-probe financial/non-Auth rows');
    report.checks.financialAndNonAuthRowsUnchangedAfterProbes = true;
    assertSource();
    exporter = snapshotSession(source.db.Id, 'postgres');
    await exporter.query("begin isolation level repeatable read read only; set local timezone='UTC'; set local search_path=pg_catalog; select jsonb_build_object('readOnly',current_setting('transaction_read_only'));");
    const sourceEnd = await exporter.query(rowsSQL(inventory.tables));
    const sourceChanged = Object.keys(baseline.rows).filter(name => !same(baseline.rows[name], sourceEnd[name]));
    report.sourceEnd = { unchanged: sourceChanged.length === 0, changedTables: sourceChanged,
      rowsSha256: hash(JSON.stringify(sourceEnd)) };
    requireSame(baseline.catalog, await exporter.query(catalogSQL), 'Source end schema');
    requireSame(baseline.roles, await exporter.query(roleSQL), 'Source end roles');
    requireSame(baseline.sequences, await exporter.query(sequencesSQL(inventory.sequences)), 'Source end sequences');
    await exporter.close(); exporter = undefined;
    if (sourceChanged.length) throw new Error('Source changed concurrently; preservation is unverified. No source data will be repaired.');
    report.checks.sourceUnchangedAtEnd = true;
    report.status = 'PASSED';
  } catch (error) {
    report.failure = error.message;
    report.failureLocation = error.stack?.split('\n').find(line => /restore-rehearsal\.mjs:\d+:\d+/.test(line))?.trim();
    console.error(`Failure phase: ${report.phase || 'guard/bootstrap'}`);
    report.status = 'FAILED';
    console.error(`Rehearsal FAILED: ${error.message}`);
    saveReport();
  } finally {
    await exporter?.close();
    if (baseline && !report.sourceEnd) {
      try {
        assertSource();
        const query = sql => JSON.parse(psql(source.db.Id, 'postgres', `begin isolation level repeatable read read only;
          set local timezone='UTC'; set local search_path=pg_catalog; ${sql} rollback;`).toString());
        const sourceEnd = query(rowsSQL(inventory.tables));
        const changedTables = Object.keys(baseline.rows).filter(name => !same(baseline.rows[name], sourceEnd[name]));
        report.sourceEnd = { unchanged: changedTables.length === 0, changedTables, rowsSha256: hash(JSON.stringify(sourceEnd)) };
        report.checks.sourceUnchangedAtEnd = !changedTables.length && same(baseline.roles, query(roleSQL))
          && same(baseline.catalog, query(catalogSQL)) && same(baseline.sequences, query(sequencesSQL(inventory.sequences)));
      } catch { report.checks.sourceUnchangedAtEnd = false; }
    }
    await browser?.close().catch(() => {}); await vite?.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
    for (const entry of [...owned].reverse()) {
      try {
        assertOwned(inspect(entry.id), entry, runId);
        docker(['rm', '-f', entry.id]);
        report.cleanup.containers.push({ id: entry.id, name: entry.name, ownershipVerified: true, removed: true });
      } catch { report.status = 'FAILED'; report.cleanup.containers.push({ name: entry.name, removed: false }); }
    }
    for (const child of children) { child.kill(); child.ramOutput?.forEach(b => b.fill(0)); }
    if (network) {
      try {
        const n = JSON.parse(docker(['network', 'inspect', network.id]).toString())[0];
        if (n.Id !== network.id || n.Name !== network.name || n.Labels?.[label] !== runId || Object.keys(n.Containers || {}).length) throw new Error('Network ownership mismatch.');
        docker(['network', 'rm', network.id]); report.cleanup.network = true;
      } catch { report.status = 'FAILED'; }
    }
    report.finishedAt = new Date().toISOString();
    saveReport();
    restored = null;
    console.log(JSON.stringify({ status: report.status, reportPath: `${filename}.json`, backupPath: report.backup?.path,
      coverage: report.coverage, checks: report.checks, sourceEnd: report.sourceEnd, cleanup: report.cleanup }, null, 2));
    if (report.status !== 'PASSED') process.exitCode = 1;
  }
}

const envMap = container => Object.fromEntries(container.Config.Env.map(item => {
  const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)];
}));
const jwtRole = token => {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role; } catch { return undefined; }
};

async function probeRestored({ source, runId, create, attach, dbEntry, dbName, targetEvidence, report, setResources }) {
  const authConfig = envMap(source.auth);
  const restConfig = envMap(source.rest);
  const publicKey = source.status.ANON_KEY;
  if (jwtRole(publicKey) !== 'anon') throw new Error('Only the public anon key may be used for probes.');
  const authDb = new URL(authConfig.GOTRUE_DB_DATABASE_URL);
  const restDb = new URL(restConfig.PGRST_DB_URI);
  for (const url of [authDb, restDb]) {
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== source.db.Name.slice(1)
      || url.pathname !== '/postgres') throw new Error('Source service DB config does not identify the verified local container.');
    url.hostname = dbEntry.name; url.port = '5432'; url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
  }
  authConfig.GOTRUE_DB_DATABASE_URL = authDb.href;
  authConfig.GOTRUE_API_HOST = '0.0.0.0';
  authConfig.GOTRUE_API_PORT = '9999';
  authConfig.API_EXTERNAL_URL = 'http://127.0.0.1:9999';
  authConfig.GOTRUE_SITE_URL = 'http://127.0.0.1';
  authConfig.GOTRUE_URI_ALLOW_LIST = 'http://127.0.0.1';
  authConfig.GOTRUE_DISABLE_SIGNUP = 'true';
  authConfig.GOTRUE_SMTP_HOST = '127.0.0.1';
  for (const key of Object.keys(authConfig)) if (/^GOTRUE_EXTERNAL_.*_ENABLED$/.test(key)) authConfig[key] = 'false';
  authConfig.GOTRUE_EXTERNAL_EMAIL_ENABLED = 'true';
  restConfig.PGRST_DB_URI = restDb.href;
  restConfig.PGRST_SERVER_HOST = '0.0.0.0'; restConfig.PGRST_SERVER_PORT = '3000';
  delete restConfig.PGRST_ADMIN_SERVER_PORT;
  const shell = 'while IFS= read -r line; do [ "$line" = END ] && break; key=${line%%:*}; value=${line#*:}; value=$(printf "%s" "$value" | base64 -d); export "$key=$value"; done; exec auth';
  // Secrets travel through stdin into process RAM, not Docker Config.Env/args or files.
  const authEntry = create('auth', source.auth.Image, ['--entrypoint', '/bin/sh',
    '--read-only', '--tmpfs', '/tmp:rw,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'], ['-c', shell]);
  const authInput = Buffer.from(Object.entries(authConfig).filter(([key]) => /^(?:GOTRUE_|API_EXTERNAL_URL$)/.test(key))
    .map(([key, value]) => `${key}:${Buffer.from(value).toString('base64')}`).join('\n') + '\nEND\n');
  const authProcess = attach(authEntry, authInput);
  const restEntry = create('rest', source.rest.Image, ['--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges'], ['/bin/postgrest', '/dev/stdin']);
  const restInput = Buffer.from(Object.entries(restConfig).filter(([key]) => key.startsWith('PGRST_'))
    .map(([key, value]) => `${key.slice(6).toLowerCase().replaceAll('_', '-')} = ${['PGRST_SERVER_PORT', 'PGRST_DB_MAX_ROWS'].includes(key) ? Number(value) : JSON.stringify(value)}`).join('\n'));
  const restProcess = attach(restEntry, restInput);
  const processDiagnostic = child => {
    const output = Buffer.concat(child.ramOutput || []);
    try {
      return { outputSha256: hash(output), categories: [...new Set(output.toString().match(
        /password authentication failed|permission denied|connection refused|no such file or directory|read-only file system|invalid configuration|invalid input|not found|no route to host|name resolution|database migration|failed to load|failed to connect|config file|parse error|SQLSTATE [A-Z0-9]{5}|PGRST\d{3}|GOTRUE_[A-Z_]+|db-max-rows|jwt-secret|no pg_hba.conf entry/gi) || [])] };
    } finally { output.fill(0); }
  };
  const readyContainer = async (entry, containerPort) => {
    for (let i = 0; i < 100; i++) {
      const container = inspect(entry.id);
      assertOwned(container, entry, runId);
      if (container.State.Running) return;
      if (container.State.Status === 'exited') {
        throw new Error(`Restored ${containerPort === 9999 ? 'Auth' : 'REST'} exited (code ${container.State.ExitCode}, diagnostic ${JSON.stringify(processDiagnostic(containerPort === 9999 ? authProcess : restProcess))}).`);
      }
      await pause(200);
    }
    throw new Error('Restored service did not start.');
  };
  await readyContainer(authEntry, 9999);
  await readyContainer(restEntry, 3000);
  const authOrigin = `http://${authEntry.name}:9999`;
  const restOrigin = `http://${restEntry.name}:3000`;
  // Internal networks deliberately have no published ports. curl runs in the
  // owned DB container; request config (including Auth bodies/JWTs) is stdin-only.
  const internal = (origin, suffix, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    assertOwned(inspect(dbEntry.id), dbEntry, runId);
    if (![authOrigin, restOrigin].includes(origin) || !suffix.startsWith('/') || suffix.startsWith('//') || /[\r\n]/.test(suffix)) {
      throw new Error('Internal request endpoint rejected.');
    }
    const config = Buffer.from([`url = ${JSON.stringify(origin + suffix)}`, `request = ${JSON.stringify(method)}`,
      ...Object.entries(headers).filter(([key]) => !/^(?:host|connection|content-length|accept-encoding)$/i.test(key))
        .map(([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`),
      ...(body === undefined ? [] : [`data = ${JSON.stringify(body)}`])].join('\n'));
    const child = spawn('docker', ['exec', '-i', dbEntry.id, 'curl', '--silent', '--show-error', '--max-time', '25',
      '--include', '--config', '-'], { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdin.end(config, () => config.fill(0));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Internal HTTP transport failed.')); });
    child.on('close', code => {
      clearTimeout(timer); const output = Buffer.concat(chunks); chunks.forEach(b => b.fill(0));
      try {
        if (code !== 0) throw new Error(`Internal HTTP transport exited (${code}).`);
        const boundary = output.indexOf('\r\n\r\n');
        if (boundary < 0) throw new Error('Internal HTTP response header missing.');
        const lines = output.subarray(0, boundary).toString().split('\r\n');
        const status = Number(lines.shift().match(/^HTTP\/\S+ (\d{3})/)?.[1]);
        if (!status) throw new Error('Internal HTTP status invalid.');
        const responseHeaders = Object.fromEntries(lines.filter(line => line.includes(':')).map(line => {
          const index = line.indexOf(':'); return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }));
        resolve({ status, headers: responseHeaders, body: Buffer.from(output.subarray(boundary + 4)) });
      } catch (error) { reject(error); } finally { output.fill(0); config.fill(0); }
    });
  });
  let healthy = false;
  let healthStatus;
  for (let i = 0; i < 100; i++) {
    const results = await Promise.allSettled([internal(authOrigin, '/health'),
      internal(restOrigin, '/', 'GET', { Authorization: `Bearer ${publicKey}` })]);
    healthStatus = results.map(result => result.status === 'fulfilled' ? result.value.status : result.reason.message);
    for (const result of results) if (result.status === 'fulfilled') result.value.body.fill(0);
    if (healthStatus.every(status => status === 200)) { healthy = true; break; }
    if ([authEntry, restEntry].some(entry => inspect(entry.id).State.Status === 'exited')) break;
    await pause(300);
  }
  if (!healthy) throw new Error(`Restored health failed: ${JSON.stringify({ statuses: healthStatus,
    auth: processDiagnostic(authProcess), rest: processDiagnostic(restProcess) })}.`);
  // GoTrue's version may inspect its own migration ledger on startup. No app migration is executed.
  const ownSede = '30000000-0000-0000-0000-000000000001';
  const foreignSede = '30000000-0000-0000-0000-000000000002';
  const student = '10000000-0000-0000-0000-000000000001';
  const http = async (actor, route, body) => {
    let origin; let suffix;
    if (route.startsWith('/auth/v1/') && /^\/auth\/v1\/(?:token\?grant_type=password|user)$/.test(route)) {
      origin = authOrigin; suffix = route.slice('/auth/v1'.length);
    } else if (route.startsWith('/rest/v1/')) { origin = restOrigin; suffix = route.slice('/rest/v1'.length); }
    else throw new Error('Probe route is not allowlisted.');
    if (actor && jwtRole(actor.token) !== 'authenticated') throw new Error('Probe JWT is not authenticated.');
    const response = await internal(origin, suffix, body === undefined ? 'GET' : 'POST', { apikey: publicKey,
      Authorization: `Bearer ${actor?.token || publicKey}`, 'Content-Type': 'application/json' }, body === undefined ? undefined : JSON.stringify(body));
    let data; try { const text = response.body.toString(); data = text ? JSON.parse(text) : null; }
    catch { throw new Error('Restored API returned non-JSON.'); } finally { response.body.fill(0); }
    return { status: response.status, data };
  };
  const ok = async (actor, route, body) => {
    const result = await http(actor, route, body);
    if (result.status < 200 || result.status > 299) throw new Error(`Restored probe rejected: HTTP ${result.status}, path ${route.split('?')[0]}.`);
    return result.data;
  };
  const actors = [];
  const actorRoles = ['tallerista', 'tallerista', 'tallerista', 'staff', 'super_admin'];
  for (let i = 0; i < testEmails.length; i++) {
    const result = await ok(null, '/auth/v1/token?grant_type=password', { email: testEmails[i], password: testPassword });
    if (jwtRole(result.access_token) !== 'authenticated' || result.user.email !== testEmails[i]) throw new Error('Restored Auth identity mismatch.');
    const actor = { id: result.user.id, token: result.access_token };
    const user = await ok(actor, '/auth/v1/user');
    if (user.id !== actor.id) throw new Error('Restored Auth user lookup mismatch.');
    const profile = await ok(actor, `/rest/v1/profiles?select=id,role&id=eq.${actor.id}`);
    if (profile.length !== 1 || profile[0].role !== actorRoles[i]) throw new Error('Restored profile role mismatch.');
    actors.push(actor);
  }
  report.probes = { authLogins: actors.length, authUserReads: actors.length, profileReads: actors.length,
    scopedRestReads: 0, ownerOnlyDenials: 0, domainReadAllowed: 0, domainReadDenied: 0, receiptReplays: 0 };
  const [owner, foreign, reader, employee, supervisor] = actors;
  const views = ['student_credit_profile', 'manual_credit_entitlements_with_balance', 'session_pending_penalties'];
  for (const view of views) {
    const ownedRows = await ok(owner, `/rest/v1/${view}?select=*&sede_id=eq.${ownSede}`);
    const observedCount = targetEvidence(`select jsonb_build_object('count',count(*)) from public.${ident(view)} where sede_id=${lit(ownSede)}::uuid;`).count;
    if (ownedRows.length !== observedCount) throw new Error('Restored owner view count mismatch (including potential pagination).');
    report.probes.scopedRestReads++;
    for (const actor of [foreign, reader]) {
      const hiddenRows = await ok(actor, `/rest/v1/${view}?select=*&sede_id=eq.${ownSede}`);
      if (hiddenRows.length) throw new Error('Restored scoped view leaked rows.');
      report.probes.scopedRestReads++;
    }
  }
  for (const actor of [employee, supervisor]) {
    const projection = await ok(actor, `/rest/v1/student_credit_profile?select=*&sede_id=eq.${ownSede}`);
    if (!projection.length || projection.some(row => row.can_approve_manual_credit || row.can_reconcile_legacy)) {
      throw new Error('Restored nonowner profile has manual-credit authority.');
    }
    report.probes.scopedRestReads++;
  }
  const replay = targetEvidence(`select jsonb_build_object('request_key',e.request_key,'intent',e.intent,'result',e.result)
    from public.student_manual_credit_entitlements e join public.sedes s on s.id=e.sede_id
    where s.owner_id=${lit(owner.id)}::uuid order by e.created_at,e.id limit 1;`);
  if (!replay?.request_key || !replay.intent) throw new Error('An existing manual-credit receipt is required; no fixture writes are allowed.');
  const replayArgs = Object.fromEntries(Object.entries(replay.intent).map(([key, value]) => [`p_${key}`, value]));
  replayArgs.p_request_key = replay.request_key;
  const replayResult = await ok(owner, '/rest/v1/rpc/approve_student_manual_credit', replayArgs);
  requireSame({ ...replay.result, replayed: true }, replayResult, 'Restored existing receipt exact-intent replay');
  report.probes.receiptReplays++;
  for (const actor of [foreign, reader, employee, supervisor]) {
    const rejected = await http(actor, '/rest/v1/rpc/approve_student_manual_credit', replayArgs);
    if (rejected.status !== 403 || rejected.data?.code !== '42501') throw new Error('Restored owner-only denial failed.');
    report.probes.ownerOnlyDenials++;
  }
  const principal = targetEvidence(`select jsonb_build_object('active',exists(select 1 from private.domain_read_principals
    where user_id=${lit(reader.id)}::uuid and enabled and revoked_at is null and expires_at>now()),
    'grants',(select count(*) from private.domain_read_grants where user_id=${lit(reader.id)}::uuid and sede_id=${lit(ownSede)}::uuid
    and student_id=${lit(student)}::uuid and enabled and revoked_at is null and expires_at>now()));`);
  if (!principal.active || principal.grants !== 2) throw new Error('Restored reader grants have expired or changed; no renewal will be performed.');
  for (const operation of ['student.summary.get', 'membership.status.get']) {
    const request = { version: 1, operation, sedeId: ownSede, studentId: student };
    const result = await ok(reader, '/rest/v1/rpc/domain_read_v1', { p_request: request });
    if (result.version !== 1 || result.operation !== operation || result.data?.studentId !== student) throw new Error('Restored domain read projection mismatch.');
    report.probes.domainReadAllowed++;
    const denied = await http(reader, '/rest/v1/rpc/domain_read_v1', { p_request: { ...request, sedeId: foreignSede } });
    if (denied.status !== 403 || denied.data?.code !== '42501') throw new Error('Restored domain read scope denial failed.');
    report.probes.domainReadDenied++;
  }
  report.checks.restoredAuthAndRest = true;

  const server = httpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const authRoute = /^\/auth\/v1\/(?:token|user|logout|health)$/.test(url.pathname);
      const restRead = /^\/rest\/v1\/[a-z_]+$/.test(url.pathname) && req.method === 'GET';
      // Browser is read-only except its own restored Auth sessions. No RPC or admin calls.
      const credential = req.headers.authorization?.replace(/^Bearer /i, '');
      if ((!authRoute && !restRead) || !['GET', 'POST'].includes(req.method)
        || (req.headers.apikey && req.headers.apikey !== publicKey)
        || (credential && !['anon', 'authenticated'].includes(jwtRole(credential)))) {
        res.writeHead(403); res.end('{}'); return;
      }
      const origin = authRoute ? authOrigin : restOrigin;
      const prefix = authRoute ? '/auth/v1' : '/rest/v1';
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      let response;
      try { response = await internal(origin, `${url.pathname.slice(prefix.length)}${url.search}`, req.method,
        headers, body.length ? body.toString() : undefined); }
      finally { body.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
      res.statusCode = response.status;
      for (const [key, value] of Object.entries(response.headers)) if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(key)) res.setHeader(key, value);
      res.end(response.body, () => response.body.fill(0));
    } catch { res.writeHead(502); res.end('{}'); }
  });
  setResources({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxyOrigin = `http://127.0.0.1:${server.address().port}`;
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const oldViteEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')));
  for (const key of Object.keys(oldViteEnv)) delete process.env[key];
  process.env.VITE_SUPABASE_URL = proxyOrigin;
  process.env.VITE_SUPABASE_ANON_KEY = publicKey;
  const cacheDir = path.join(runtime, 'backups', `restore-${runId}-vite-cache`);
  let vite; let browser;
  try {
    vite = await createServer({ root, configFile: false, envDir: false, cacheDir, logLevel: 'silent', plugins: [react()],
      resolve: { alias: { '@': root } }, optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false, cors: false } });
    setResources({ server, vite });
    await vite.listen();
    const frontend = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--disable-background-networking'] });
    setResources({ server, vite, browser });
    report.browser = { desktop: false, mobile: false, realRestoredBackend: true, artifacts: false, externalRequestsBlocked: true };
    for (const [kind, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      let unexpected = 0; let pageErrors = 0; let profileRead = false; let authLogin = false;
      try {
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if ([frontend, proxyOrigin].includes(url.origin)) return route.continue();
          if (url.hostname === 'cdn.tailwindcss.com' && route.request().resourceType() === 'script') {
            return route.fulfill({ contentType: 'application/javascript', body: 'globalThis.tailwind={config:{}};' });
          }
          if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.fulfill({ contentType: 'text/css', body: '' });
          unexpected++; return route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', socket => socket.close());
        const page = await context.newPage();
        page.on('pageerror', () => pageErrors++);
        page.on('response', async response => {
          const url = new URL(response.url());
          if (url.origin !== proxyOrigin || !response.ok()) return;
          if (url.pathname === '/auth/v1/token') authLogin = true;
          if (url.pathname === '/rest/v1/profiles') {
            try { const result = await response.json(); profileRead = result.id === owner.id && result.role === 'tallerista'; } catch {}
          }
        });
        await page.goto(`${frontend}/login`);
        await page.getByLabel('Correo electr\u00f3nico', { exact: true }).fill(testEmails[0]);
        await page.getByLabel('Contrase\u00f1a', { exact: true }).fill(testPassword);
        await page.getByRole('button', { name: 'Iniciar sesi\u00f3n', exact: true }).click();
        await page.waitForURL(`${frontend}/dashboard`, { timeout: 45_000 });
        await page.waitForTimeout(2500);
        if (!profileRead || !authLogin || unexpected || pageErrors) {
          throw new Error(`Browser ${kind} verification failed (profile=${profileRead}, login=${authLogin}, blockedUnexpected=${unexpected}, pageErrors=${pageErrors}).`);
        }
        report.browser[kind] = true;
      } catch (error) {
        if (error.message.startsWith('Browser ')) throw error;
        throw new Error(`Browser ${kind} basic login/profile failed; diagnostics and credential artifacts suppressed.`);
      } finally { await context.close(); }
    }
    report.checks.restoredBrowser = true;
  } finally {
    await browser?.close(); await vite?.close();
    for (const key of Object.keys(process.env)) if (key.startsWith('VITE_')) delete process.env[key];
    Object.assign(process.env, oldViteEnv);
    if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });
    setResources({ server });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
