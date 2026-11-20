import type { ClassSession, WorkshopScheduleDay, WorkshopScheduleException } from '../types';
import { addDaysToDateKey, madridDateKey, parseDateOnly } from './dateFormat';

export { madridDateKey };

export const dateKeyDayOfWeek = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00Z`).getUTCDay();

export const getWeekMonday = (dateKey: string) => {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
};

export const MAX_WEEKLY_SESSIONS = 26;

/** Inclusive weekly dates on the same weekday, capped one past the maximum so callers can reject the overflow. */
export const weeklyDatesUntil = (start: string, until: string) => {
  const dates: string[] = [];
  const first = parseDateOnly(start);
  const last = parseDateOnly(until);
  if (!first || !last || last < first) return dates;
  let cursor = first;
  while (cursor <= last) {
    dates.push(cursor);
    if (dates.length > MAX_WEEKLY_SESSIONS) break;
    cursor = addDaysToDateKey(cursor, 7);
  }
  return dates;
};

export const addDays = (dateKey: string, amount: number) => {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};

export const getScheduleIntervalsForDate = (
  dateKey: string,
  weeklySchedule: WorkshopScheduleDay[],
  exceptions: WorkshopScheduleException[]
) => {
  const exceptional = exceptions.filter(item => item.exceptionDate === dateKey).sort((a, b) => a.slotIndex - b.slotIndex);
  if (exceptional.length > 0) return exceptional.filter(item => item.isOpen);
  const dayOfWeek = dateKeyDayOfWeek(dateKey);
  return weeklySchedule.filter(item => item.dayOfWeek === dayOfWeek && item.isOpen).sort((a, b) => a.slotIndex - b.slotIndex);
};

export const isSessionWithinSchedule = (
  session: Pick<ClassSession, 'date' | 'startTime' | 'endTime' | 'classType'>,
  weeklySchedule: WorkshopScheduleDay[],
  exceptions: WorkshopScheduleException[]
) => {
  if (session.classType === 'feriado') return true;
  return getScheduleIntervalsForDate(session.date, weeklySchedule, exceptions)
    .some(interval => session.startTime >= interval.opensAt && session.endTime <= interval.closesAt);
};

export const getScheduleConflictReason = (
  session: Pick<ClassSession, 'date' | 'startTime' | 'endTime' | 'classType'>,
  weeklySchedule: WorkshopScheduleDay[],
  exceptions: WorkshopScheduleException[]
) => {
  if (weeklySchedule.length === 0 && exceptions.length === 0) return undefined;
  if (session.classType === 'feriado' || isSessionWithinSchedule(session, weeklySchedule, exceptions)) return undefined;
  const intervals = getScheduleIntervalsForDate(session.date, weeklySchedule, exceptions);
  return intervals.length === 0 ? 'El taller está cerrado' : `Fuera de horario (${intervals.map(item => `${item.opensAt}–${item.closesAt}`).join(', ')})`;
};
