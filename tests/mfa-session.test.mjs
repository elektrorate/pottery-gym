import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = async () => {
  const result = await build({
    entryPoints: ['utils/mfaSession.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node'
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'mfa-session-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

const day = 24 * 60 * 60 * 1000;

test('aal2 TOTP stays valid for 30 days and then requires password and code', async () => {
  const { dir, mod } = await bundle();
  try {
    const verifiedAtMs = Date.UTC(2026, 0, 1);
    const totpSeconds = verifiedAtMs / 1000;
    const methods = [
      { method: 'password', timestamp: totpSeconds - 30 },
      { method: 'totp', timestamp: totpSeconds }
    ];
    assert.equal(mod.MFA_MAX_AGE_MS, 30 * day);
    assert.deepEqual(mod.assessMfaAccess('aal2', methods, verifiedAtMs + day), {
      status: 'allow', verifiedAtMs
    });
    assert.deepEqual(
      mod.assessMfaAccess('aal2', methods, verifiedAtMs + mod.MFA_MAX_AGE_MS - 1),
      { status: 'allow', verifiedAtMs }
    );
    assert.deepEqual(
      mod.assessMfaAccess('aal2', methods, verifiedAtMs + mod.MFA_MAX_AGE_MS),
      { status: 'reauthenticate' }
    );
    assert.deepEqual(
      mod.assessMfaAccess('aal2', methods, verifiedAtMs + 31 * day),
      { status: 'reauthenticate' }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aal1 never opens admin access, even with a fresh TOTP claim', async () => {
  const { dir, mod } = await bundle();
  try {
    const now = Date.UTC(2026, 5, 1);
    const fresh = [{ method: 'totp', timestamp: now / 1000 }];
    for (const level of ['aal1', null, undefined, '', 'aal3']) {
      assert.deepEqual(mod.assessMfaAccess(level, fresh, now), { status: 'step-up' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aal2 without a usable TOTP timestamp requires a full sign-in', async () => {
  const { dir, mod } = await bundle();
  try {
    const now = Date.UTC(2026, 5, 1);
    const cases = [
      null,
      undefined,
      [],
      [{ method: 'password', timestamp: now / 1000 }],
      [{ method: 'totp' }],
      [{ method: 'totp', timestamp: 0 }],
      [{ method: 'totp', timestamp: Number.NaN }],
      [{ method: 'TOTP', timestamp: '1710000000' }],
      [{ method: 'totp', timestamp: (now + 6 * 60 * 1000) / 1000 }],
      ['password', 'totp']
    ];
    for (const methods of cases) {
      assert.equal(mod.assessMfaAccess('aal2', methods, now).status, 'reauthenticate');
    }
    assert.equal(
      mod.assessMfaAccess('aal2', [{ method: 'TOTP', timestamp: now / 1000 }], now).status,
      'allow'
    );
    assert.equal(
      mod.latestTotpVerifiedAtMs([
        { method: 'totp', timestamp: (now - day) / 1000 },
        { method: 'totp', timestamp: now }
      ]),
      now
    );
    assert.equal(
      mod.assessMfaAccess('aal2', [{ method: 'otp', timestamp: String(now / 1000) }], now).status,
      'allow'
    );
    assert.equal(
      mod.resolveMfaAccess('aal2', ['otp'], now - day, now).status,
      'allow'
    );
    assert.equal(
      mod.resolveMfaAccess('aal2', ['otp'], now - 31 * day, now).status,
      'step-up'
    );
    assert.equal(
      mod.resolveMfaAccess('aal1', ['otp'], now, now).status,
      'step-up'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('device trust cookie is SameSite Lax, lasts 30 days, and is scoped to the user', async () => {
  const result = await build({
    entryPoints: ['utils/mfaTrust.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node'
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'mfa-trust-'));
  const jar = new Map();
  const writes = [];
  globalThis.window = { location: { protocol: 'https:' } };
  globalThis.document = {
    get cookie() { return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value) {
      writes.push(value);
      const [pair, ...attrs] = value.split(';').map(part => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const maxAge = attrs.find(attr => attr.toLowerCase().startsWith('max-age='));
      if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name);
      else jar.set(name, pair.slice(index + 1));
    }
  };
  const file = path.join(dir, 'trust.mjs');
  await writeFile(file, result.outputFiles[0].text);
  try {
    const trust = await import(pathToFileURL(file).href);
    const verifiedAt = Date.UTC(2026, 10, 1);
    trust.writeMfaTrust('user-a', verifiedAt);
    assert.equal(writes.some(value => value.startsWith('pg-mfa-trust=') && value.includes('Max-Age=2592000') && value.includes('SameSite=Lax') && value.includes('Secure')), true);
    assert.equal(trust.readMfaTrust('user-a'), verifiedAt);
    assert.equal(trust.readMfaTrust('user-b'), null);
    trust.clearMfaTrust();
    assert.equal(trust.readMfaTrust('user-a'), null);
    assert.equal(trust.MFA_TRUST_MAX_AGE_SEC, 30 * 24 * 60 * 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
