import type { Student } from '../types';

export type StudentLifecycle = 'active' | 'pending' | 'temporary' | 'archived';
export const getWorkshopDate = (now = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now);

// Preserve explicitly active legacy records. Ambiguous records need review.
export const getStudentPaymentStatus = (student: Pick<Student, 'paymentStatus' | 'status'>) =>
  student.paymentStatus ?? (student.status === 'membresia' || student.status === 'active' ? 'paid' : 'pending');

export const getStudentLifecycle = (student: Student, today = getWorkshopDate()): StudentLifecycle => {
  if (student.archivedAt) return 'archived';
  if (student.studentCategory === 'temporal') return 'temporary';
  const expiry = student.expiryDate?.slice(0, 10);
  if (expiry) {
    const elapsedDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${expiry}T00:00:00Z`)) / 86_400_000;
    if (elapsedDays >= 6) return 'archived';
    if (elapsedDays > 0) return 'pending';
  }
  if (!expiry || !Number.isFinite(Date.parse(expiry)) || getStudentPaymentStatus(student) !== 'paid') return 'pending';
  return 'active';
};

export const isStudentArchived = (student: Student, today = getWorkshopDate()) =>
  getStudentLifecycle(student, today) === 'archived';
