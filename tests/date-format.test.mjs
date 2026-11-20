import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = async () => {
  const result = await build({
    entryPoints: ['utils/dateFormat.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node'
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'date-format-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

test('dates and times use Spanish 24-hour formatting in Europe/Madrid', async () => {
  const { dir, mod } = await bundle();
  try {
    assert.equal(mod.DATE_LOCALE, 'es-ES');
    assert.equal(mod.BUSINESS_TIME_ZONE, 'Europe/Madrid');
    assert.equal(mod.formatDate('2026-12-20'), '20/12/2026');
    assert.equal(mod.formatDate('20/12/2026'), '20/12/2026');
    assert.equal(mod.formatTime('18:30'), '18:30');
    assert.equal(mod.formatTime('10:00 AM'), '10:00');
    assert.equal(mod.formatTime('12:00 PM'), '12:00');
    assert.equal(mod.formatTime('12:00 AM'), '00:00');
    assert.equal(mod.formatTime('2026-12-20T17:30:00.000Z'), '18:30');
    assert.equal(mod.formatDateTime('2026-12-20T17:30:00.000Z'), '20/12/2026, 18:30');
    assert.equal(mod.formatDate('2026-12-20', 'long'), 'domingo, 20 de diciembre');
    const formattedNow = mod.formatDate(new Date('2026-12-20T23:30:00.000Z'));
    assert.equal(formattedNow, '21/12/2026');
    assert.equal(mod.madridDateKey(new Date('2026-12-20T23:30:00.000Z')), '2026-12-21');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('20/12 is saved as 20/12 and not shifted to 19/12', async () => {
  const { dir, mod } = await bundle();
  try {
    assert.equal(mod.parseDateOnly('20/12/2026'), '2026-12-20');
    assert.equal(mod.parseDateOnly('2026-12-20'), '2026-12-20');
    assert.equal(mod.formatDate(mod.parseDateOnly('20/12/2026')), '20/12/2026');

    // Europe/Madrid in December is UTC+1. Local midnight on the 20th is 23:00 UTC on the 19th.
    // The old save path (local Date -> toISOString date) stored 19/12. The parser must not.
    const madridWinterUtcOffsetHours = 1;
    const shiftedUtcDate = new Date(Date.UTC(2026, 11, 20, -madridWinterUtcOffsetHours)).toISOString().slice(0, 10);
    assert.equal(shiftedUtcDate, '2026-12-19');
    assert.notEqual(mod.parseDateOnly('20/12/2026'), shiftedUtcDate);

    // Date-only text is not parsed as UTC midnight, which is the previous evening west of UTC.
    assert.equal(new Date('2026-12-20').toISOString(), '2026-12-20T00:00:00.000Z');
    assert.equal(mod.formatDate('2026-12-20'), '20/12/2026');

    // The instant of Madrid midnight on the 20th still displays and parses as the 20th.
    assert.equal(mod.formatDate('2026-12-19T23:00:00.000Z'), '20/12/2026');
    assert.equal(mod.parseDateOnly('2026-12-19T23:00:00.000Z'), '2026-12-20');
    assert.equal(mod.formatTime('2026-12-19T23:00:00.000Z'), '00:00');

    assert.equal(mod.parseDateOnly('31/02/2026'), null);
    assert.equal(mod.parseDateOnly('29/02/2024'), '2024-02-29');
    assert.equal(mod.parseDateOnly('29/02/2026'), null);
    const week = mod.weekRangeForDateKey('2026-12-20');
    assert.equal(week.start, '2026-12-14');
    assert.equal(week.end, '2026-12-20');
    assert.equal(mod.formatDate(week.start), '14/12/2026');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
