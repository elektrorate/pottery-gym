import type { MembershipPeriod, Student } from '../types';
import { formatDate } from './dateFormat';
import { isManagedMembership, isStudentArchived, getStudentPaymentStatus } from './studentLifecycle';
import { presentPersonName } from './displayName';

const dateKey = (value?: string | null) => (value || '').slice(0, 10);

/**
 * The current membership period is the latest one that has already started
 * (startsOn <= today). A future renewal is not current. With no period rows,
 * the student's own payment status is the legacy current period.
 */
export const currentMembershipPeriod = (student: Student, today: string): MembershipPeriod | 'legacy' | null => {
  const periods = student.membershipPeriods || [];
  const started = periods.filter(period => {
    const start = dateKey(period.startsOn);
    return !start || start <= today;
  });
  if (started.length) {
    return [...started].sort((a, b) => dateKey(b.startsOn).localeCompare(dateKey(a.startsOn)))[0];
  }
  return periods.length ? null : 'legacy';
};

export const scheduledRenewals = (student: Student, today: string) =>
  (student.membershipPeriods || []).filter(period => dateKey(period.startsOn) > today && period.paymentStatus === 'pending');

/**
 * Pending today: a non-archived student whose current period is pending, or a
 * non-membership student whose payment is pending. Future renewals do not count.
 */
export const isPaymentPendingToday = (student: Student, today: string) => {
  if (isStudentArchived(student, today) || student.archivedAt) return false;
  if (!isManagedMembership(student)) return getStudentPaymentStatus(student) === 'pending';
  const current = currentMembershipPeriod(student, today);
  if (current === 'legacy') return getStudentPaymentStatus(student) === 'pending';
  if (!current) return false;
  return current.paymentStatus === 'pending';
};

export const pendingTodayStudents = (students: Student[], today: string) =>
  students.filter(student => isPaymentPendingToday(student, today));

export const paymentPendingReason = (student: Student, today: string) => {
  if (!isManagedMembership(student)) return 'Pago pendiente';
  const current = currentMembershipPeriod(student, today);
  if (!current || current === 'legacy') return 'Pago pendiente del período actual';
  const start = current.startsOn ? formatDate(current.startsOn) : 'sin inicio';
  const end = current.endsOn ? formatDate(current.endsOn) : 'sin vencimiento';
  return `Pago pendiente del período actual · ${start} — ${end}`;
};

export const scheduledRenewalReason = (student: Student, today: string) => {
  const next = scheduledRenewals(student, today)[0];
  if (!next) return '';
  const when = next.startsOn ? formatDate(next.startsOn) : 'una fecha posterior';
  return `Renovación programada · empieza el ${when}`;
};

export const studentDisplayName = (student: Pick<Student, 'name' | 'surname'>) =>
  presentPersonName(student.name, student.surname);
