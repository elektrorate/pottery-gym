import { getDefaultSessionCapacity, type ClassSession, type Student } from '../../types';
import { showError, showWarning } from '../toast';
import { supabase, withTimeout, buildSessionPayload, isAbortError, OpsContext } from './shared';

const findGiftCardForStudent = (ctx: OpsContext, studentName: string, explicitId?: string) => {
    if (explicitId) return explicitId;
    const student = ctx.students.find(s => `${s.name} ${s.surname || ''}`.trim().toUpperCase() === studentName);
    if (!student) return null;
    const compatibleCards = ctx.giftCards
        .filter(card => card.recipientStudentId === student.id && card.status === 'active' && (card.sessionsRemaining ?? 0) > 0)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return compatibleCards[0]?.id || null;
};

type SessionStudentRow = {
    student_id: string;
    student_name: string;
    sede_id?: string | null;
    gift_card_id?: string | null;
};

const isMissingGiftCardColumn = (error: any) => {
    const message = String(error?.message || '').toLowerCase();
    return error?.code === '42703' || (message.includes('gift_card_id') && message.includes('does not exist'));
};

const loadSessionStudents = async (operation: string, sessionId: string) => {
    const result = await withTimeout(`${operation}.select`,
        supabase.from('session_students').select('student_id, student_name, sede_id, gift_card_id').eq('session_id', sessionId)
    );

    // Older installations do not have the optional Gift Card link yet.
    if (result.error && isMissingGiftCardColumn(result.error)) {
        const legacyResult = await withTimeout(`${operation}.select_legacy`,
            supabase.from('session_students').select('student_id, student_name, sede_id').eq('session_id', sessionId)
        );
        if (legacyResult.error) throw new Error(`No se pudo leer session_students: ${legacyResult.error.message}`);
        return { rows: (legacyResult.data || []) as SessionStudentRow[], hasGiftCardColumn: false };
    }

    if (result.error) throw new Error(`No se pudo leer session_students: ${result.error.message}`);
    return { rows: (result.data || []) as SessionStudentRow[], hasGiftCardColumn: true };
};

const syncSessionStudents = async (
    ctx: OpsContext,
    sessionId: string,
    studentNames: string[],
    attendance?: Record<string, 'present' | 'absent'>,
    giftCardIdByStudentId?: Record<string, string>
) => {
    const normalizedNames = [...new Set(studentNames.map(name => name.toUpperCase().trim()).filter(Boolean))];
    const { rows: existingRows, hasGiftCardColumn } = await loadSessionStudents('session_students', sessionId);
    const existingNames = new Set(existingRows.map(row => (row.student_name || '').toUpperCase()));
    const desiredNames = new Set(normalizedNames);

    if (normalizedNames.length === 0) {
        const { error: deleteAllError } = await withTimeout('session_students.delete_all',
            supabase.from('session_students').delete().eq('session_id', sessionId)
        );
        if (deleteAllError) throw new Error(`No se pudo limpiar session_students: ${deleteAllError.message}`);
        return;
    }

    const toDelete = existingRows.filter(row => !desiredNames.has((row.student_name || '').toUpperCase()));
    if (toDelete.length) {
        const studentIdsToDelete = toDelete.map(row => row.student_id).filter(Boolean);
        if (studentIdsToDelete.length) {
            const { error: deleteError } = await withTimeout('session_students.delete_removed',
                supabase.from('session_students').delete().eq('session_id', sessionId).in('student_id', studentIdsToDelete)
            );
            if (deleteError) throw new Error(`No se pudieron eliminar vínculos antiguos: ${deleteError.message}`);
        }
    }

    const toInsert = normalizedNames.filter(name => !existingNames.has(name));
    const insertRows = toInsert.map(name => {
        const student = ctx.students.find(s => `${s.name} ${s.surname || ''}`.trim().toUpperCase() === name);
        if (!student) return null;
        const status = attendance?.[name] === 'present' || attendance?.[name] === 'absent' ? attendance?.[name] : 'pending';
        const giftCardId = findGiftCardForStudent(ctx, name, giftCardIdByStudentId?.[student.id]);
        const isTemporary = student.studentCategory === 'temporal';
        const baseRow = {
            session_id: sessionId, student_id: student.id, student_name: name,
            attendance: status, sede_id: ctx.sedeId || undefined,
            is_temporary: isTemporary, temp_group_name: isTemporary ? (student.groupName || null) : null
        };
        return hasGiftCardColumn ? { ...baseRow, gift_card_id: giftCardId } : baseRow;
    }).filter(Boolean);

    if (insertRows.length) {
        const { error: insertError } = await withTimeout('session_students.upsert',
            supabase.from('session_students').upsert(insertRows, { onConflict: 'session_id,student_id' })
        );
        if (insertError) throw new Error(`No se pudieron vincular alumnos a la sesión: ${insertError.message}`);
    }

    if (attendance && existingRows.length) {
        const updates = existingRows.map(row => {
            const baseRow = {
                session_id: sessionId, student_id: row.student_id, student_name: row.student_name,
                attendance: attendance[(row.student_name || '').toUpperCase()] || attendance[row.student_name || ''] || 'pending',
                sede_id: row.sede_id || ctx.sedeId || undefined
            };
            return hasGiftCardColumn ? {
                ...baseRow,
                gift_card_id: row.gift_card_id || findGiftCardForStudent(ctx, (row.student_name || '').toUpperCase())
            } : baseRow;
        });
        const { error: upsertError } = await withTimeout('session_students.upsert_attendance',
            supabase.from('session_students').upsert(updates, { onConflict: 'session_id,student_id' })
        );
        if (upsertError) throw new Error(`No se pudo actualizar asistencia: ${upsertError.message}`);
    }
};

