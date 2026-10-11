import { execFileSync } from 'node:child_process';
import { cli, projectId, apiUrl, frontendUrl, assertRuntime, redact } from './local-staging-runtime.mjs';

try {
  assertRuntime();
  try {
    const response = await fetch(`${frontendUrl}/__local-staging`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    const running = await response.json();
    if (running.projectId === projectId && running.apiUrl === apiUrl && Number.isSafeInteger(running.pid)) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(running.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(running.pid);
    }
  } catch { /* An already stopped or foreign frontend is never killed. */ }
  cli(['stop']);
  console.log('Stopped only pottery-gym-local-staging; its database snapshot is retained.');
} catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
