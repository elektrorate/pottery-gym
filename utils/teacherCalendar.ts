import type { CapacityActivity, ClassSession } from '../types';

/** A teacher is assigned as the planned teacher, the substitute, or a mixed-session block teacher. */
export const sessionAssignedToTeacher = (session: ClassSession, teacherId: string) => {
  if (!teacherId) return false;
  if (session.teacherId === teacherId || session.teacherSubstituteId === teacherId) return true;
  return (session.activityBlocks || []).some(block => block.teacherId === teacherId);
};

export const teacherBlockActivities = (session: ClassSession, teacherId: string): CapacityActivity[] =>
  (session.activityBlocks || [])
    .filter(block => block.teacherId === teacherId)
    .map(block => block.activityType);

/** Scheduled classes have no completedAt. Completed classes sort newest first; scheduled ones, soonest first. */
export const teacherSessions = (sessions: ClassSession[], teacherId: string, completed: boolean) =>
  sessions
    .filter(session => sessionAssignedToTeacher(session, teacherId) && Boolean(session.completedAt) === completed)
    .sort((a, b) => {
      const order = `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`);
      return completed ? -order : order;
    });
