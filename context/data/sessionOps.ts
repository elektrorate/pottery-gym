import { getDefaultSessionCapacity, type ClassSession, type SessionBusinessIntent, type PendingSessionOperation } from '../../types';
import { showError } from '../toast';
import { withTimeout, supabase, buildSessionPayload, type OpsContext } from './shared';
import {
    SessionIntentStore, attendanceInput, createSessionAttendanceIntent, createSessionOperations,
    createSessionReservationIntent, createSessionBusinessIntent, requireSessionRevision, reservationInput, resolveSessionStudentIds,
    type RevisionedSession, type SessionUpdates, type SessionReservationActivityBlock
} from './sessionAttendanceOps';

let store: SessionIntentStore;
const pendingStore = () => store ??= new SessionIntentStore();
const sessionSede = (ctx: OpsContext, id?: string) => ctx.sessions.find(session => session.id === id)?.sedeId || ctx.sedeId;
const operations = (ctx: OpsContext) => {
    ctx.assertScope();
    return createSessionOperations({
        rpc: (name, args) => {
            ctx.assertScope();
            return withTimeout(name, supabase.rpc(name, args));
        },
        refresh: async () => {
            ctx.assertScope();
            await ctx.safeReload();
            ctx.assertScope();
        },
        store: pendingStore()
    });
};

const reservationBlocks = (session: Omit<ClassSession, 'id'>, studentIds: string[], current?: ClassSession): SessionReservationActivityBlock[] | undefined => {
    if (session.classType !== 'mixto') {
        if (session.activityBlocks?.length || current?.classType === 'mixto') throw new Error('Los bloques requieren una sesion mixta; no conviertas su historial en clasico.');
        return undefined;
    }
    if (session.attendancePolicyVersion !== undefined && session.attendancePolicyVersion !== 2) throw new Error('La sesion mixta requiere politica 2.');
    if (session.teacherId) throw new Error('Asigna el profesor por bloque, no a la sesion mixta padre.');
    if (!Array.isArray(session.activityBlocks) || !session.activityBlocks.length) throw new Error('La sesion mixta requiere bloques explicitos.');
    const cancelled = (current?.studentIds || []).filter(id => current?.businessStateByStudentId?.[id]?.reservationState === 'cancelled');
    const blocks = session.activityBlocks.map(block => {
        if (!Array.isArray(block?.studentIds)) throw new Error('El bloque requiere IDs de alumnos explicitos.');
        if (block.id !== undefined && !current?.activityBlocks?.some(original => original.id === block.id)) {
            throw new Error('El ID de bloque no pertenece a la sesion cargada.');
        }
        return { ...block, studentIds: block.studentIds.filter(id => !cancelled.includes(id)) };
    });
    const active = studentIds.filter(id => !cancelled.includes(id));
    const assigned = blocks.flatMap(block => block.studentIds);
    if (assigned.length !== active.length || new Set(assigned).size !== assigned.length || active.some(id => !assigned.includes(id))) {
        throw new Error('Cada ID activo debe pertenecer exactamente a un bloque.');
    }
    if (current && (current.completedAt || cancelled.length)) {
        const originals = (current.activityBlocks || []).map(block => ({ ...block, studentIds: block.studentIds.filter(id => !cancelled.includes(id)) }));
        const shape = (items: typeof blocks) => items.map(block => reservationInput({ activityBlocks: [{ ...block, studentIds: [...block.studentIds].sort() }] })).sort().join('|');
        if (shape(blocks) !== shape(originals)
            || session.classType !== current.classType || session.capacity !== current.capacity
            || session.date !== current.date || session.startTime !== current.startTime || session.endTime !== current.endTime) {
            throw new Error('El historial mixto protege sus bloques, profesores, cupos y horario originales.');
        }
    }
    return blocks.map(block => ({ ...(block.id === undefined ? {} : { id: block.id }), activity_type: block.activityType,
        teacher_id: block.teacherId ?? null, capacity: block.capacity, student_ids: block.studentIds }));
};

