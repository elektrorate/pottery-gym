import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const projectId = 'pottery-gym-local-staging';
export const runtime = path.join(os.tmpdir(), 'opencode', projectId);
export const apiUrl = 'http://127.0.0.1:55321';
export const frontendUrl = 'http://127.0.0.1:3017';
export const dbContainer = `supabase_db_${projectId}`;
export const testPassword = 'LocalStaging2026!';
export const testEmails = ['staff@pottery.local', 'other@pottery.local', 'reader@pottery.local', 'employee@pottery.local', 'supervisor@pottery.local'];

export const redact = text => String(text || '')
  .replace(/("[^"\r\n]*(?:secret|service[_-]?role|password|access[_-]?(?:token|key))[^"\r\n]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted credential]"')
  .replace(/(^|\n)(\s*[A-Z_]*(?:SECRET|SERVICE_ROLE|PASSWORD|ACCESS_TOKEN|ACCESS_KEY)[A-Z_]*\s*=)[^\r\n]*/gi, '$1$2[redacted credential]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]')
  .replace(/sb_secret_[A-Za-z0-9_-]+/g, '[redacted key]')
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted database URL]');

export const pipeRedactedLines = (stream, output) => {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const end = pending.lastIndexOf('\n');
    if (end >= 0) {
      output.write(redact(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    }
  });
  stream.on('end', () => { if (pending) output.write(redact(pending)); });
};

export const cliCommand = args => {
  if (process.platform !== 'win32') return { file: 'supabase', args };
  const binary = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'supabase', 'node_modules',
    `@supabase/cli-windows-${process.arch}`, 'bin', 'supabase.exe');
  if (!existsSync(binary)) throw new Error('Installed native Supabase CLI not found; no shell or descendant shim is used.');
  return { file: binary, args };
};

export const cli = (args, timeout = 900_000) => {
  const command = cliCommand([...args, '--workdir', runtime]);
  try {
    return execFileSync(command.file, command.args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`Local Supabase command failed: ${redact(error.stdout)} ${redact(error.stderr)}`);
  }
};

export const assertRuntime = () => {
  const marker = JSON.parse(readFileSync(path.join(runtime, 'local-staging.json'), 'utf8'));
  const config = readFileSync(path.join(runtime, 'supabase', 'config.toml'), 'utf8');
  if (marker.projectId !== projectId || marker.source !== root || !config.includes(`project_id = "${projectId}"`)
      || existsSync(path.join(runtime, 'supabase', '.temp', 'project-ref'))) {
    throw new Error('Runtime identity mismatch or remote link found. Refusing to operate.');
  }
};

export const localStatus = () => {
  assertRuntime();
  const status = JSON.parse(cli(['status', '--output', 'json'], 120_000));
  if (status.API_URL !== apiUrl || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:55322\/postgres$/.test(status.DB_URL || '')
      || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Expected isolated loopback staging endpoints are unavailable.');
  return status;
};

export const localFetch = async (route, { key, token = key, ...options } = {}) => {
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Local API path required.');
  const response = await fetch(`${apiUrl}${route}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.text();
  if (!response.ok) {
    let message = 'Request rejected';
    try { const error = JSON.parse(body); message = error.message || error.msg || error.error_description || error.error || message; } catch {}
    throw new Error(`Local staging HTTP ${response.status}: ${redact(message)}`);
  }
  return body ? JSON.parse(body) : null;
};
