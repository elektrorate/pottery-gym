import test from 'node:test';
import assert from 'node:assert/strict';
import { presentDisplayName, presentInitials, presentPersonName, presentPlanName } from '../utils/displayName.ts';
import { studentCategoryInlineLabel, studentCategoryLabel, studentOptionLabel } from '../utils/classTypeLabels.ts';

test('uniform stored names are title-cased and mixed-case names stay as stored', () => {
  assert.equal(presentDisplayName('ROSA ELVIRA GUAYANAY'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('rosa elvira guayanay'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('MARÍA-JOSÉ'), 'María-José');
  assert.equal(presentDisplayName('Rosa Elvira Guayanay'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('McDonald'), 'McDonald');
  assert.equal(presentDisplayName('Estudio'), 'Estudio');
  assert.equal(presentDisplayName(''), '');
});

test('only all-lowercase or all-uppercase words change, and particles stay lowercase', () => {
  assert.equal(presentDisplayName('ignacia rosas'), 'Ignacia Rosas');
  assert.equal(presentDisplayName('IGNACIA ROSAS'), 'Ignacia Rosas');
  assert.equal(presentDisplayName('MARIA DE LA ROSA'), 'Maria de la Rosa');
  assert.equal(presentDisplayName('maria del carmen'), 'Maria del Carmen');
  assert.equal(presentDisplayName('ANA Y LUIS'), 'Ana y Luis');
  assert.equal(presentDisplayName('de la rosa'), 'De la Rosa');
  assert.equal(presentDisplayName('Rosa ELVIRA guayanay'), 'Rosa Elvira Guayanay');
  assert.equal(presentDisplayName('McDonald ROSAS'), 'McDonald Rosas');
  assert.equal(presentDisplayName('Maria De La Cruz'), 'Maria De La Cruz');
  assert.equal(presentPersonName('ana moreno', 'iglesias'), 'Ana Moreno Iglesias');
  assert.equal(presentPersonName('Rosa Elvira', 'Guayanay'), 'Rosa Elvira Guayanay');
  assert.equal(presentInitials('ignacia', 'rosas'), 'IR');
  assert.equal(presentInitials('McDonald'), 'M');
});

test('plan names render capitalized and categories beside a name are human labels', () => {
  assert.equal(presentPlanName('gold'), 'Gold');
  assert.equal(presentPlanName('platinum'), 'Platinum');
  assert.equal(presentPlanName('plata'), 'Plata');
  assert.equal(presentPlanName('GOLD'), 'Gold');
  assert.equal(presentPlanName(''), '');
  assert.equal(presentPlanName(undefined), '');
  assert.equal(studentCategoryLabel('temporal'), 'Bonos de clases');
  assert.equal(studentCategoryInlineLabel('membresia'), 'Membresía');
  assert.equal(studentCategoryInlineLabel('temporal'), 'Temporal');
  assert.equal(studentCategoryInlineLabel('grupo_temporal'), 'Grupo temporal');
  assert.equal(
    studentOptionLabel({ name: 'ignacia', surname: 'rosas', studentCategory: 'membresia' }),
    'Ignacia Rosas · Membresía'
  );
  assert.equal(
    studentOptionLabel({ name: 'Ana Moreno', surname: 'Iglesias', studentCategory: 'temporal' }),
    'Ana Moreno Iglesias · Temporal'
  );
  assert.equal(
    studentOptionLabel({ name: 'Alex', surname: 'Perez', email: 'member@example.test', studentCategory: 'membresia' }),
    'Alex Perez · member@example.test'
  );
});
