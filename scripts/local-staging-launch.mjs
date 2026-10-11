import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { root, runtime, projectId, apiUrl, frontendUrl, assertRuntime } from './local-staging-runtime.mjs';

assertRuntime();
try {
  const response = await fetch(`${frontendUrl}/__local-staging`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
  const existing = await response.json();
  if (existing.projectId === projectId && existing.apiUrl === apiUrl) {
    console.log(`Local staging is already running: ${frontendUrl}`);
    process.exit(0);
  }
  throw new Error('Port 3017 belongs to a different server; it will not be replaced.');
} catch (error) {
  if (error.message.includes('different server')) throw error;
}
const stdout = openSync(path.join(runtime, 'frontend.log'), 'a');
const stderr = openSync(path.join(runtime, 'frontend-error.log'), 'a');
try {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'local-staging-frontend.mjs')], {
    cwd: root, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true
  });
  child.unref();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`${frontendUrl}/__local-staging`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      const identity = await response.json();
      if (identity.projectId === projectId && identity.apiUrl === apiUrl && identity.pid === child.pid) { ready = true; break; }
    } catch {}
  }
  if (!ready) throw new Error('Local frontend did not start. Inspect local staging logs; no foreign process was stopped.');
  console.log(`Local staging frontend ready: ${frontendUrl}`);
} finally { closeSync(stdout); closeSync(stderr); }
