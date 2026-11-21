import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const load = async () => {
  const result = await build({ entryPoints: ['utils/contactValidation.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const dir = await mkdtemp(path.join(tmpdir(), 'contact-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

test('email and phone reject obvious junk and accept studio values', async () => {
  const { dir, mod } = await load();
  try {
    assert.equal(mod.emailError(''), null);
    assert.equal(mod.emailError('ada@casa.es'), null);
    assert.match(mod.emailError('abc'), /email válido/);
    assert.equal(mod.phoneError(''), null);
    assert.equal(mod.phoneError('+34 606 130 865'), null);
    assert.match(mod.phoneError('abc'), /dígitos/);
    assert.match(mod.phoneError('12'), /corto/);
    assert.match(mod.positiveAmountError(-50, 'El importe'), /negativo/);
    assert.match(mod.positiveAmountError(0, 'La cuota'), /mayor que 0/);
    assert.equal(mod.positiveAmountError(12, 'La cuota'), null);
    assert.match(mod.nonNegativeAmountError(-3, 'La cantidad'), /negativo/);
    assert.equal(mod.nonNegativeAmountError(0, 'La cantidad'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
