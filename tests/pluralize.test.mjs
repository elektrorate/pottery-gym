import test from 'node:test';
import assert from 'node:assert/strict';
import { alumnoLabel, claseLabel, piezaLabel, pluralize, sesionLabel } from '../utils/pluralize.ts';

test('spanish counts use the singular only for one', () => {
  assert.equal(claseLabel(1), '1 clase');
  assert.equal(claseLabel(0), '0 clases');
  assert.equal(claseLabel(2), '2 clases');
  assert.equal(alumnoLabel(1), '1 alumno');
  assert.equal(alumnoLabel(4), '4 alumnos');
  assert.equal(sesionLabel(1), '1 sesión');
  assert.equal(sesionLabel(3), '3 sesiones');
  assert.equal(piezaLabel(1), '1 pieza');
  assert.equal(piezaLabel(8), '8 piezas');
  assert.equal(pluralize(-1, 'clase', 'clases'), '-1 clase');
});
