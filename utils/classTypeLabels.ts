import type { CapacityActivity, ClassSession, Student } from '../types';
import { presentPersonName } from './displayName.ts';

/** Canonical Spanish labels for session/activity types across admin screens. */
export const SESSION_TYPE_LABELS: Record<ClassSession['classType'], string> = {
  mesa: 'Modelado/Mesa',
  torno: 'Torno',
  mixto: 'Sesión mixta',
  coworking: 'Coworking',
  workshop: 'Workshop',
  privada: 'Privadas',
  feriado: 'Feriados'
};

export const ACTIVITY_TYPE_LABELS: Record<CapacityActivity, string> = {
  mesa: 'Modelado/Mesa',
  torno: 'Torno',
  coworking: 'Coworking',
  workshop: 'Workshop',
  privada: 'Privadas'
};

export const STUDENT_CATEGORY_LABELS: Record<NonNullable<Student['studentCategory']>, string> = {
  membresia: 'Membresía',
  temporal: 'Bonos de clases',
  grupal: 'Grupal',
  grupo_temporal: 'Grupo temporal'
};

export const NON_MEMBERSHIP_CATEGORIES = ['temporal', 'grupal', 'grupo_temporal'] as const;
export type NonMembershipCategory = (typeof NON_MEMBERSHIP_CATEGORIES)[number];

export const isNonMembershipCategory = (
  category: Student['studentCategory'] | string | null | undefined
): category is NonMembershipCategory =>
  NON_MEMBERSHIP_CATEGORIES.includes((category ?? 'membresia') as NonMembershipCategory);

/** Spanish label for a student category; never returns raw codes like `grupal`. */
export const studentCategoryLabel = (category: Student['studentCategory'] | string | null | undefined) => {
  const key = (category as Student['studentCategory']) || 'membresia';
  if (STUDENT_CATEGORY_LABELS[key]) return STUDENT_CATEGORY_LABELS[key];
  if (!category) return STUDENT_CATEGORY_LABELS.membresia;
  // Unknown codes: title-case words, never snake_case in UI
  return String(category)
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Short category beside a person's name.
 * `temporal` reads «Temporal» here; filters and badges keep «Bonos de clases».
 */
const INLINE_CATEGORY_LABELS: Record<string, string> = {
  membresia: STUDENT_CATEGORY_LABELS.membresia,
  temporal: 'Temporal',
  grupal: STUDENT_CATEGORY_LABELS.grupal,
  grupo_temporal: STUDENT_CATEGORY_LABELS.grupo_temporal
};

export const studentCategoryInlineLabel = (category: Student['studentCategory'] | string | null | undefined) => {
  const key = String(category || 'membresia');
  return INLINE_CATEGORY_LABELS[key] || studentCategoryLabel(category);
};

/** Dropdown label: «Ignacia Rosas · Membresía». Email replaces the category only when it exists. */
export const studentOptionLabel = (student: {
  name?: string | null;
  surname?: string | null;
  email?: string | null;
  studentCategory?: string | null;
}) => {
  const person = presentPersonName(student.name, student.surname) || 'Alumno';
  const detail = student.email?.trim() || studentCategoryInlineLabel(student.studentCategory);
  return `${person} · ${detail}`;
};

export const sessionTypeLabel = (type: ClassSession['classType'] | string | undefined) =>
  (type && SESSION_TYPE_LABELS[type as ClassSession['classType']]) || type || 'Sesión';

export const activityTypeLabel = (type: CapacityActivity | string | undefined) =>
  (type && ACTIVITY_TYPE_LABELS[type as CapacityActivity]) || type || 'Actividad';
