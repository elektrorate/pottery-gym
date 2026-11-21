import type { GiftCard, Student } from '../types';
import { isNonMembershipCategory } from './classTypeLabels.ts';
import { claseLabel, pluralWord } from './pluralize.ts';

export function hasVerifiedMembership(student: Student): boolean {
  return !!student.effectivePeriodId && !!student.membershipTier && Number.isSafeInteger(student.bonosAsignados) && student.bonosAsignados! > 0;
}

export function needsStudentReview(student: Student): boolean {
  return !student.archivedAt && (student.studentCategory ?? 'membresia') === 'membresia'
    && (!hasVerifiedMembership(student) || !student.expiryDate || !student.paymentStatus);
}

export const giftCardTypeLabel = (type: GiftCard['type']) => type === 'torno' ? 'Torno' : 'Modelado';

export const giftCardPaymentLabel = (status?: GiftCard['paymentStatus']) =>
  status === 'paid' ? 'Pagado' : status === 'refunded' ? 'Reembolsado' : status === 'pending' ? 'Pendiente' : 'Sin pago';

export const giftCardSessionsRemaining = (card: GiftCard) =>
  card.sessionsRemaining ?? Math.max(0, (card.numClasses || 0) - (card.sessionsUsed || 0));

export const linkedGiftCardsForStudent = (studentId: string, giftCards: GiftCard[] = []) =>
  giftCards.filter(card => card.recipientStudentId === studentId);

export const giftCardsForStudent = (studentId: string, giftCards: GiftCard[] = []) =>
  linkedGiftCardsForStudent(studentId, giftCards).filter(card => card.status !== 'cancelled');

export const studentGiftCardBalance = (studentId: string, giftCards: GiftCard[] = []) => {
  const cards = giftCardsForStudent(studentId, giftCards);
  const contracted = cards.reduce((sum, card) => sum + Math.max(0, card.numClasses || 0), 0);
  const remaining = cards.reduce((sum, card) => sum + giftCardSessionsRemaining(card), 0);
  return { cards, contracted, remaining, allCards: linkedGiftCardsForStudent(studentId, giftCards) };
};

export const studentClassTypeFromGiftCards = (student: Pick<Student, 'id' | 'classType'>, giftCards: GiftCard[] = []) => {
  const types = [...new Set(giftCardsForStudent(student.id, giftCards).map(card => giftCardTypeLabel(card.type)))];
  return types.length === 1 ? types[0] : undefined;
};

export const studentActivityLabel = (student: Pick<Student, 'id' | 'classType'>, giftCards: GiftCard[] = []) => {
  if (student.classType) return student.classType;
  const types = [...new Set(giftCardsForStudent(student.id, giftCards).map(card => giftCardTypeLabel(card.type)))];
  if (types.length === 1) return types[0];
  if (types.length > 1) return types.join(' / ');
  return undefined;
};

export function studentBalanceLabel(student: Student, giftCards?: GiftCard[]): string {
  if ((student.studentCategory ?? 'membresia') !== 'membresia') {
    if (giftCards) {
      const { cards, remaining, contracted } = studentGiftCardBalance(student.id, giftCards);
      if (cards.length) return remaining === contracted ? claseLabel(remaining) : `${remaining} / ${contracted} ${pluralWord(contracted, 'clase', 'clases')}`;
    }
    return claseLabel(student.classesRemaining ?? 0);
  }
  if (hasVerifiedMembership(student)) return `${student.classesRemaining} / ${student.bonosAsignados}`;
  if (student.legacyManualBalance == null) return 'Clases por confirmar';
  const count = student.legacyManualBalance;
  return `Le ${count === 1 ? 'queda' : 'quedan'} ${claseLabel(count)}`;
}

/** Same rule as the «Clases agotándose» alert. Archive is checked by the caller. */
export function isClassesRunningLow(student: Student, giftCards?: GiftCard[]): boolean {
  const isMembership = (student.studentCategory || 'membresia') === 'membresia';
  const remaining = studentEffectiveRemainingClasses(student, giftCards);
  return (!isMembership || hasVerifiedMembership(student)) && remaining <= 1 && remaining >= 0;
}

/** Remaining classes for alerts/dashboard: gift cards when linked, else student balance. */
export function studentEffectiveRemainingClasses(student: Student, giftCards?: GiftCard[]): number {
  if (isNonMembershipCategory(student.studentCategory) && giftCards) {
    const { cards, remaining } = studentGiftCardBalance(student.id, giftCards);
    if (cards.length) return remaining;
  }
  return student.classesRemaining ?? 0;
}
