export type TimeRange = { startTime: string; endTime: string };

const toMinutes = (clock: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec((clock || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 24 && minutes === 0) return 24 * 60;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/** Half-open overlap: a session ending when the next starts is not a conflict. */
export const rangesOverlap = (left: TimeRange, right: TimeRange) => {
  const a0 = toMinutes(left.startTime);
  const a1 = toMinutes(left.endTime);
  const b0 = toMinutes(right.startTime);
  const b1 = toMinutes(right.endTime);
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
  if (a1 <= a0 || b1 <= b0) return false;
  return a0 < b1 && b0 < a1;
};

export type OverlapPlacement = { column: number; columns: number };

/**
 * Side-by-side columns for any overlapping interval, not only events that
 * share the same start time.
 */
export const layoutOverlapping = <T extends TimeRange & { id: string }>(items: T[]): Map<string, OverlapPlacement> => {
  const sorted = [...items].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || a.id.localeCompare(b.id));
  const placement = new Map<string, OverlapPlacement>();
  let cluster: T[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const columnEnds: number[] = [];
    const assigned: Array<{ id: string; column: number }> = [];
    cluster.forEach(item => {
      const start = toMinutes(item.startTime) ?? 0;
      const end = toMinutes(item.endTime) ?? start;
      let column = columnEnds.findIndex(edge => edge <= start);
      if (column < 0) {
        column = columnEnds.length;
        columnEnds.push(end);
      } else columnEnds[column] = end;
      assigned.push({ id: item.id, column });
    });
    const columns = Math.max(1, columnEnds.length);
    assigned.forEach(item => placement.set(item.id, { column: item.column, columns }));
    cluster = [];
    clusterEnd = -1;
  };
  sorted.forEach(item => {
    const start = toMinutes(item.startTime) ?? 0;
    const end = toMinutes(item.endTime) ?? start;
    if (cluster.length && start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, end);
  });
  flush();
  return placement;
};

export type TeacherSlot = TimeRange & {
  id: string;
  date: string;
  teacherId?: string;
  teacherSubstituteId?: string;
  blockTeacherIds?: string[];
  label: string;
};

const peopleOf = (slot: TeacherSlot) =>
  [...new Set([slot.teacherId, slot.teacherSubstituteId, ...(slot.blockTeacherIds || [])].filter((id): id is string => !!id))];

export type RoomSlot = TimeRange & {
  id: string;
  date: string;
  classType?: string;
  label: string;
};

/** Same class type is the same room. A different teacher there still overlaps. */
export const findRoomOverlaps = (candidate: RoomSlot, existing: RoomSlot[]) => {
  if (!candidate.classType || candidate.classType === 'feriado') return [];
  return existing.filter(slot => {
    if (slot.id === candidate.id || slot.date !== candidate.date) return false;
    if (!slot.classType || slot.classType === 'feriado' || slot.classType !== candidate.classType) return false;
    return rangesOverlap(candidate, slot);
  });
};

export const findTeacherOverlaps = (candidate: TeacherSlot, existing: TeacherSlot[]) => {
  const people = new Set(peopleOf(candidate));
  if (!people.size) return [];
  return existing.filter(slot => {
    if (slot.id === candidate.id || slot.date !== candidate.date) return false;
    if (!rangesOverlap(candidate, slot)) return false;
    return peopleOf(slot).some(id => people.has(id));
  });
};

export type ActivitySlot = TimeRange & { id: string; date: string; label: string; kind: 'session' | 'activity' };

export const findScheduleOverlaps = (candidate: ActivitySlot, existing: ActivitySlot[]) =>
  existing.filter(slot => slot.id !== candidate.id && slot.date === candidate.date && rangesOverlap(candidate, slot));

/** Visible hour range: opening hours when known, otherwise the sessions of the day. */
export const visibleHourRange = (
  sessions: TimeRange[],
  opening: TimeRange[]
): { startHour: number; endHour: number } => {
  const minutes = (ranges: TimeRange[]) => ranges.flatMap(range => {
    const start = toMinutes(range.startTime);
    const end = toMinutes(range.endTime);
    return start == null || end == null ? [] : [start, end];
  });
  const open = minutes(opening);
  const used = minutes(sessions);
  const pool = open.length ? open : used;
  if (!pool.length) return { startHour: 9, endHour: 18 };
  const startHour = Math.max(0, Math.floor(Math.min(...pool) / 60));
  const endHour = Math.min(24, Math.ceil(Math.max(...pool) / 60));
  return { startHour, endHour: Math.max(endHour, startHour + 1) };
};
