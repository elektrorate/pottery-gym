import { expect, test } from '@playwright/test';
import { getStudentLifecycle, getStudentLifecycleCounts, getStudentLifecycleReason, getStudentPaymentStatus, getWorkshopDate } from '../../utils/studentLifecycle';
import type { Student } from '../../types';

const member: Student = {
  id: 'member', name: 'Member', phone: '', studentCategory: 'membresia',
  status: 'membresia', paymentStatus: 'paid', expiryDate: '2026-10-10', classesRemaining: 4
};

test('due date inclusive; pending days 1–5; inactive starting on day 6', () => {
  expect(getStudentLifecycle(member, '2026-10-10')).toBe('active');
  for (let day = 11; day <= 15; day++) expect(getStudentLifecycle(member, `2026-10-${day}`)).toBe('pending');
  expect(getStudentLifecycle(member, '2026-10-16')).toBe('archived');
  expect(getStudentLifecycle(member, '2027-01-01')).toBe('archived');
});

test('zero classes and automatic renewal preference do not override payment dates', () => {
  expect(getStudentLifecycle({ ...member, classesRemaining: 0 }, '2026-10-10')).toBe('active');
  expect(getStudentLifecycle({ ...member, repetirMensualmente: true }, '2026-10-16')).toBe('archived');
  expect(getStudentLifecycle({ ...member, paymentStatus: 'pending' }, '2026-10-10')).toBe('pending');
});

test('temporary students never enter membership states based on balance or expiry', () => {
  for (const classesRemaining of [0, 1, 3]) {
    expect(getStudentLifecycle({ ...member, studentCategory: 'temporal', classesRemaining }, '2026-11-01')).toBe('temporary');
  }
  expect(getStudentLifecycle({ ...member, studentCategory: 'temporal', archivedAt: '2026-10-01' })).toBe('archived');
});

test('renewal reactivates expired records, explicit archives require clearing', () => {
  const renewed = { ...member, expiryDate: '2026-11-16' };
  expect(getStudentLifecycle(renewed, '2026-10-16')).toBe('active');
  expect(getStudentLifecycle({ ...renewed, archivedAt: '2026-10-01' }, '2026-10-16')).toBe('archived');
  expect(getStudentLifecycle({ ...renewed, archivedAt: '' }, '2026-10-16')).toBe('active');
});

test('missing dates and ambiguous legacy payments stay pending', () => {
  expect(getStudentLifecycle({ ...member, expiryDate: undefined }, '2026-10-10')).toBe('pending');
  expect(getStudentPaymentStatus({ status: 'needs_renewal' })).toBe('pending');
  expect(getStudentPaymentStatus({ status: 'new' })).toBe('pending');
  expect(getStudentPaymentStatus({ status: 'needs_renewal', paymentStatus: 'paid' })).toBe('paid');
});

test('lifecycle counts form one exclusive partition and expose safe reasons', () => {
  const students: Student[] = [
    member,
    { ...member, id: 'pending', paymentStatus: 'pending', expiryDate: '2026-10-20' },
    { ...member, id: 'temporary', studentCategory: 'temporal', classesRemaining: 0 },
    { ...member, id: 'archived', archivedAt: '2026-01-01', expiryDate: '2027-01-01' }
  ];
  const counts = getStudentLifecycleCounts(students, '2026-10-10');
  expect(counts).toEqual({ active: 1, pending: 1, temporary: 1, archived: 1 });
  expect(Object.values(counts).reduce((total, count) => total + count, 0)).toBe(students.length);
  expect(getStudentLifecycleReason(students[0], '2026-10-10')).toContain('Membresía vigente hasta');
  expect(getStudentLifecycleReason(students[2], '2026-10-10')).toBe('Clase individual');
  expect(getStudentLifecycleReason(students[3], '2026-10-10')).toContain('Archivado el');
});

test('unrecognized runtime categories never become active silently', () => {
  const legacyRecord = { ...member, studentCategory: 'legacy_category' } as unknown as Student;
  expect(getStudentLifecycle(legacyRecord, '2026-10-10')).toBe('pending');
  expect(getStudentLifecycleReason(legacyRecord, '2026-10-10')).toContain('Categoría no reconocida');
});

test('calendar days remain correct across month, year, leap day and DST boundaries', () => {
  for (const [expiryDate, day5, day6] of [
    ['2026-10-23', '2026-10-28', '2026-10-29'],
    ['2026-03-27', '2026-04-01', '2026-04-02'],
    ['2026-12-29', '2027-01-03', '2027-01-04'],
    ['2028-02-25', '2028-03-01', '2028-03-02']
  ]) {
    expect(getStudentLifecycle({ ...member, expiryDate }, day5)).toBe('pending');
    expect(getStudentLifecycle({ ...member, expiryDate }, day6)).toBe('archived');
  }
  expect(getWorkshopDate(new Date('2026-10-15T22:00:00Z'))).toBe('2026-10-16');
});
