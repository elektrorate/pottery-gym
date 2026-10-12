import { getDefaultSessionCapacity, type ClassSession, type SessionActivityBlock, type SessionBusinessIntent, type PendingSessionOperation } from '../../types';
import { showError } from '../toast';
import { withTimeout, supabase, buildSessionPayload, type OpsContext } from './shared';
import {
    SessionIntentStore, attendanceInput, createSessionAttendanceIntent, createSessionOperations,
    createSessionReservationIntent, createSessionBusinessIntent, requireSessionRevision, reservationInput, resolveSessionStudentIds,
    type RevisionedSession, type SessionUpdates
} from './sessionAttendanceOps';

let store: SessionIntentStore;
const pendingStore = () => store ??= new SessionIntentStore();
const sessionSede = (ctx: OpsContext, id?: string) => ctx.sessions.find(session => session.id === id)?.sedeId || ctx.sedeId;
const operations = (ctx: OpsContext) => createSessionOperations({
    rpc: (name, args) => withTimeout(name, supabase.rpc(name, args)),
    refresh: ctx.safeReload,
    store: pendingStore()
});

const persistActivityBlocks = async (sessionId: string, sedeId: string, blocks: SessionActivityBlock[] = []) => {
    const sourceBlocks = blocks.filter(block => block.activityType !== 'mixto' && block.studentIds.length > 0);
    const normalized = sourceBlocks
        .map(block => ({ session_id: sessionId, sede_id: sedeId, activity_type: block.activityType,
            teacher_id: block.teacherId || null, capacity: block.capacity }));
    const { data: existing, error: existingError } = await withTimeout('session_activity_blocks.select',
        supabase.from('session_activity_blocks').select('id').eq('session_id', sessionId));
    if (existingError) throw existingError;
    if (existing?.length) {
        const { error } = await withTimeout('session_activity_blocks.delete', supabase.from('session_activity_blocks').delete().eq('session_id', sessionId));
        if (error) throw error;
    }
    if (!normalized.length) return;
    const { data: saved, error } = await withTimeout('session_activity_blocks.insert', supabase.from('session_activity_blocks').insert(normalized).select('id,activity_type,teacher_id,capacity'));
    if (error) throw error;
    const rows = (saved || []).flatMap((block: any, index: number) => (sourceBlocks[index]?.studentIds || []).map(student_id => ({
        block_id: block.id, session_id: sessionId, student_id
    })));
    if (rows.length) {
        const result = await withTimeout('session_activity_block_students.insert', supabase.from('session_activity_block_students').insert(rows));
        if (result.error) throw result.error;
    }
    for (const block of sourceBlocks) {
        if (!block.studentIds.length) continue;
        const result = await withTimeout('session_students.activity_type.update', supabase.from('session_students')
            .update({ activity_type: block.activityType }).eq('session_id', sessionId).in('student_id', block.studentIds));
        if (result.error) throw result.error;
    }
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
            const studentIds = resolveSessionStudentIds(ctx.students, newSession.students || [], newSession.studentIds);
            if (newSession.attendancePolicyVersion === 1 && Object.keys(newSession.manualCreditIdByStudentId || {}).length) {
                throw new Error('El credito manual requiere una sesion con politica 2.');
            }
            if (newSession.completedAt || Object.values(newSession.attendanceByStudentId || newSession.attendance || {}).some(status => status === 'present')) {
                throw new Error('Crea la reserva primero; guarda la asistencia con la operacion atomica.');
            }
            const metadata = buildSessionPayload({ ...newSession, capacity });
            delete metadata.completed_at;
            delete metadata.teacher_substitute_id;
            return createSessionReservationIntent(crypto.randomUUID(), 0, ctx.sedeId!, metadata,
                studentIds, newSession.giftCardIdByStudentId || {}, input, undefined, newSession.manualCreditIdByStudentId || {});
        });
        await persistActivityBlocks(receipt.session_id, ctx.sedeId, newSession.activityBlocks);
        await ctx.safeReload();
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
            const studentIds = resolveSessionStudentIds(ctx.students, merged.students || [],
                updates.studentIds ?? (updates.students === undefined ? current.studentIds : undefined));
            const cancelledIds = current.attendancePolicyVersion === 2 ? (current.studentIds || [])
                .filter(studentId => current.businessStateByStudentId?.[studentId]?.reservationState === 'cancelled') : [];
            // Cancelled enrollments are tombstones, including their original source maps.
            for (const studentId of cancelledIds) if (!studentIds.includes(studentId)) studentIds.push(studentId);
            const metadata = buildSessionPayload({ ...merged, capacity: merged.classType === 'feriado' ? 1 : merged.capacity
                ?? ctx.capacityDefaults.find(item => item.classType === merged.classType)?.capacity
                ?? getDefaultSessionCapacity(merged.classType) });
            delete metadata.completed_at;
            delete metadata.teacher_substitute_id;
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
                sedeId, metadata, studentIds, giftCardIds, input, undefined, manualCreditIds);
        });
        const merged = { ...(current || {}), ...updates } as ClassSession;
        await persistActivityBlocks(id, sedeId, merged.activityBlocks);
        await ctx.safeReload();
    }
    return true;
};

export const applySessionBusinessOperation = async (ctx: OpsContext, intent: SessionBusinessIntent) => {
    const sedeId = sessionSede(ctx, intent.sessionId);
    if (!sedeId) throw new Error('La sesion no tiene una sede verificable.');
    // Validate without retargeting its source/revision after an uncertain write.
    const frozen = createSessionBusinessIntent(intent);
    await operations(ctx).save(`${sedeId}:${intent.sessionId}`, frozen.input, () => frozen);
};

export const deleteSession = async (_ctx: OpsContext, _id: string) => {
    // Durable session receipts must remain addressable, including after reversal.
    const error = new Error('La eliminacion de sesiones esta protegida. Conserva el historial y corrige la reserva o asistencia.');
    showError(error.message);
    throw error;
};
