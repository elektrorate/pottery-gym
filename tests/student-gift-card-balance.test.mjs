import test from 'node:test';
import assert from 'node:assert/strict';
import { studentBalanceLabel, studentGiftCardBalance, studentActivityLabel, studentClassTypeFromGiftCards } from '../utils/studentPresentation.ts';

const paula = { id: '40277e0f-0000-0000-0000-000000000001', name: 'Paula', phone: '', status: 'active', studentCategory: 'temporal', classesRemaining: 0, bonosAsignados: 0 };
const lola = { id: 'a661313b-0000-0000-0000-000000000002', name: 'Lola y Jose Luis', phone: '', status: 'active', studentCategory: 'temporal', classesRemaining: 0, bonosAsignados: 0 };
const cards = [
  { id: 'p', code: 'CR-796024D9E0', buyer: 'Aina', recipient: 'Paula', recipientStudentId: paula.id, numClasses: 2, type: 'modelado', price: 100, paymentStatus: 'paid', status: 'active', sessionsUsed: 0, sessionsRemaining: 2, dedication: 'T´estimo molt !', createdAt: '2026-11-19T13:15:00Z' },
  { id: 'l', code: 'CR-46F0D9E4B1', buyer: 'vuestro hijo y may', buyerEmail: 'ferry.gon.gom@gmail.com', recipient: 'Lola y Jose Luis', recipientStudentId: lola.id, numClasses: 2, type: 'torno', price: 100, paymentStatus: 'paid', status: 'active', sessionsUsed: 0, sessionsRemaining: 2, dedication: 'Que disfrutéis de vuestro 69 aniversario', createdAt: '2026-11-19T13:35:00Z' },
  { id: 'cancelled', code: 'CR-CANCEL', buyer: 'X', recipient: 'Paula', recipientStudentId: paula.id, numClasses: 4, type: 'modelado', status: 'cancelled', sessionsUsed: 0, sessionsRemaining: 4, createdAt: '2026-11-01T00:00:00Z' }
];

test('temporal student ficha counts come from non-cancelled gift cards, not student columns', () => {
  const paulaBalance = studentGiftCardBalance(paula.id, cards);
  assert.equal(paulaBalance.contracted, 2);
  assert.equal(paulaBalance.remaining, 2);
  assert.equal(paulaBalance.cards.length, 1);
  assert.equal(paulaBalance.allCards.length, 2);
  assert.equal(studentBalanceLabel(paula, cards), '2 clases');
  assert.equal(studentBalanceLabel(paula), '0 clases');
  assert.equal(studentClassTypeFromGiftCards(paula, cards), 'Modelado');
  assert.equal(studentActivityLabel({ ...paula, classType: undefined }, cards), 'Modelado');
  assert.equal(studentActivityLabel({ ...lola, classType: undefined }, cards), 'Torno');
  assert.equal(studentActivityLabel({ ...lola, classType: 'Modelado' }, cards), 'Modelado');
});

test('used sessions reduce remaining without changing contracted classes', () => {
  const used = [{ ...cards[0], sessionsUsed: 1, sessionsRemaining: 1 }];
  assert.deepEqual(studentGiftCardBalance(paula.id, used), { cards: used, contracted: 2, remaining: 1, allCards: used });
  assert.equal(studentBalanceLabel(paula, used), '1 / 2 clases');
});
