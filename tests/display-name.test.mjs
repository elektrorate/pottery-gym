import test from 'node:test';
import assert from 'node:assert/strict';
import { presentDisplayName } from '../utils/displayName.ts';

test('uniform stored names are title-cased and mixed-case names stay as stored', () => {
  assert.equal(presentDisplayName('ROSA ELVIRA GUAYANAY'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('rosa elvira guayanay'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('MARÍA-JOSÉ'), 'María-José');
  assert.equal(presentDisplayName('Rosa Elvira Guayanay'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('McDonald'), 'McDonald');
  assert.equal(presentDisplayName('Estudio'), 'Estudio');
  assert.equal(presentDisplayName(''), '');
});
