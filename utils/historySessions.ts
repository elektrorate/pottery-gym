import type { ClassSession, Student } from '../types';
import { foldAccents } from './textSearch';

const namesOf = (student: Student) => {
  const full = foldAccents(`${student.name} ${student.surname || ''}`);
  const given = foldAccents(student.name);
  return { full, given };
};

/** A session belongs to the student by id, attendance map, or accent-insensitive name. */
export const sessionIncludesStudent = (session: ClassSession, student: Student) => {
  if (session.studentIds?.includes(student.id)) return true;
  if (session.attendanceByStudentId && Object.prototype.hasOwnProperty.call(session.attendanceByStudentId, student.id)) return true;
  const { full, given } = namesOf(student);
  return (session.students || []).some(name => {
    const folded = foldAccents(name);
    return !!folded && (folded === full || folded === given);
  });
};

/** The Historial «Sesiones» count and the class list use this same set. */
export const sessionsForStudent = (sessions: ClassSession[], student: Student) =>
  sessions
    .filter(session => sessionIncludesStudent(session, student))
    .sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
