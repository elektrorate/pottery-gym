import React from 'react';
import { supabase } from '../../supabaseClient';
import { Student, ClassSession, GiftCard, WorkshopCapacityDefault } from '../../types';
export { mapStudentRowToModel, mapMembershipPeriod, joinStudentMemberships } from '../../utils/studentLifecycle';

export { supabase };

export const WRITE_TIMEOUT_MS = 15000;
export const RELOAD_TIMEOUT_MS = 12000;

// AbortError happens when React re-renders and the browser cancels an in-flight fetch.
// The operation often succeeded on the server — we should NOT scare the user with an error.
export const isAbortError = (err: any): boolean =>
    err?.name === 'AbortError' || (typeof err?.message === 'string' && err.message.includes('aborted'));

/**
 * Lightweight, privacy-safe Supabase timing trace. It deliberately records
 * only operation metadata (never query parameters or row contents), so it can
 * be enabled in production while diagnosing slow loads from the browser
 * console. Set `localStorage.supabase_query_trace = "off"` to silence it.
 */
const isQueryTraceEnabled = (): boolean => {
    try {
        return typeof window === 'undefined' || window.localStorage.getItem('supabase_query_trace') !== 'off';
    } catch {
        return true;
    }
};

const emitQueryTrace = (operation: string, startedAt: number, result?: any, error?: unknown) => {
    if (!isQueryTraceEnabled()) return;
    const payload = result && typeof result === 'object' ? result : undefined;
    const rows = Array.isArray(payload?.data) ? payload.data.length : payload?.data == null ? undefined : 1;
    const queryError = error ?? payload?.error;
    console.info('[SupabaseTrace]', JSON.stringify({
        operation,
        durationMs: Math.round(performance.now() - startedAt),
        rows,
        ok: !queryError,
        error: queryError ? String(queryError?.message || queryError) : undefined
    }));
};

export const traceSupabaseQuery = async <T,>(operation: string, queryOrPromise: T | Promise<T>): Promise<Awaited<T>> => {
    const startedAt = performance.now();
    try {
        const result = await queryOrPromise;
        emitQueryTrace(operation, startedAt, result);
        return result as Awaited<T>;
    } catch (error) {
        emitQueryTrace(operation, startedAt, undefined, error);
        throw error;
    }
};

// Timeout wrapper with REAL abort after hard limit.
// Warns at timeoutMs, rejects at 2x timeoutMs.
export const withTimeout = async <T,>(
    operation: string,
    queryOrPromise: T | Promise<T>,
    timeoutMs: number = WRITE_TIMEOUT_MS
): Promise<Awaited<T>> => {
    let didWarn = false;
    const hardLimit = timeoutMs * 2; // 30s for writes
    const controller = new AbortController();
    const abortableQuery = queryOrPromise as T & { abortSignal?: (signal: AbortSignal) => T };
    const query = typeof abortableQuery?.abortSignal === 'function'
        ? abortableQuery.abortSignal(controller.signal)
        : queryOrPromise;

    const startedAt = performance.now();
    const warnTimer = setTimeout(() => {
        didWarn = true;
        console.warn(`⚠️ ${operation} is taking longer than ${timeoutMs}ms — still waiting...`);
    }, timeoutMs);
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    try {
        const result = await Promise.race([
            Promise.resolve(query),
            new Promise<never>((_, reject) => {
                hardTimer = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`${operation}: timeout after ${hardLimit}ms. Revisa tu conexión.`));
                }, hardLimit);
            })
        ]);
        emitQueryTrace(operation, startedAt, result);
        return result as Awaited<T>;
    } catch (error) {
        emitQueryTrace(operation, startedAt, undefined, error);
        throw error;
    } finally {
        clearTimeout(warnTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (didWarn) console.log(`✅ ${operation} completed (was slow but succeeded)`);
    }
};

export const removeUndefined = (obj: Record<string, any>) => {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) result[key] = value;
    }
    return result;
};

export const extractTime = (value: string | null | undefined): string => {
    if (!value) return '00:00';
    if (/^\d{2}:\d{2}$/.test(value)) return value;
    if (value.includes('T')) {
        const timePart = value.split('T')[1];
        if (timePart) return timePart.substring(0, 5);
    }
    return value.substring(0, 5);
};

export const normalizeForMatch = (str: string): string => {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
};

