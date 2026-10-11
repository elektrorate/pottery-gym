import { expect, test } from '@playwright/test';
import { addMembershipMonth, getStudentLifecycle, getStudentPaymentStatus, getStudentReactivationUpdates, getWorkshopDate, isStudentArchived, withStudentCreationDefaults, getPendingMembershipPayments } from '../../utils/studentLifecycle';
import type { Student } from '../../types';

const member: Student = {
  id: 'member', name: 'Member', phone: '', studentCategory: 'membresia',
  status: 'membresia', paymentStatus: 'paid', expiryDate: '2026-10-10', classesRemaining: 4
};

test('due date inclusive; pending days 1–5; expired starting on day 6', () => {
  expect(getStudentLifecycle(member, '2026-10-10')).toBe('active');
  for (let day = 11; day <= 15; day++) expect(getStudentLifecycle(member, `2026-10-${day}`)).toBe('pending');
  expect(getStudentLifecycle(member, '2026-10-16')).toBe('expired');
  expect(getStudentLifecycle(member, '2027-01-01')).toBe('expired');
  expect(isStudentArchived(member, '2027-01-01')).toBe(false);
  expect(isStudentArchived({ ...member, archivedAt: '2026-10-01' }, '2027-01-01')).toBe(true);
});

test('zero classes and automatic renewal preference do not override payment dates', () => {
  expect(getStudentLifecycle({ ...member, classesRemaining: 0 }, '2026-10-10')).toBe('active');
  expect(getStudentLifecycle({ ...member, repetirMensualmente: true }, '2026-10-16')).toBe('expired');
  expect(getStudentLifecycle({ ...member, paymentStatus: 'pending' }, '2026-10-10')).toBe('pending');
});

test('known unmanaged categories never enter membership states', () => {
  for (const studentCategory of ['temporal', 'grupal', 'grupo_temporal'] as const) {
    for (const classesRemaining of [0, 1, 3]) {
      expect(getStudentLifecycle({ ...member, studentCategory, classesRemaining }, '2026-11-01')).toBe('temporary');
    }
    expect(getStudentLifecycle({ ...member, studentCategory, archivedAt: '2026-10-01' })).toBe('archived');
  }
});

test('NULL and missing legacy payment remain unknown regardless of legacy status', () => {
  for (const status of ['needs_renewal', 'new', 'active', 'membresia'] as const) {
    for (const paymentStatus of [undefined, null]) {
      expect(getStudentPaymentStatus({ status, paymentStatus })).toBe('unknown');
      expect(getStudentLifecycle({ ...member, status, paymentStatus }, '2026-10-10')).toBe('pending');
      expect(getPendingMembershipPayments({ ...member, status, paymentStatus })).toEqual([]);
    }
  }
  expect(getStudentLifecycle({ ...member, expiryDate: undefined }, '2026-10-10')).toBe('pending');
});

test('calendar days remain correct across month, year, leap day and DST boundaries', () => {
  for (const [expiryDate, day5, day6] of [
    ['2026-10-23', '2026-10-28', '2026-10-29'],
    ['2026-03-27', '2026-04-01', '2026-04-02'],
    ['2026-12-29', '2027-01-03', '2027-01-04'],
    ['2028-02-25', '2028-03-01', '2028-03-02']
  ]) {
    expect(getStudentLifecycle({ ...member, expiryDate }, day5)).toBe('pending');
    expect(getStudentLifecycle({ ...member, expiryDate }, day6)).toBe('expired');
  }
  expect(getWorkshopDate(new Date('2026-10-15T22:00:00Z'))).toBe('2026-10-16');
});

test('creation is pending even if submitted status/payment suggests paid', () => {
  expect(withStudentCreationDefaults(member).paymentStatus).toBe('pending');
});

test('manual reactivation only clears archive for every category', () => {
  expect(getStudentReactivationUpdates()).toEqual({ archivedAt: '' });
  for (const studentCategory of ['membresia', 'temporal', 'grupal', 'grupo_temporal'] as const) {
    const archived = { ...member, studentCategory, archivedAt: '2026-10-01', paymentStatus: 'pending' as const };
    const reactivated = { ...archived, ...getStudentReactivationUpdates() };
    expect(reactivated.paymentStatus).toBe('pending');
    expect(reactivated.classesRemaining).toBe(archived.classesRemaining);
    expect(reactivated.expiryDate).toBe(archived.expiryDate);
    expect(getStudentLifecycle(reactivated, '2026-10-16')).toBe(studentCategory === 'membresia' ? 'expired' : 'temporary');
  }
});

test('calendar-month anniversary clamps month ends; mutation dates remain server-owned', () => {
  for (const [date, expected] of [
    ['2026-01-31', '2026-02-28'], ['2028-01-31', '2028-02-29'],
    ['2026-03-31', '2026-04-30'], ['2026-12-31', '2027-01-31'],
    ['2028-02-29', '2028-03-29'], ['2026-10-16', '2026-11-16']
  ]) expect(addMembershipMonth(date)).toBe(expected);
});

test('pending payments include expired, scheduled and archived periods but never unknown', () => {
  const student: Student = { ...member, archivedAt: '2026-10-01', membershipPeriods: [
    { id: 'old', studentId: member.id, endsOn: '2026-09-01', paymentStatus: 'pending' },
    { id: 'future', studentId: member.id, startsOn: '2026-11-01', paymentStatus: 'pending' },
    { id: 'unknown', studentId: member.id, paymentStatus: null },
    { id: 'paid', studentId: member.id, paymentStatus: 'paid' }
  ] };
  expect(getPendingMembershipPayments(student).map(period => period.id)).toEqual(['old', 'future']);
  expect(getPendingMembershipPayments({ ...member, paymentStatus: 'pending' })).toHaveLength(1);
});
