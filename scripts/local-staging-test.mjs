import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { apiUrl, frontendUrl, localStatus, projectId, redact, root, testPassword } from './local-staging-runtime.mjs';
import { prepareBusinessFixtures } from './local-staging-business-fixtures.mjs';
import { prepareManualCreditFixtures } from './local-staging-manual-credit-fixtures.mjs';

const filename = fileURLToPath(import.meta.url);
const specs = ['local-staging-integration.spec.ts', 'local-staging-business-rules.spec.ts', 'local-staging-manual-credits.spec.ts'];

// This file is also the isolated Playwright config. Never inherit the main
// config's production fallback, artifact capture, or other test files.
export default {
  testDir: path.join(root, 'tests', 'e2e'),
  testMatch: specs,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  // Read-recovery cases reload all preserved QA pages several times, serially.
  globalTimeout: 1_200_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  preserveOutput: 'never',
  outputDir: path.join(root, 'test-results', 'local-staging'),
  use: {
    baseURL: frontendUrl,
    headless: true,
    serviceWorkers: 'block',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
  }
};

async function run() {
  if (process.argv.length > 2) throw new Error('No arguments accepted: this runner executes only its three allowlisted local specs.');
  // localStatus captures privileged status fields in this process only. Pass
  // only its public anon key to the child, never the status object itself.
  const anonKey = localStatus().ANON_KEY;
  const claims = JSON.parse(Buffer.from(anonKey.split('.')[1] || '', 'base64url').toString());
  if (claims.role !== 'anon') throw new Error('Local staging requires the public anon key.');

  let ready = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(`${frontendUrl}/__local-staging`, {
        redirect: 'error', signal: AbortSignal.timeout(2000)
      });
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    let identity;
    try { identity = await response.json(); } catch { /* Reject non-staging servers. */ }
    if (!response.ok || identity?.projectId !== projectId || identity?.apiUrl !== apiUrl
      || identity?.frontendUrl !== frontendUrl) {
      throw new Error('Frontend staging identity mismatch. Refusing to start Playwright.');
    }
    ready = true;
    break;
  }
  if (!ready) throw new Error('Frontend not ready at http://127.0.0.1:3017 within 15 seconds. No tests or fixture writes were started.');

  const health = await fetch(`${apiUrl}/auth/v1/health`, {
    headers: { apikey: anonKey }, redirect: 'error', signal: AbortSignal.timeout(5000)
  }).catch(() => null);
  if (!health?.ok) throw new Error('Isolated local Auth API is not healthy. No tests were started.');

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:SERVICE_ROLE|SECRET|TOKEN|PASSWORD|(?:API|ACCESS)[_-]?KEY|DATABASE_URL|DB_URL|JWT)/i.test(key)
      || /^(?:TEST_|SUPABASE_|VITE_|BASE_URL$|PLAYWRIGHT_|DEBUG$|PWDEBUG$)/i.test(key)) delete env[key];
  }
  env.TEST_LOCAL_SUPABASE_ANON_KEY = anonKey;
  env.TEST_LOCAL_POLICY_FIXTURES = JSON.stringify(prepareBusinessFixtures());
  // Full public raw snapshots can exceed a Windows environment value limit.
  env.TEST_LOCAL_MANUAL_CREDIT_FIXTURES = deflateRawSync(Buffer.from(JSON.stringify(prepareManualCreditFixtures()))).toString('base64');
  env.BASE_URL = frontendUrl;
  env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  console.log(`Running existing integration, policy2 and manual-credit scenarios on ${frontendUrl} and ${apiUrl}; one worker, no cleanup.`);
  const child = spawn(process.execPath, [cli, 'test', '--config', filename, ...specs, '--workers=1', '--retries=0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  // Buffer complete lines so a token split across pipe chunks cannot escape
  // redaction. Playwright artifacts and credential-bearing traces are disabled.
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let pending = '';
    const safe = text => redact(text)
      .replace(/("(?:refresh_token|authorization|apikey)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted credential]"')
      .replaceAll(anonKey, '[redacted public key]').replaceAll(testPassword, '[redacted password]');
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const boundary = pending.lastIndexOf('\n');
      if (boundary >= 0) {
        output.write(safe(pending.slice(0, boundary + 1)));
        pending = pending.slice(boundary + 1);
      }
    });
    stream.on('end', () => { if (pending) output.write(safe(pending)); });
  }
  process.once('SIGINT', () => child.kill());
  process.once('SIGTERM', () => child.kill());
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not start the isolated Playwright CLI.')));
    child.once('close', code => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  run().catch(error => {
    console.error(redact(error.message));
    process.exitCode = 1;
  });
}
