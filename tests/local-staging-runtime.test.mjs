import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { redact, pipeRedactedLines } from '../scripts/local-staging-runtime.mjs';

test('local CLI JSON diagnostics redact every privileged credential field', () => {
  const input = { API_URL: 'http://127.0.0.1:55321', JWT_SECRET: 'fixture-signing-secret',
    SERVICE_ROLE_KEY: 'fixture-service-key', SECRET_KEY: 'fixture-private-key',
    S3_PROTOCOL_ACCESS_KEY_ID: 'fixture-storage-key', S3_PROTOCOL_ACCESS_KEY_SECRET: 'fixture-storage-secret',
    password: 'fixture-password', accessToken: 'fixture-token' };
  const output = JSON.parse(redact(JSON.stringify(input)));
  assert.equal(output.API_URL, input.API_URL);
  for (const field of Object.keys(input).filter(field => field !== 'API_URL')) assert.equal(output[field], '[redacted credential]');
});

test('local diagnostics redact environment assignments, JWTs, private keys and connection URLs', () => {
  const jwt = ['eyJ' + 'a'.repeat(40), 'b'.repeat(50), 'c'.repeat(40)].join('.');
  const key = 'sb_secret_' + 'd'.repeat(32);
  const output = redact(`JWT_SECRET=fixture-secret\nACCESS_TOKEN=fixture-token\n${jwt}\n${key}\npostgresql://fixture:fixture-password@127.0.0.1:55322/postgres`);
  for (const secret of ['fixture-secret', 'fixture-token', jwt, key, 'fixture-password']) assert.ok(!output.includes(secret));
  assert.match(output, /\[redacted database URL\]/);
});

test('Edge log chunks are joined before redaction and final unterminated lines are sanitized', async () => {
  const stream = new PassThrough();
  let output = '';
  pipeRedactedLines(stream, { write: text => { output += text; } });
  const ended = once(stream, 'end');
  stream.write('{"JWT_SEC');
  stream.write('RET":"fixture-');
  assert.equal(output, '');
  stream.write('secret"}\n');
  stream.end('SERVICE_ROLE_KEY=fixture-service-key');
  await ended;
  assert.ok(!output.includes('fixture-secret'));
  assert.ok(!output.includes('fixture-service-key'));
  assert.equal(output, '{"JWT_SECRET":"[redacted credential]"}\nSERVICE_ROLE_KEY=[redacted credential]');
});
