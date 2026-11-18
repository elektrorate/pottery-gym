import type { Student } from '../types';

export function hasVerifiedMembership(student: Student): boolean {
  return !!student.effectivePeriodId && !!student.membershipTier && Number.isSafeInteger(student.bonosAsignados) && student.bonosAsignados! > 0;
}

export function needsStudentReview(student: Student): boolean {
  return !student.archivedAt && (student.studentCategory ?? 'membresia') === 'membresia'
    && (!hasVerifiedMembership(student) || !student.expiryDate || !student.paymentStatus);
}

export function studentBalanceLabel(student: Student): string {
  if ((student.studentCategory ?? 'membresia') !== 'membresia') return `${student.classesRemaining} clases`;
  if (hasVerifiedMembership(student)) return `${student.classesRemaining} / ${student.bonosAsignados}`;
  return student.legacyManualBalance == null ? 'Saldo por verificar' : `Saldo importado: ${student.legacyManualBalance} clases`;
}
