import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately excludes operations.spec.ts: it requires a separately approved
// isolated real backend, and must never fall back to the configured remote URL.
const files = [
  'student-lifecycle', 'student-lifecycle-ui', 'student-membership-ops',
  'domain-read', 'session-atomic-ops', 'attendance-history',
  'gift-card-ui', 'calendar-atomic-ui', 'dashboard-integrity-ui', 'business-policy-ui', 'session-policy-ops',
  'student-credit-ui', 'student-credit-ops', 'student-credit-projection', 'session-manual-credit-ops', 'calendar-manual-credit-ui',
  'data-pagination', 'data-provider-integrity', 'auth-provider-integrity', 'operation-scope-integrity', 'mixed-session-ops'
].map(name => `tests/e2e/${name}.spec.ts`);
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, cacheDir: path.join(root, 'node_modules', '.cache', 'local-regression-vite'), configFile: false, envDir: false, plugins: [react()],
  server: { host: '127.0.0.1', port: 0, hmr: false } });
try {
  await server.listen();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)),
      'test', ...files, '--reporter=list'], { cwd: root, stdio: 'inherit',
      env: { ...process.env, BASE_URL: server.resolvedUrls.local[0] } });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally { await server.close(); }