export const buildStudentPayload = (student: Partial<Student>) => {
    const fullName = student.name ? [student.name, student.surname].filter(Boolean).join(' ') : undefined;
    const payload: Record<string, any> = {};
    if (student.name !== undefined) payload.name = student.name;
    if (fullName !== undefined) payload.full_name = fullName;
    if (student.surname !== undefined) payload.surname = student.surname || null;
    if (student.email !== undefined) payload.email = student.email || null;
    if (student.phone !== undefined) payload.phone = student.phone || null;
    if (student.phoneCountry !== undefined) payload.phone_country = student.phoneCountry || null;
    if (student.birthDay !== undefined) payload.birth_day = student.birthDay ? Number(student.birthDay) : null;
    if (student.birthMonth !== undefined) payload.birth_month = student.birthMonth ? Number(student.birthMonth) : null;
    if (student.birthYear !== undefined) payload.birth_year = student.birthYear ? Number(student.birthYear) : null;
    if (student.classesRemaining !== undefined) payload.classes_remaining = student.classesRemaining;
    if (student.status !== undefined) payload.status = student.status;
    if (student.paymentStatus !== undefined) payload.payment_status = student.paymentStatus;
    if (student.paymentMethod !== undefined) payload.payment_method = student.paymentMethod || null;
    if (student.notes !== undefined) payload.notes = student.notes || null;
    if (student.observations !== undefined) payload.observations = student.observations || null;
    if (student.price !== undefined) payload.price = student.price ?? null;
    if (student.classType !== undefined) payload.class_type = student.classType || null;
    if (student.expiryDate !== undefined) payload.expiry_date = student.expiryDate || null;
    if (student.studentCategory !== undefined) payload.student_category = student.studentCategory || 'membresia';
    if (student.membershipTier !== undefined) payload.membership_tier = student.membershipTier || null;
    if (student.membershipActivatedAt !== undefined) payload.membership_activated_at = student.membershipActivatedAt || null;
    if (student.archivedAt !== undefined) payload.archived_at = student.archivedAt || null;
    if (student.groupName !== undefined) payload.group_name = student.groupName || null;
    if (student.bonosAsignados !== undefined) payload.bonos_asignados = student.bonosAsignados;
    if (student.repetirMensualmente !== undefined) payload.repetir_mensualmente = student.repetirMensualmente;
    if (student.studentCategory === 'temporal') {
        payload.membership_tier = null;
        payload.membership_activated_at = null;
        payload.repetir_mensualmente = false;
    }
    return payload;
};

export const buildSessionPayload = (data: Partial<ClassSession>) => {
    let startTimestamp: string | undefined;
    let endTimestamp: string | undefined;
    if (data.date && data.startTime) startTimestamp = `${data.date}T${data.startTime}:00`;
    if (data.date && data.endTime) endTimestamp = `${data.date}T${data.endTime}:00`;
    const payload: Record<string, any> = {};
    if (data.date !== undefined) payload.date = data.date;
    if (data.startTime !== undefined || startTimestamp) payload.start_time = startTimestamp ?? data.startTime;
    if (data.endTime !== undefined || endTimestamp) payload.end_time = endTimestamp ?? data.endTime;
    if (data.classType !== undefined) payload.class_type = data.classType;
    if (data.capacity !== undefined) payload.capacity = data.capacity;
    if (data.teacherId !== undefined) payload.teacher_id = data.teacherId || null;
    if (data.teacherSubstituteId !== undefined) payload.teacher_substitute_id = data.teacherSubstituteId || null;
    if (data.completedAt !== undefined) payload.completed_at = data.completedAt || null;
    if (data.workshopName !== undefined) payload.workshop_name = data.workshopName || null;
    if (data.privateReason !== undefined) payload.private_reason = data.privateReason || null;
    if (data.sessionAudience !== undefined) payload.session_audience = data.sessionAudience || null;
    return payload;
};

export const mapGiftCardRowToModel = (row: any): GiftCard => {
    const sessionsUsed = Math.max(0, Number(row.sessions_used ?? 0));
    const numClasses = Math.max(0, Number(row.num_classes ?? 0));
    const expiryDate = row.expiry_date || undefined;
    const today = new Date().toISOString().split('T')[0];
    const status = row.status || (
        row.payment_status === 'pending' ? 'pending' :
            sessionsUsed >= numClasses ? 'exhausted' :
                expiryDate && expiryDate < today ? 'expired' : 'active'
    );
    return {
        id: row.id,
        sedeId: row.sede_id ?? undefined,
        code: row.code || `CR-${String(row.id).replace(/-/g, '').slice(0, 10).toUpperCase()}`,
        buyer: row.buyer || '',
        buyerPhone: row.buyer_phone || undefined,
        buyerEmail: row.buyer_email || undefined,
        recipient: row.recipient || '',
        recipientEmail: row.recipient_email || undefined,
        recipientStudentId: row.recipient_student_id || undefined,
        numClasses,
        type: row.type === 'torno' ? 'torno' : 'modelado',
        validityMonths: [3, 6, 8].includes(Number(row.validity_months)) ? Number(row.validity_months) as 3 | 6 | 8 : undefined,
        activatedAt: row.activated_at || undefined,
        issuedDate: row.scheduled_date || undefined,
        expiryDate,
        price: row.price ?? undefined,
        paymentStatus: row.payment_status ?? null,
        status,
        sessionsUsed,
        sessionsRemaining: Math.max(0, numClasses - sessionsUsed),
        consumedAt: row.consumed_at || undefined,
        deliveryFormat: row.delivery_format === 'physical' ? 'physical' : 'digital',
        dedication: row.dedication || undefined,
        createdAt: row.created_at,
        extraCommentary: row.internal_notes || row.extra_commentary || undefined
    };
};

// Shared context passed to all operation modules
export interface OpsContext {
    assertScope: () => void;
    sedeId: string | null;
    isSuperAdmin: boolean;
    operationLockRef: React.MutableRefObject<boolean>;
    students: Student[];
    sessions: ClassSession[];
    capacityDefaults: WorkshopCapacityDefault[];
    giftCards: any[];
    pieces: any[];
    setStudents: React.Dispatch<React.SetStateAction<Student[]>>;
    setSessions: React.Dispatch<React.SetStateAction<ClassSession[]>>;
    setTeachers: React.Dispatch<React.SetStateAction<any[]>>;
    setPieces: React.Dispatch<React.SetStateAction<any[]>>;
    setGiftCards: React.Dispatch<React.SetStateAction<any[]>>;
    setInventoryItems: React.Dispatch<React.SetStateAction<any[]>>;
    setInventoryMovements: React.Dispatch<React.SetStateAction<any[]>>;
    safeReload: () => Promise<void>;
}
