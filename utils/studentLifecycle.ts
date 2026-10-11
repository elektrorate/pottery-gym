import type { Student } from '../types';

export type StudentLifecycle = 'active' | 'pending' | 'temporary' | 'archived';
export const getWorkshopDate = (now = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now);

// Preserve explicitly active legacy records. Ambiguous records need review.
export const getStudentPaymentStatus = (student: Pick<Student, 'paymentStatus' | 'status'>) =>
  student.paymentStatus ?? (student.status === 'membresia' || student.status === 'active' ? 'paid' : 'pending');

export const getStudentLifecycle = (student: Student, today = getWorkshopDate()): StudentLifecycle => {
  if (student.archivedAt) return 'archived';
  if (student.studentCategory && student.studentCategory !== 'membresia' && student.studentCategory !== 'temporal') return 'pending';
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

export const getStudentLifecycleCounts = (students: Student[], today = getWorkshopDate()): Record<StudentLifecycle, number> => {
  const counts: Record<StudentLifecycle, number> = { active: 0, pending: 0, temporary: 0, archived: 0 };
  students.forEach(student => { counts[getStudentLifecycle(student, today)] += 1; });
  return counts;
};

const formatLifecycleDate = (date: string) => {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('es-ES', {
    timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: 'numeric'
  });
};

export const getStudentLifecycleReason = (student: Student, today = getWorkshopDate()): string => {
  const lifecycle = getStudentLifecycle(student, today);
  if (lifecycle === 'archived' && student.archivedAt) return `Archivado el ${formatLifecycleDate(student.archivedAt)}`;
  if (student.studentCategory && student.studentCategory !== 'membresia' && student.studentCategory !== 'temporal') return 'Categoría no reconocida; revisar ficha';
  if (lifecycle === 'temporary') return 'Clase individual';

  const expiry = student.expiryDate?.slice(0, 10);
  const expiryTimestamp = expiry ? Date.parse(`${expiry}T00:00:00Z`) : Number.NaN;
  const todayTimestamp = Date.parse(`${today}T00:00:00Z`);
  if (!expiry || !Number.isFinite(expiryTimestamp)) return 'Vencimiento sin registrar';
  const elapsedDays = Math.floor((todayTimestamp - expiryTimestamp) / 86_400_000);
  if (elapsedDays >= 6) return `Inactivo desde ${formatLifecycleDate(new Date(expiryTimestamp + 6 * 86_400_000).toISOString().slice(0, 10))}`;
  if (elapsedDays > 0) return `Venció hace ${elapsedDays} ${elapsedDays === 1 ? 'día' : 'días'}`;
  if (getStudentPaymentStatus(student) !== 'paid') return 'Pago pendiente';
  return `Membresía vigente hasta ${formatLifecycleDate(expiry)}`;
};

export const isStudentArchived = (student: Student, today = getWorkshopDate()) =>
  getStudentLifecycle(student, today) === 'archived';
