import { expect, test } from '@playwright/test';
import { attachAttendanceHistory } from '../../utils/attendanceHistory';
import type { ClassSession, Student } from '../../types';

const students: Student[] = ['first', 'second'].map(id => ({ id, name: 'Alex', surname: 'Perez', phone: '', status: 'membresia', classesRemaining: 3 }));
const session: ClassSession = { id: 'session', date: '2026-10-11', startTime: '10:00', endTime: '12:00', classType: 'mesa',
  students: ['ALEX PEREZ', 'ALEX PEREZ'], studentIds: ['first', 'second'], attendance: { 'ALEX PEREZ': 'present' },
  attendanceByStudentId: { first: 'present', second: 'absent' } };

test('homonymous students have separate authoritative ID attendance histories', () => {
  const mapped = attachAttendanceHistory(students, [session]);
  expect(mapped[0].assignedClasses?.[0].status).toBe('present');
  expect(mapped[1].assignedClasses?.[0].status).toBe('absent');
  expect(students.every(student => student.assignedClasses === undefined)).toBe(true);
});

test('renames and reordered display labels cannot move historical attendance', () => {
  const mapped = attachAttendanceHistory([{ ...students[0], name: 'Renamed' }, students[1]], [{ ...session, students: ['Different', 'Names'] }]);
  expect(mapped[0].assignedClasses).toHaveLength(1);
  expect(mapped[1].assignedClasses?.[0].status).toBe('absent');
});

test('unlinked legacy names and pending statuses never manufacture a personal history', () => {
  expect(attachAttendanceHistory(students, [{ ...session, studentIds: undefined }]).every(student => student.assignedClasses?.length === 0)).toBe(true);
  expect(attachAttendanceHistory(students, [{ ...session, attendanceByStudentId: { first: 'pending' } }]).every(student => student.assignedClasses?.length === 0)).toBe(true);
});