export const getPendingSessionOperation = (ctx: OpsContext, id?: string): PendingSessionOperation | null => {
    const sedeId = sessionSede(ctx, id);
    if (!sedeId) return null;
    const intent = pendingStore().get(`${sedeId}:${id || 'new-session'}`);
    if (!intent) return null;
    if (intent.args.p_session_id !== intent.sessionId || intent.args.p_request_key !== intent.requestKey
        || !Number.isSafeInteger(intent.args.p_expected_revision)) throw new Error('El intento guardado requiere revision de su recibo; no se sustituira automaticamente.');
    return { operation: intent.operation, sessionId: intent.sessionId, requestKey: intent.requestKey,
        expectedRevision: intent.args.p_expected_revision, isNewSession: !id,
        studentId: intent.args.p_student_id, reason: intent.args.p_reason };
};

export const retryPendingSessionOperation = async (ctx: OpsContext, id?: string) => {
    const sedeId = sessionSede(ctx, id);
    if (!sedeId) throw new Error('Selecciona la sede antes de recuperar el intento.');
    const key = `${sedeId}:${id || 'new-session'}`;
    const intent = pendingStore().get(key);
    if (!intent) throw new Error('No hay un intento pendiente para recuperar.');
    getPendingSessionOperation(ctx, id);
    await operations(ctx).save(key, intent.input, () => intent);
    ctx.assertScope();
};

export const addSession = async (ctx: OpsContext, newSession: Omit<ClassSession, 'id'>) => {
    try {
        if (!ctx.sedeId) throw new Error('Selecciona una sede antes de crear la sesion.');
        const input = reservationInput(newSession);
        const key = `${ctx.sedeId}:new-session`;
        const receipt = await operations(ctx).save(key, input, () => {
            const capacity = newSession.classType === 'feriado' ? 1 : newSession.capacity
                ?? ctx.capacityDefaults.find(item => item.classType === newSession.classType)?.capacity
                ?? getDefaultSessionCapacity(newSession.classType);
            if (newSession.classType === 'mixto' && !newSession.studentIds) throw new Error('La reserva mixta requiere el roster por ID, no por nombre.');
            const studentIds = resolveSessionStudentIds(ctx.students, newSession.students || [], newSession.studentIds);
            const blocks = reservationBlocks(newSession, studentIds);
            if (newSession.attendancePolicyVersion === 1 && Object.keys(newSession.manualCreditIdByStudentId || {}).length) {
                throw new Error('El credito manual requiere una sesion con politica 2.');
            }
            if (newSession.completedAt || Object.values(newSession.attendanceByStudentId || newSession.attendance || {}).some(status => status === 'present')) {
                throw new Error('Crea la reserva primero; guarda la asistencia con la operacion atomica.');
            }
            const metadata = buildSessionPayload({ ...newSession, capacity: blocks ? newSession.capacity : capacity });
            if (blocks) metadata.teacher_id = null;
            delete metadata.completed_at;
            delete metadata.teacher_substitute_id;
            return createSessionReservationIntent(crypto.randomUUID(), 0, ctx.sedeId!, metadata,
                studentIds, newSession.giftCardIdByStudentId || {}, input, undefined, newSession.manualCreditIdByStudentId || {}, blocks);
        });
        ctx.assertScope();
        return receipt;
    } catch (error: any) {
        showError(`No se pudo crear la sesion. ${error.message || ''}`);
        throw error;
    }
};

