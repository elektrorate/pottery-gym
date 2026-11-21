import type { Student, Teacher } from '../types';
import { presentPersonName } from './displayName';

const sameContact = (left?: string | null, right?: string | null) => {
  const a = (left || '').replace(/\s+/g, '').toLocaleLowerCase('es-ES');
  const b = (right || '').replace(/\s+/g, '').toLocaleLowerCase('es-ES');
  return !!a && a === b;
};

export const duplicateStudentContact = (candidate: { id?: string; email?: string; phone?: string }, students: Student[]) =>
  students.find(student => student.id !== candidate.id && (sameContact(student.email, candidate.email) || sameContact(student.phone, candidate.phone)));

export const duplicateTeacherContact = (candidate: { id?: string; email?: string; phone?: string }, teachers: Teacher[]) =>
  teachers.find(teacher => teacher.id !== candidate.id && (sameContact(teacher.email, candidate.email) || sameContact(teacher.phone, candidate.phone)));

export const duplicateContactMessage = (kind: 'alumno' | 'profesor', name: string, email?: string, phone?: string) => {
  const which = email && phone ? 'el email y el teléfono' : email ? 'el email' : 'el teléfono';
  return `Ya hay un ${kind} con ${which}: ${name}. Puede continuar si se trata de otra persona.`;
};

export const personLabel = (record: { name: string; surname?: string }) => presentPersonName(record.name, record.surname);
