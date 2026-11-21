import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const load = async () => {
  const result = await build({ entryPoints: ['utils/durableAuthStorage.ts', 'utils/mfaTrust.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', outdir: 'out' });
  const dir = await mkdtemp(path.join(tmpdir(), 'auth-storage-'));
  const files = {};
  for (const output of result.outputFiles) {
    const name = path.basename(output.path);
    const file = path.join(dir, name);
    await writeFile(file, output.text);
    files[name] = file;
  }
  return { dir, storage: await import(pathToFileURL(files['durableAuthStorage.js']).href), trust: await import(pathToFileURL(files['mfaTrust.js']).href) };
};

const installBrowser = () => {
  const jar = new Map();
  const local = new Map();
  const writes = [];
  globalThis.window = { location: { protocol: 'https:' }, localStorage: {
    getItem: key => local.has(key) ? local.get(key) : null,
    setItem: (key, value) => local.set(key, value),
    removeItem: key => local.delete(key)
  } };
  globalThis.document = {
    get cookie() { return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value) {
      writes.push(value);
      const [pair, ...attrs] = value.split(';').map(part => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const body = pair.slice(index + 1);
      const maxAge = attrs.find(attr => attr.toLowerCase().startsWith('max-age='));
      if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name);
      else jar.set(name, body);
    }
  };
  return { jar, local, writes };
};

test('session cookie keeps Max-Age and SameSite and restores after localStorage is empty', async () => {
  const browser = installBrowser();
  const { dir, storage } = await load();
  try {
    const store = storage.createDurableAuthStorage();
    const session = JSON.stringify({ access_token: 'a'.repeat(4000), refresh_token: 'refresh', expires_at: 1 });
    store.setItem('sb-demo-auth-token', session);
    assert.equal(browser.local.get('sb-demo-auth-token'), session);
    assert.equal([...browser.jar.keys()].some(name => name.startsWith('sb-demo-auth-token')), true);
    assert.equal(browser.writes.some(value => /sb-demo-auth-token/.test(value) && /Max-Age=2592000/.test(value) && /SameSite=Lax/.test(value) && /Secure/.test(value)), true);
    browser.local.clear();
    assert.equal(store.getItem('sb-demo-auth-token'), session);
    assert.equal(browser.local.get('sb-demo-auth-token'), session);
    store.removeItem('sb-demo-auth-token');
    assert.equal(store.getItem('sb-demo-auth-token'), null);
    assert.equal(globalThis.document.cookie.includes('sb-demo-auth-token'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('device trust cookie is SameSite Lax, lasts 30 days, and is user scoped', async () => {
  installBrowser();
  const { dir, trust } = await load();
  try {
    const verifiedAt = Date.UTC(2026, 10, 1);
    const browser = installBrowser();
    trust.writeMfaTrust('user-a', verifiedAt);
    assert.equal(browser.writes.some(value => value.startsWith('pg-mfa-trust=') && value.includes('Max-Age=2592000') && value.includes('SameSite=Lax') && value.includes('Secure')), true);
    assert.equal(trust.readMfaTrust('user-a'), verifiedAt);
    assert.equal(trust.readMfaTrust('user-b'), null);
    trust.clearMfaTrust();
    assert.equal(trust.readMfaTrust('user-a'), null);
    assert.equal(trust.MFA_TRUST_MAX_AGE_SEC, 30 * 24 * 60 * 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