export const updateSession = async (ctx: OpsContext, id: string, updates: SessionUpdates): Promise<boolean> => {
    const current = ctx.sessions.find(session => session.id === id) as RevisionedSession | undefined;
    if (!current) throw new Error('La sesion no esta cargada. Recarga antes de guardar.');
    const sedeId = sessionSede(ctx, id);
    if (!sedeId) throw new Error('La sesion no tiene una sede verificable.');
    const attendance = updates.attendanceByStudentId !== undefined || updates.attendance !== undefined || updates.completedAt !== undefined;
    if (attendance) {
        if (Object.keys(updates).some(key => !['attendanceByStudentId', 'attendance', 'revision', 'completedAt', 'teacherSubstituteId'].includes(key))) {
            throw new Error('Guarda los cambios de reserva por separado de la asistencia.');
        }
        await operations(ctx).save(`${sedeId}:${id}`, attendanceInput(updates),
            () => createSessionAttendanceIntent(current, ctx.students, updates));
    } else {
        const input = reservationInput(updates);
        await operations(ctx).save(`${sedeId}:${id}`, input, () => {
            if (updates.teacherSubstituteId !== undefined) throw new Error('Guarda el suplente junto con la asistencia.');
            const merged = { ...current, ...updates };
            if (merged.classType === 'mixto' && (!merged.studentIds || (updates.students !== undefined && updates.studentIds === undefined))) {
                throw new Error('La reserva mixta requiere el roster por ID, no por nombre.');
            }
            const studentIds = resolveSessionStudentIds(ctx.students, merged.students || [],
                updates.studentIds ?? (updates.students === undefined ? current.studentIds : undefined));
            const cancelledIds = current.attendancePolicyVersion === 2 ? (current.studentIds || [])
                .filter(studentId => current.businessStateByStudentId?.[studentId]?.reservationState === 'cancelled') : [];
            // Cancelled enrollments are tombstones, including their original source maps.
            for (const studentId of cancelledIds) if (!studentIds.includes(studentId)) studentIds.push(studentId);
            const blocks = reservationBlocks(merged, studentIds, current);
            const metadata = buildSessionPayload({ ...merged, capacity: merged.classType === 'feriado' ? 1 : merged.capacity
                ?? ctx.capacityDefaults.find(item => item.classType === merged.classType)?.capacity
                ?? getDefaultSessionCapacity(merged.classType) });
            delete metadata.completed_at;
            delete metadata.teacher_substitute_id;
            if (blocks) {
                metadata.teacher_id = null;
                if (merged.capacity === undefined) delete metadata.capacity;
            }
            const giftCardIds = Object.fromEntries(Object.entries(updates.giftCardIdByStudentId ?? current.giftCardIdByStudentId ?? {})
                .filter(([studentId]) => studentIds.includes(studentId)));
            const manualCreditIds = Object.fromEntries(Object.entries(updates.manualCreditIdByStudentId ?? current.manualCreditIdByStudentId ?? {})
                .filter(([studentId]) => studentIds.includes(studentId)));
            for (const mapping of [updates.giftCardIdByStudentId, updates.manualCreditIdByStudentId]) {
                if (Object.keys(mapping || {}).some(studentId => !studentIds.includes(studentId) && !current.studentIds?.includes(studentId))) {
                    throw new Error('La financiacion contiene un ID fuera del roster.');
                }
            }
            if (current.attendancePolicyVersion !== 2 && Object.keys(manualCreditIds).length) {
                throw new Error('El credito manual requiere una sesion con politica 2.');
            }
            for (const studentId of blocks ? cancelledIds : []) {
                for (const [mapping, original] of [[giftCardIds, current.giftCardIdByStudentId], [manualCreditIds, current.manualCreditIdByStudentId]] as const) {
                    if (mapping[studentId] !== undefined && mapping[studentId] !== original?.[studentId]) {
                        throw new Error('La financiacion original cancelada es inmutable.');
                    }
                    if (original?.[studentId]) mapping[studentId] = original[studentId];
                }
            }
            for (const studentId of current.completedAt ? current.studentIds || [] : cancelledIds) {
                if (!studentIds.includes(studentId) || giftCardIds[studentId] !== current.giftCardIdByStudentId?.[studentId]
                    || manualCreditIds[studentId] !== current.manualCreditIdByStudentId?.[studentId]) {
                    throw new Error('La financiacion original es inmutable tras finalizar o cancelar la reserva.');
                }
            }
            if (current.completedAt && studentIds.some(studentId => !current.studentIds?.includes(studentId))) {
                throw new Error('El roster finalizado es inmutable.');
            }
            return createSessionReservationIntent(id, requireSessionRevision(current, updates.revision ?? current.revision),
                sedeId, metadata, studentIds, giftCardIds, input, undefined, manualCreditIds, blocks);
        });
    }
    ctx.assertScope();
    return true;
};

export const applySessionBusinessOperation = async (ctx: OpsContext, intent: SessionBusinessIntent) => {
    const sedeId = sessionSede(ctx, intent.sessionId);
    if (!sedeId) throw new Error('La sesion no tiene una sede verificable.');
    // Validate without retargeting its source/revision after an uncertain write.
    const frozen = createSessionBusinessIntent(intent);
    await operations(ctx).save(`${sedeId}:${intent.sessionId}`, frozen.input, () => frozen);
    ctx.assertScope();
};

export const deleteSession = async (_ctx: OpsContext, _id: string) => {
    // Durable session receipts must remain addressable, including after reversal.
    const error = new Error('La eliminacion de sesiones esta protegida. Conserva el historial y corrige la reserva o asistencia.');
    showError(error.message);
    throw error;
};