const updateSessionAttendance = async (ctx: OpsContext, sessionId: string, attendance: Record<string, 'present' | 'absent'>) => {
    let existingRows: SessionStudentRow[];
    let hasGiftCardColumn = true;
    try {
        const result = await loadSessionStudents('session_students.attendance', sessionId);
        existingRows = result.rows;
        hasGiftCardColumn = result.hasGiftCardColumn;
    } catch (error) {
        throw error;
    }
    if (!existingRows.length && Object.keys(attendance).length) throw new Error('La sesión no tiene vínculos de alumnos; no se puede guardar asistencia.');
    const updates = existingRows.map(row => {
        const baseRow = {
            session_id: sessionId, student_id: row.student_id, student_name: row.student_name,
            attendance: attendance[(row.student_name || '').toUpperCase()] || attendance[row.student_name || ''] || 'pending',
            sede_id: row.sede_id || ctx.sedeId || undefined
        };
        return hasGiftCardColumn ? { ...baseRow, gift_card_id: row.gift_card_id || undefined } : baseRow;
    });
    if (updates.length) {
        const { error: upsertError } = await withTimeout('session_students.upsert_attendance_only',
            supabase.from('session_students').upsert(updates, { onConflict: 'session_id,student_id' })
        );
        if (upsertError) throw upsertError;
    }
};

export const addSession = async (ctx: OpsContext, newSession: Omit<ClassSession, 'id'>) => {
    const configuredCapacity = ctx.capacityDefaults.find(item => item.classType === newSession.classType)?.capacity;
    const capacity = newSession.capacity ?? configuredCapacity ?? getDefaultSessionCapacity(newSession.classType);
    if (newSession.students.length > capacity) {
        showError(`La sesión supera su capacidad máxima de ${capacity} alumnos.`);
        return;
    }
    let payload = buildSessionPayload({ ...newSession, capacity });
    if (ctx.sedeId) payload = { ...payload, sede_id: ctx.sedeId };
    let data: any;
    try {
        const res = await withTimeout('sessions.insert', supabase.from('sessions').insert(payload).select().single());
        if (res.error) { showError(`No se pudo crear la sesión. ${res.error.message || ''}`); return; }
        data = res.data;
    } catch (error: any) {
        showError(`No se pudo crear la sesión. ${error.message || 'Conexión lenta, intenta de nuevo.'}`);
        return;
    }

    // IMMEDIATE UI update
    const newSessionWithId: ClassSession = {
        ...newSession,
        capacity,
        id: data.id,
        students: newSession.students || [],
    };
    ctx.setSessions(prev => [newSessionWithId, ...prev]);

    if (newSession.students && newSession.students.length) {
        try {
            await syncSessionStudents(ctx, data.id, newSession.students, newSession.attendance || undefined, newSession.giftCardIdByStudentId);
        } catch (syncErr: any) {
            showWarning(`La sesión se creó, pero no se pudieron vincular alumnos. ${syncErr?.message || ''}`);
        }
    }
    // Background reload
    ctx.safeReload();
};

export const updateSession = async (ctx: OpsContext, id: string, updates: Partial<ClassSession>): Promise<boolean> => {
    if (updates.students) {
        const currentSession = ctx.sessions.find(session => session.id === id);
        const classType = currentSession?.classType || 'mesa';
        const configuredCapacity = ctx.capacityDefaults.find(item => item.classType === classType)?.capacity;
        const capacity = updates.capacity ?? currentSession?.capacity ?? configuredCapacity ?? getDefaultSessionCapacity(classType);
        if (updates.students.length > capacity) {
            showError(`La sesión supera su capacidad máxima de ${capacity} alumnos.`);
            throw new Error(`La sesión supera su capacidad máxima de ${capacity} alumnos.`);
        }
    }
    if (updates.classType === 'feriado') {
        const { error: clearError } = await withTimeout('session_students.clear_for_feriado',
            supabase.from('session_students').delete().eq('session_id', id)
        );
        if (clearError) throw clearError;
    }
    if (updates.students) {
        try { await syncSessionStudents(ctx, id, updates.students!, updates.attendance || undefined, updates.giftCardIdByStudentId); }
        catch (syncErr: any) {
            throw syncErr;
        }
    } else if (updates.attendance) {
        await updateSessionAttendance(ctx, id, updates.attendance);
    }
    // Persist completion only after attendance succeeded (still not a transaction).
    const payload = buildSessionPayload(updates);
    if (Object.keys(payload).length) {
        const { error } = await withTimeout('sessions.update', supabase.from('sessions').update(payload).eq('id', id));
        if (error) throw error;
    }
    await ctx.safeReload();
    return true;
};

export const deleteSession = async (ctx: OpsContext, id: string) => {
    ctx.setSessions(prev => prev.filter(s => s.id !== id));
    try {
        // session_students has ON DELETE CASCADE from sessions
        const { error } = await withTimeout('sessions.delete', supabase.from('sessions').delete().eq('id', id));
        if (error) { showError(`No se pudo eliminar la sesión. ${error.message || ''}`); ctx.safeReload(); return; }
        console.log('deleteSession: sesión eliminada correctamente');
    } catch (err: any) {
        if (isAbortError(err)) { console.warn('deleteSession: request aborted, optimistic update active'); }
        else { showError(`${err.message || 'Error inesperado al eliminar sesión.'}`); }
        ctx.safeReload();
    }
};
