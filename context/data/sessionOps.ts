import { getDefaultSessionCapacity, type ClassSession } from '../../types';
import { showError } from '../toast';
import { withTimeout, supabase, buildSessionPayload, type OpsContext } from './shared';
import {
    SessionIntentStore, attendanceInput, createSessionAttendanceIntent, createSessionOperations,
    createSessionReservationIntent, requireSessionRevision, reservationInput, resolveSessionStudentIds,
    type RevisionedSession, type SessionUpdates
} from './sessionAttendanceOps';

let store: SessionIntentStore;
const operations = (ctx: OpsContext) => createSessionOperations({
    rpc: (name, args) => withTimeout(name, supabase.rpc(name, args)),
    refresh: ctx.safeReload,
    store: store ??= new SessionIntentStore()
});

export const addSession = async (ctx: OpsContext, newSession: Omit<ClassSession, 'id'>) => {
    try {
        if (!ctx.sedeId) throw new Error('Selecciona una sede antes de crear la sesion.');
        const input = reservationInput(newSession);
        const key = `${ctx.sedeId}:new-session`;
        const receipt = await operations(ctx).save(key, input, () => {
            const capacity = newSession.classType === 'feriado' ? 1 : newSession.capacity
                ?? ctx.capacityDefaults.find(item => item.classType === newSession.classType)?.capacity
                ?? getDefaultSessionCapacity(newSession.classType);
            const studentIds = resolveSessionStudentIds(ctx.students, newSession.students || [], newSession.studentIds);
            if (newSession.completedAt || Object.values(newSession.attendanceByStudentId || newSession.attendance || {}).some(status => status === 'present')) {
                throw new Error('Crea la reserva primero; guarda la asistencia con la operacion atomica.');
            }
            const metadata = buildSessionPayload({ ...newSession, capacity });
            delete metadata.completed_at;
            delete metadata.teacher_substitute_id;
            return createSessionReservationIntent(crypto.randomUUID(), 0, ctx.sedeId!, metadata,
                studentIds, newSession.giftCardIdByStudentId || {}, input);
        });
        return receipt;
    } catch (error: any) {
        showError(`No se pudo crear la sesion. ${error.message || ''}`);
        throw error;
    }
};

export const updateSession = async (ctx: OpsContext, id: string, updates: SessionUpdates): Promise<boolean> => {
    if (!ctx.sedeId) throw new Error('Selecciona una sede antes de guardar la sesion.');
    const current = ctx.sessions.find(session => session.id === id) as RevisionedSession | undefined;
    if (!current) throw new Error('La sesion no esta cargada. Recarga antes de guardar.');
    const attendance = updates.attendanceByStudentId !== undefined || updates.attendance !== undefined || updates.completedAt !== undefined;
    if (attendance) {
        if (Object.keys(updates).some(key => !['attendanceByStudentId', 'attendance', 'revision', 'completedAt', 'teacherSubstituteId'].includes(key))) {
            throw new Error('Guarda los cambios de reserva por separado de la asistencia.');
        }
        await operations(ctx).save(`${ctx.sedeId}:${id}`, attendanceInput(updates),
            () => createSessionAttendanceIntent(current, ctx.students, updates));
    } else {
        const input = reservationInput(updates);
        await operations(ctx).save(`${ctx.sedeId}:${id}`, input, () => {
            if (updates.teacherSubstituteId !== undefined) throw new Error('Guarda el suplente junto con la asistencia.');
            const merged = { ...current, ...updates };
            const studentIds = resolveSessionStudentIds(ctx.students, merged.students || [],
                updates.studentIds ?? (updates.students === undefined ? current.studentIds : undefined));
            const metadata = buildSessionPayload({ ...merged, capacity: merged.classType === 'feriado' ? 1 : merged.capacity
                ?? ctx.capacityDefaults.find(item => item.classType === merged.classType)?.capacity
                ?? getDefaultSessionCapacity(merged.classType) });
            delete metadata.completed_at;
            delete metadata.teacher_substitute_id;
            const giftCardIds = updates.giftCardIdByStudentId ?? Object.fromEntries(
                Object.entries(current.giftCardIdByStudentId || {}).filter(([studentId]) => studentIds.includes(studentId))
            );
            return createSessionReservationIntent(id, requireSessionRevision(current, updates.revision ?? current.revision),
                ctx.sedeId!, metadata, studentIds, giftCardIds, input);
        });
    }
    return true;
};

export const deleteSession = async (_ctx: OpsContext, _id: string) => {
    // Durable session receipts must remain addressable, including after reversal.
    const error = new Error('La eliminacion de sesiones esta protegida. Conserva el historial y corrige la reserva o asistencia.');
    showError(error.message);
    throw error;
};
