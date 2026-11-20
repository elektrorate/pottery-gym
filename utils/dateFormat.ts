/** Spanish dates and 24-hour times for Casa Rosier (Europe/Madrid). */

export const DATE_LOCALE = 'es-ES';
export const BUSINESS_TIME_ZONE = 'Europe/Madrid';

export type DateTextStyle = 'numeric' | 'long' | 'weekday' | 'monthYear' | 'medium' | 'weekdayShort';

const styles: Record<DateTextStyle, Intl.DateTimeFormatOptions> = {
  numeric: { timeZone: BUSINESS_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' },
  long: { timeZone: BUSINESS_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' },
  weekday: { timeZone: BUSINESS_TIME_ZONE, weekday: 'long' },
  monthYear: { timeZone: BUSINESS_TIME_ZONE, month: 'long', year: 'numeric' },
  medium: { timeZone: BUSINESS_TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' },
  weekdayShort: { timeZone: BUSINESS_TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }
};

const clockOptions: Intl.DateTimeFormatOptions = {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  hourCycle: 'h23'
};

const pad = (value: number) => String(value).padStart(2, '0');

export const isDateOnlyKey = (value: string) => /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value);

/** Validate a calendar day and return yyyy-mm-dd. Uses UTC so the host timezone cannot move the day. */
export const calendarKey = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
};

/** Business calendar day for an instant. Independent of the browser timezone. */
export const madridDateKey = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat(DATE_LOCALE, {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '';
  const key = `${read('year')}-${read('month')}-${read('day')}`;
  return isDateOnlyKey(key) ? key : '';
};

/**
 * Read a date the user typed or that we already store, without moving the calendar day.
 * `20/12/2026` stays `2026-12-20`. A local midnight converted with toISOString() would
 * become `2026-12-19` in Europe/Madrid (UTC+1); this path never does that.
 * A full timestamp is the Madrid calendar day, not the UTC date slice.
 */
export const parseDateOnly = (input: string | null | undefined): string | null => {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return calendarKey(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const spanish = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(trimmed);
  if (spanish) return calendarKey(Number(spanish[3]), Number(spanish[2]), Number(spanish[1]));
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime())) return null;
    const key = madridDateKey(parsed);
    return key || null;
  }
  return null;
};

const noonOnDateKey = (key: string): Date | null => {
  const parsed = isDateOnlyKey(key) ? key : parseDateOnly(key);
  if (!parsed) return null;
  // Noon UTC is the same calendar day in Europe/Madrid all year (UTC+1/+2).
  return new Date(`${parsed}T12:00:00.000Z`);
};

const asInstant = (value: string | Date): Date | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const trimmed = value.trim();
  if (isDateOnlyKey(trimmed) || /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.test(trimmed)) return noonOnDateKey(trimmed);
  const parsed = new Date(trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/** dd/mm/aaaa by default. Date-only values keep their calendar day. Instants use Europe/Madrid. */
export const formatDate = (
  value: string | Date | null | undefined,
  style: DateTextStyle = 'numeric',
  fallback = ''
): string => {
  if (value == null || value === '') return fallback;
  const instant = asInstant(value);
  if (!instant) return typeof value === 'string' ? value : fallback;
  return new Intl.DateTimeFormat(DATE_LOCALE, styles[style]).format(instant);
};

/**
 * Clock text is already a workshop time (HH:mm) and is not shifted into another zone.
 * Instants are formatted in Europe/Madrid with a 24-hour clock.
 * `10:00 AM` becomes `10:00`.
 */
export const parseTime = (input: string | null | undefined): string | null => {
  if (input == null) return null;
  const trimmed = input.trim();
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (clock) return `${clock[1].padStart(2, '0')}:${clock[2]}`;
  if (trimmed === '24:00' || trimmed === '24:00:00') return '24:00';
  const meridiem = /^(\d{1,2}):([0-5]\d)\s*([AaPp])\.?\s*[Mm]\.?$/.exec(trimmed);
  if (!meridiem) return null;
  let hour = Number(meridiem[1]);
  if (hour < 1 || hour > 12) return null;
  const isPm = meridiem[3].toLowerCase() === 'p';
  if (hour === 12) hour = isPm ? 12 : 0;
  else if (isPm) hour += 12;
  return `${pad(hour)}:${meridiem[2]}`;
};

export const formatTime = (value: string | Date | null | undefined, fallback = ''): string => {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    const clock = parseTime(value);
    if (clock) return clock;
    if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(value.trim())) return fallback || value;
  }
  const instant = value instanceof Date ? value : asInstant(value);
  if (!instant) return fallback;
  return new Intl.DateTimeFormat(DATE_LOCALE, clockOptions).format(instant);
};

export const formatDateTime = (value: string | Date | null | undefined, fallback = ''): string => {
  if (value == null || value === '') return fallback;
  const date = formatDate(value);
  if (!date || (typeof value === 'string' && date === value && !parseDateOnly(value))) return fallback || (typeof value === 'string' ? value : fallback);
  if (typeof value === 'string' && (isDateOnlyKey(value.trim()) || /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.test(value.trim()))) return date;
  const time = formatTime(value);
  return time ? `${date}, ${time}` : date;
};

/** Calendar heading for a grid cell built in local year/month/day, without moving that day. */
export const formatCalendarDate = (date: Date, style: DateTextStyle = 'long'): string => {
  const key = calendarKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return key ? formatDate(key, style) : '';
};

export const capitalizeEs = (value: string) => value ? value.charAt(0).toLocaleUpperCase(DATE_LOCALE) + value.slice(1) : value;

export const addDaysToDateKey = (dateKey: string, amount: number): string => {
  const parsed = parseDateOnly(dateKey);
  if (!parsed) return dateKey;
  const [year, month, day] = parsed.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
};

/** Monday–Sunday range for a date-only key. Does not pass through the host timezone. */
export const weekRangeForDateKey = (dateKey: string): { start: string; end: string } => {
  const parsed = parseDateOnly(dateKey);
  if (!parsed) return { start: dateKey, end: dateKey };
  const [year, month, day] = parsed.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  const start = addDaysToDateKey(parsed, -mondayOffset);
  return { start, end: addDaysToDateKey(start, 6) };
};

export const shiftMonth = (year: number, month: number, delta: number) => {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
};

export const monthGrid = (year: number, month: number): Array<{ key: string; day: number; inMonth: boolean }> => {
  const first = calendarKey(year, month, 1);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = calendarKey(year, month, lastDay);
  if (!first || !last) return [];
  const leading = (new Date(`${first}T12:00:00.000Z`).getUTCDay() + 6) % 7;
  const cells: Array<{ key: string; day: number; inMonth: boolean }> = [];
  for (let index = leading; index > 0; index -= 1) {
    const key = addDaysToDateKey(first, -index);
    cells.push({ key, day: Number(key.slice(8)), inMonth: false });
  }
  for (let day = 1; day <= lastDay; day += 1) {
    cells.push({ key: calendarKey(year, month, day)!, day, inMonth: true });
  }
  let step = 1;
  while (cells.length % 7 !== 0) {
    const key = addDaysToDateKey(last, step);
    cells.push({ key, day: Number(key.slice(8)), inMonth: false });
    step += 1;
  }
  return cells;
};
