import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalDocker, assertOwned, schemaText } from '../scripts/local-staging-restore-rehearsal.mjs';

test('only local Docker sockets without DOCKER_HOST overrides are accepted', () => {
  assert.doesNotThrow(() => assertLocalDocker('npipe:////./pipe/dockerDesktopLinuxEngine'));
  assert.doesNotThrow(() => assertLocalDocker('unix:///var/run/docker.sock'));
  for (const host of ['tcp://127.0.0.1:2375', 'ssh://localhost', 'npipe:////server/pipe/docker', 'https://docker.example', undefined]) {
    assert.throws(() => assertLocalDocker(host));
  }
  assert.throws(() => assertLocalDocker('unix:///var/run/docker.sock', 'unix:///other.sock'));
});

test('cleanup requires exact ID, UUID-prefixed name and ownership label', () => {
  const runId = 'a6030d28-267a-4437-872f-2d44756610bd';
  const expected = { id: 'abc123', name: `restore-${runId}-db` };
  const container = { Id: expected.id, Name: `/${expected.name}`, Config: { Labels: { 'pottery.restore-rehearsal': runId } } };
  assert.doesNotThrow(() => assertOwned(container, expected, runId));
  assert.throws(() => assertOwned({ ...container, Id: 'another' }, expected, runId));
  assert.throws(() => assertOwned({ ...container, Name: '/supabase_db_pottery-gym-local-staging' }, expected, runId));
  assert.throws(() => assertOwned({ ...container, Config: { Labels: {} } }, expected, runId));
  assert.throws(() => assertOwned(container, { ...expected, name: 'source' }, runId));
});

test('schema normalization removes dump noise while security catalogs verify grants separately', () => {
  const a = Buffer.from('\\restrict randomA\r\n-- Started on now\r\nCREATE TABLE public.example(id integer);\r\n\\unrestrict randomA\r\n');
  const b = Buffer.from('\\restrict randomB\n-- Started on later\nCREATE TABLE public.example(id integer);\n\\unrestrict randomB\n');
  assert.equal(schemaText(a), schemaText(b));
  assert.notEqual(schemaText(a), schemaText(Buffer.from('CREATE TABLE public.example(id bigint);\n')));
  assert.notEqual(schemaText(Buffer.from('ALTER TABLE public.example ENABLE ROW LEVEL SECURITY;\n')),
    schemaText(Buffer.from('ALTER TABLE public.example DISABLE ROW LEVEL SECURITY;\n')));
});
