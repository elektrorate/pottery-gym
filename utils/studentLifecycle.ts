import { inferMembershipTier } from '../types';
import type { Student, MembershipPeriod } from '../types';

export type StudentLifecycle = 'active' | 'pending' | 'expired' | 'temporary' | 'archived';
export const getWorkshopDate = (now = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now);

export const isManagedMembership = (student: Pick<Student, 'studentCategory'>) =>
  (student.studentCategory ?? 'membresia') === 'membresia';

// Missing legacy observations are neither payment nor debt.
export const getStudentPaymentStatus = (student: Pick<Student, 'paymentStatus' | 'status'>) =>
  student.paymentStatus ?? 'unknown';

export const getStudentLifecycle = (student: Student, today = getWorkshopDate()): StudentLifecycle => {
  if (student.archivedAt) return 'archived';
  if (!isManagedMembership(student)) return 'temporary';
  const expiry = student.expiryDate?.slice(0, 10);
  if (expiry) {
    const elapsedDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${expiry}T00:00:00Z`)) / 86_400_000;
    if (elapsedDays >= 6) return 'expired';
    if (elapsedDays > 0) return 'pending';
  }
  if (!expiry || !Number.isFinite(Date.parse(expiry)) || getStudentPaymentStatus(student) !== 'paid') return 'pending';
  return 'active';
};

export const isStudentArchived = (student: Student, today = getWorkshopDate()) =>
  getStudentLifecycle(student, today) === 'archived';

export const getPendingMembershipPayments = (student: Student) => {
  if (!isManagedMembership(student)) return [];
  const periods = student.membershipPeriods || [];
  if (periods.length) return periods.filter(period => period.paymentStatus === 'pending');
  return student.paymentStatus === 'pending' ? [{ id: 'legacy', studentId: student.id,
    startsOn: student.membershipActivatedAt, endsOn: student.expiryDate, paymentStatus: 'pending' as const }] : [];
};

export const DEFAULT_STUDENT_PAYMENT_STATUS = 'pending' as const;

export const withStudentCreationDefaults = (student: Omit<Student, 'id'>): Omit<Student, 'id'> => ({
  ...student,
  paymentStatus: DEFAULT_STUDENT_PAYMENT_STATUS
});

// Date-only UTC arithmetic avoids browser timezone and DST shifts.
export const addMembershipMonth = (date: string): string => {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
};

export const assertOrdinaryStudentUpdate = (student: Student, updates: Partial<Student>) => {
  if (!isManagedMembership(student)) return;
  const protectedFields: Array<keyof Student> = ['studentCategory', 'membershipTier', 'membershipActivatedAt',
    'expiryDate', 'price', 'bonosAsignados', 'classesRemaining', 'paymentStatus', 'status', 'effectivePeriodId', 'materializedPeriodId'];
  if (protectedFields.some(field => Object.prototype.hasOwnProperty.call(updates, field))) {
    throw new Error('Usa las acciones de período, pago o ajuste de clases; el perfil solo permite datos personales.');
  }
};

// Shared SELECT/INSERT mapping; never mix submitted defaults with server projections.
export const mapStudentRowToModel = (row: any): Student => ({
  id: row.id, name: row.name || row.full_name || '', surname: row.surname || undefined,
  email: row.email || undefined, phone: row.phone || '', phoneCountry: row.phone_country || undefined,
  birthDay: row.birth_day ? String(row.birth_day) : undefined,
  birthMonth: row.birth_month ? String(row.birth_month) : undefined,
  birthYear: row.birth_year ? String(row.birth_year) : undefined,
  classesRemaining: row.classes_remaining ?? 0, status: row.status || 'new',
  paymentStatus: row.payment_status ?? null,
  effectivePeriodId: row.current_membership_period_id || undefined,
  materializedPeriodId: row.current_membership_period_id || undefined,
  paymentMethod: row.payment_method || undefined, notes: row.notes || undefined,
  observations: row.observations || undefined, price: row.price ?? undefined,
  classType: row.class_type || undefined,
  expiryDate: row.expiry_date ? String(row.expiry_date).slice(0, 10) : undefined,
  studentCategory: row.student_category ?? 'membresia',
  membershipTier: isManagedMembership({ studentCategory: row.student_category }) ? (row.membership_tier || inferMembershipTier(undefined, row.price)) : undefined,
  membershipActivatedAt: row.membership_activated_at || undefined, archivedAt: row.archived_at || undefined,
  groupName: row.group_name || undefined, bonosAsignados: row.bonos_asignados ?? undefined,
  repetirMensualmente: isManagedMembership({ studentCategory: row.student_category }) && (row.repetir_mensualmente ?? false),
  createdAt: row.created_at || undefined
});

export const mapMembershipPeriod = (row: any): MembershipPeriod => ({
  id: row.id, studentId: row.student_id, predecessorId: row.predecessor_id ?? undefined,
  membershipTier: row.membership_tier ?? undefined, price: row.plan_price ?? undefined,
  allocatedClasses: row.allocated_classes ?? undefined, startsOn: row.starts_on ?? undefined,
  endsOn: row.ends_on ?? undefined, paymentStatus: row.payment_status ?? null
});

export const joinStudentMemberships = (rows: any[], effectiveRows: any[], periodRows: any[]): Student[] => {
  const effective = new Map(effectiveRows.map(row => [row.student_id, row]));
  if (effective.size !== effectiveRows.length) throw new Error('Proyección de membresía duplicada.');
  return rows.map(row => {
    const student = mapStudentRowToModel(row);
    if (!isManagedMembership(student)) return student;
    const projection = effective.get(row.id);
    const history = periodRows.filter(period => period.student_id === row.id);
    if (!projection || projection.sede_id !== row.sede_id ||
        projection.materialized_period_id !== (row.current_membership_period_id ?? null) ||
        history.some(period => period.sede_id !== row.sede_id) ||
        (projection.effective_period_id && !history.some(period => period.id === projection.effective_period_id))) {
      throw new Error('La proyección de membresía no coincide con el alumno.');
    }
    return {
      ...student, effectivePeriodId: projection.effective_period_id ?? undefined,
      materializedPeriodId: projection.materialized_period_id ?? undefined,
      membershipTier: projection.membership_tier ?? undefined,
      price: projection.plan_price ?? undefined, bonosAsignados: projection.allocated_classes ?? undefined,
      classesRemaining: projection.classes_remaining ?? 0,
      expiryDate: projection.ends_on ?? undefined, membershipActivatedAt: projection.starts_on ?? undefined,
      paymentStatus: projection.payment_status ?? null, membershipPeriods: history.map(mapMembershipPeriod)
    };
  });
};

// Reactivation changes administrative visibility only, for every category.
export const getStudentReactivationUpdates = (): Partial<Student> => ({ archivedAt: '' });
