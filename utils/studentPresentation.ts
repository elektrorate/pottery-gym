import type { GiftCard, Student } from '../types';
import { isNonMembershipCategory } from './classTypeLabels.ts';
import { claseLabel, quedanDeClases } from './pluralize.ts';

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

/** Class-bono students, or anyone with a linked non-cancelled gift card. Group students without a bono are excluded. */
export function studentHasClassBono(student: Pick<Student, 'id' | 'studentCategory'>, giftCards: GiftCard[] = []): boolean {
  if ((student.studentCategory ?? 'membresia') === 'temporal') return true;
  return studentGiftCardBalance(student.id, giftCards).cards.length > 0;
}

/**
 * Calendar audience `temporal` is stored as “not membership”, but the control is labelled
 * «Bonos de clases». Match students who actually have class bonos. «Ambos» stays everyone.
 */
export function studentMatchesSessionAudience(
  student: Pick<Student, 'id' | 'studentCategory'>,
  audience: 'membresia' | 'temporal' | 'ambos' | undefined,
  giftCards: GiftCard[] = []
): boolean {
  if (!audience || audience === 'ambos') return true;
  if (audience === 'membresia') return (student.studentCategory || 'membresia') === 'membresia';
  return studentHasClassBono(student, giftCards);
}

/** Manual credits are a separate ledger. This line explains them without adding them to the counter. */
export function manualCreditBreakdown(student: Pick<Student, 'manualCredits'>): string {
  const credits = student.manualCredits || [];
  const added = credits.filter(credit => credit.mode !== 'reconcile_legacy')
    .reduce((sum, credit) => sum + Math.max(0, credit.remainingClasses || 0), 0);
  const previous = credits.filter(credit => credit.mode === 'reconcile_legacy')
    .reduce((sum, credit) => sum + Math.max(0, credit.remainingClasses || 0), 0);
  const parts: string[] = [];
  if (added > 0) parts.push(`Incluye ${claseLabel(added)} ${added === 1 ? 'añadida' : 'añadidas'}`);
  if (previous > 0) parts.push(`Incluye ${claseLabel(previous)} ${previous === 1 ? 'anterior registrada' : 'anteriores registradas'}`);
  return parts.join('. ');
}

export function studentBalanceLabel(student: Student, giftCards?: GiftCard[]): string {
  if ((student.studentCategory ?? 'membresia') !== 'membresia') {
    if (giftCards) {
      const { cards, remaining, contracted } = studentGiftCardBalance(student.id, giftCards);
      if (cards.length) return quedanDeClases(remaining, contracted);
    }
    if (typeof student.bonosAsignados === 'number' && student.bonosAsignados > 0) {
      return quedanDeClases(student.classesRemaining ?? 0, student.bonosAsignados);
    }
    return claseLabel(student.classesRemaining ?? 0);
  }
  if (hasVerifiedMembership(student)) return quedanDeClases(student.classesRemaining, student.bonosAsignados!);
  if (student.legacyManualBalance == null) return 'Clases por confirmar';
  const count = student.legacyManualBalance;
  return `Le ${count === 1 ? 'queda' : 'quedan'} ${claseLabel(count)}`;
}

/**
 * Default funding line in Nueva sesión. A class pack is the same balance Alumnos shows.
 * Gift cards and added classes stay as their own options. There is no invented price here.
 */
export function defaultSessionFundingLabel(student: Pick<Student, 'studentCategory' | 'classesRemaining' | 'bonosAsignados'>): string {
  if ((student.studentCategory ?? 'membresia') === 'membresia') return 'Clases de la membresía';
  const total = student.bonosAsignados;
  const remaining = student.classesRemaining ?? 0;
  if (typeof total === 'number' && Number.isSafeInteger(total) && total > 0) {
    const phrase = quedanDeClases(remaining, total);
    return `Bono de clases: ${phrase.charAt(0).toLocaleLowerCase('es-ES')}${phrase.slice(1)}`;
  }
  if (remaining > 0) return `Bono de clases: ${claseLabel(remaining)}`;
  return 'Sin bono ni clases añadidas';
}

/** A new class pack explains classes_remaining. That balance is not "clases anteriores". */
export function assignedPackCoversBalance(student: Pick<Student, 'studentCategory' | 'bonosAsignados' | 'classesRemaining'>): boolean {
  if (!isNonMembershipCategory(student.studentCategory)) return false;
  const total = student.bonosAsignados;
  const remaining = student.classesRemaining;
  return typeof total === 'number' && Number.isSafeInteger(total) && total > 0
    && typeof remaining === 'number' && Number.isSafeInteger(remaining)
    && remaining >= 0 && remaining <= total;
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
