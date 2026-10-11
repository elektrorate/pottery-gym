import type { AssignedClass, ClassSession, Student } from '../types';

// Display names are snapshots, never a fallback identity for historical records.
export const attachAttendanceHistory = (students: Student[], sessions: ClassSession[]): Student[] => {
  const history: Record<string, AssignedClass[]> = {};
  for (const session of sessions) {
    for (const studentId of session.studentIds || []) {
      const status = session.attendanceByStudentId?.[studentId];
      if (!studentId || (status !== 'present' && status !== 'absent')) continue;
      (history[studentId] ||= []).push({ date: session.date, startTime: session.startTime, endTime: session.endTime, status });
    }
  }
  return students.map(student => ({ ...student, assignedClasses: history[student.id] || [] }));
};
