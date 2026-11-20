import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = async () => {
  const result = await build({
    entryPoints: ['utils/teacherCalendar.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node'
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'teacher-calendar-'));
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return { dir, mod: await import(pathToFileURL(file).href) };
};

const sessions = [
  { id: 'upcoming-mesa', date: '2026-11-21', startTime: '10:00', classType: 'mesa', teacherId: 'ana', students: [] },
  {
    id: 'upcoming-mixed', date: '2026-11-24', startTime: '18:00', classType: 'mixto', students: [],
    activityBlocks: [
      { activityType: 'mesa', teacherId: 'ana', capacity: 4, studentIds: [] },
      { activityType: 'torno', teacherId: 'luis', capacity: 2, studentIds: [] }
    ]
  },
  { id: 'completed', date: '2026-11-12', startTime: '10:00', classType: 'mesa', teacherId: 'ana', completedAt: '2026-11-12T12:00:00Z', students: [] },
  { id: 'substitute', date: '2026-11-25', startTime: '16:00', classType: 'torno', teacherId: 'ana', teacherSubstituteId: 'luis', students: [] },
  { id: 'other', date: '2026-11-22', startTime: '16:00', classType: 'torno', teacherId: 'otra', students: [] }
];

test('scheduled teacher classes include mixed blocks and substitutes, and exclude concluded or unrelated sessions', async () => {
  const { dir, mod } = await bundle();
  try {
    assert.deepEqual(mod.teacherSessions(sessions, 'ana', false).map(session => session.id), ['upcoming-mesa', 'upcoming-mixed', 'substitute']);
    assert.deepEqual(mod.teacherSessions(sessions, 'luis', false).map(session => session.id), ['upcoming-mixed', 'substitute']);
    assert.deepEqual(mod.teacherSessions(sessions, 'ana', true).map(session => session.id), ['completed']);
    assert.deepEqual(mod.teacherSessions(sessions, 'luis', true), []);
    assert.deepEqual(mod.teacherBlockActivities(sessions[1], 'luis'), ['torno']);
    assert.equal(mod.sessionAssignedToTeacher(sessions[4], 'ana'), false);
    assert.equal(mod.sessionAssignedToTeacher(sessions[0], ''), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
