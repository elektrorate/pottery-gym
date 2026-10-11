import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { localStatus, root, runtime, projectId, apiUrl, frontendUrl, cliCommand, redact, pipeRedactedLines } from './local-staging-runtime.mjs';

const status = localStatus();
process.env.VITE_SUPABASE_URL = apiUrl;
process.env.VITE_SUPABASE_ANON_KEY = status.ANON_KEY;
if (Object.keys(process.env).some(key => /^VITE_.*(?:SERVICE_ROLE|SECRET_KEY)/i.test(key))) throw new Error('Privileged VITE variable rejected.');
const server = await createServer({ root, configFile: false, envDir: false, plugins: [react(), {
  name: 'local-staging-identity',
  configureServer(server) {
    server.middlewares.use('/__local-staging', (req, res) => {
      if (req.method !== 'GET' || !['127.0.0.1:3017','localhost:3017'].includes(req.headers.host)) { res.writeHead(403); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ projectId, apiUrl, frontendUrl, pid: process.pid }));
    });
  }
}], resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 3017, strictPort: true } });
let edge;
try {
  await server.listen();
  const command = cliCommand(['functions', 'serve', 'domain-read', '--workdir', runtime]);
  edge = spawn(command.file, command.args, { cwd: root, stdio: ['ignore','pipe','pipe'] });
  pipeRedactedLines(edge.stdout, process.stdout);
  pipeRedactedLines(edge.stderr, process.stderr);
  edge.on('error', () => console.error('Local Edge worker could not start. Frontend remains on local staging only.'));
  console.log(`Local staging frontend: ${frontendUrl}`);
  console.log('Production .env files are not loaded. Press Ctrl+C to stop this frontend.');
} catch (error) {
  await server.close();
  console.error(redact(error.message));
  process.exit(1);
}
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  edge?.kill();
  await server.close();
  process.exit(0);
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
