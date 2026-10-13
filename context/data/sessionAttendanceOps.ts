import type { ClassSession, Student, SessionBusinessIntent } from '../../types';

export type AttendanceStatus = 'present' | 'absent' | 'pending';
export type RevisionedSession = ClassSession & { revision?: number };
export type SessionUpdates = Partial<RevisionedSession>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface SessionIntent {
    readonly operation: 'attendance' | 'reservation' | SessionBusinessIntent['operation'];
    readonly sessionId: string;
    readonly requestKey: string;
    readonly input: string;
    readonly args: Readonly<Record<string, any>>;
}

const canonical = (value: any): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

const freeze = <T,>(value: T): T => {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
    }
    return value;
};

export class SessionIntentStore {
    private fallback = new Map<string, string>();
    constructor(private storage?: StorageLike) {
        if (!storage && typeof window !== 'undefined') this.storage = window.sessionStorage;
    }
    get(key: string): SessionIntent | null {
        const value = this.storage ? this.storage.getItem(`atomic-session-intent:${key}`) : this.fallback.get(key);
        return value ? freeze(JSON.parse(value)) : null;
    }
    set(key: string, intent: SessionIntent) {
        const value = JSON.stringify(intent);
        if (this.storage) this.storage.setItem(`atomic-session-intent:${key}`, value);
        else this.fallback.set(key, value);
    }
    clear(key: string) {
        if (this.storage) this.storage.removeItem(`atomic-session-intent:${key}`);
        else this.fallback.delete(key);
    }
}

const fullName = (student: Student) => `${student.name} ${student.surname || ''}`.trim().toUpperCase();

// Only reservation compatibility may resolve names against people. Attendance
// requires persisted roster IDs, and never uses display order as an identity.
export const resolveSessionStudentIds = (students: Student[], names: string[], ids?: string[]): string[] => {
    const resolved = ids ?? names.map(name => {
        const matches = students.filter(student => fullName(student) === name.trim().toUpperCase());
        if (matches.length !== 1) throw new Error('Nombre de alumno ambiguo o desconocido. Selecciona su ID.');
        return matches[0].id;
    });
    if (new Set(resolved).size !== resolved.length || resolved.some(id => !id)) throw new Error('IDs de alumnos duplicados o vacios.');
    return [...resolved].sort();
};

export const attendanceInput = (updates: SessionUpdates) => canonical({
    attendanceByStudentId: updates.attendanceByStudentId,
    attendance: updates.attendance,
    finalize: updates.completedAt === undefined ? undefined : Boolean(updates.completedAt),
    teacherSubstituteId: updates.teacherSubstituteId
});

export const requireSessionRevision = (session: RevisionedSession, revision = session.revision) => {
    if (!Number.isSafeInteger(revision) || revision! < 0) throw new Error('Recarga la sesion para obtener su revision antes de guardar.');
    return revision!;
};

export const createSessionAttendanceIntent = (
    session: RevisionedSession, students: Student[], updates: SessionUpdates, requestKey: string = crypto.randomUUID()
): SessionIntent => {
    if (!session.studentIds) throw new Error('La asistencia requiere el roster persistido por ID. Recarga la sesion.');
    if (session.attendancePolicyVersion !== 2 && Object.keys(session.manualCreditIdByStudentId || {}).length) {
        throw new Error('El credito manual requiere una sesion con politica 2.');
    }
    const ids = resolveSessionStudentIds(students, [], session.studentIds);
    const byId: Record<string, AttendanceStatus> = Object.fromEntries(ids.map(id => [id, 'pending']));
    const merge = (values: Record<string, string> | undefined, namesAllowed: boolean) => {
        for (const [key, status] of Object.entries(values || {})) {
            let id = key;
            if (!ids.includes(id) && namesAllowed) {
                const matches = students.filter(student => ids.includes(student.id) && fullName(student) === key.trim().toUpperCase());
                if (matches.length !== 1) throw new Error('Asistencia por nombre ambigua o desconocida. Usa IDs.');
                id = matches[0].id;
            }
            if (!ids.includes(id)) throw new Error('La asistencia contiene un ID fuera del roster.');
            if (!['present', 'absent', 'pending'].includes(status)) throw new Error('Estado de asistencia invalido.');
            byId[id] = status as AttendanceStatus;
        }
    };
    // ID projections are authoritative; old names are accepted only when unique.
    if (session.attendanceByStudentId) merge(session.attendanceByStudentId, false);
    else merge(session.attendance, true);
    if (updates.attendance && updates.attendanceByStudentId) throw new Error('No combines asistencia por nombre y por ID.');
    merge(updates.attendanceByStudentId ?? updates.attendance, !updates.attendanceByStudentId);
    const finalize = updates.completedAt === undefined ? Boolean(session.completedAt) : Boolean(updates.completedAt);
    if (finalize && ids.some(id => byId[id] === 'pending'
        && !(session.attendancePolicyVersion === 2 && session.businessStateByStudentId?.[id]?.reservationState === 'cancelled'))) {
        throw new Error('Completa la asistencia de todos los IDs activos antes de finalizar.');
    }
    return freeze({ operation: 'attendance', sessionId: session.id, requestKey, input: attendanceInput(updates), args: {
        p_session_id: session.id, p_request_key: requestKey,
        p_expected_revision: requireSessionRevision(session, updates.revision ?? session.revision),
        p_attendance: ids.map(student_id => ({ student_id, status: byId[student_id] })),
        p_finalize: finalize,
        p_teacher_substitute_id: updates.teacherSubstituteId === undefined ? session.teacherSubstituteId || null : updates.teacherSubstituteId || null
    } });
};

export const createSessionReservationIntent = (
    sessionId: string, expectedRevision: number, sedeId: string, metadata: Record<string, unknown>,
    studentIds: string[], giftCardIds: Record<string, string>, input: string, requestKey: string = crypto.randomUUID(),
    manualCreditIds: Record<string, string> = {}
): SessionIntent => {
    for (const mapping of [giftCardIds, manualCreditIds]) {
        for (const [studentId, sourceId] of Object.entries(mapping)) {
            if (!studentIds.includes(studentId) || typeof sourceId !== 'string' || !sourceId.trim()) {
                throw new Error('La financiacion requiere IDs explicitos del roster y de su fuente.');
            }
        }
    }
    if (Object.keys(manualCreditIds).some(id => Object.hasOwn(giftCardIds, id))) {
        throw new Error('No combines bono regalo y credito manual para el mismo ID.');
    }
    return freeze({ operation: 'reservation', sessionId, requestKey, input, args: {
        p_session_id: sessionId, p_request_key: requestKey, p_expected_revision: expectedRevision,
        p_sede_id: sedeId, p_metadata: { ...metadata }, p_student_ids: [...studentIds].sort(),
        p_gift_card_ids: { ...giftCardIds }, p_manual_credit_ids: { ...manualCreditIds }
    } });
};

export const createSessionBusinessIntent = (intent: SessionBusinessIntent): SessionIntent => {
    if (!['approve_exception', 'cancel_reservation', 'waive_penalty'].includes(intent.operation)
        || !intent.sessionId || !intent.studentId || !intent.requestKey
        || !Number.isSafeInteger(intent.expectedRevision) || intent.expectedRevision < 0
        || typeof intent.reason !== 'string' || !intent.reason.trim() || intent.reason.length > 2000) {
        throw new Error('Operacion, identidades, revision y motivo verificable requeridos.');
    }
    if (intent.operation === 'approve_exception' ? !['membership_override', 'no_credit'].includes(intent.kind || '') : intent.kind !== undefined) {
        throw new Error('Tipo de excepcion incompatible con la operacion.');
    }
    return freeze({ operation: intent.operation, sessionId: intent.sessionId, requestKey: intent.requestKey,
        input: canonical(intent), args: { p_session_id: intent.sessionId, p_student_id: intent.studentId,
            p_request_key: intent.requestKey, p_expected_revision: intent.expectedRevision, p_reason: intent.reason,
            ...(intent.operation === 'approve_exception' ? { p_kind: intent.kind } : {}) } });
};

export const reservationInput = (updates: SessionUpdates) => {
    const { revision: _revision, ...input } = updates;
    return canonical(input);
};

const active = new Set<string>();
export const createSessionOperations = (dependencies: {
    rpc: (name: string, args: Record<string, any>) => PromiseLike<{ data: any; error: any }>;
    refresh: () => Promise<void>;
    store: SessionIntentStore;
}) => ({
    save: async (key: string, input: string, create: () => SessionIntent) => {
        if (active.has(key)) throw new Error('Ya se esta guardando esta sesion.');
        active.add(key);
        try {
            let intent = dependencies.store.get(key);
            if (intent && intent.input !== input) throw new Error('Hay un intento pendiente. Reintenta los mismos datos antes de cambiarlos.');
            if (!intent) {
                intent = create();
                dependencies.store.set(key, intent); // Persist BEFORE the only write.
            }
            const names: Record<SessionIntent['operation'], string> = {
                attendance: 'save_session_attendance', reservation: 'save_session_reservation',
                approve_exception: 'approve_session_exception', cancel_reservation: 'cancel_session_reservation',
                waive_penalty: 'waive_session_penalty'
            };
            if (!Object.hasOwn(names, intent.operation)) throw new Error('Operacion de sesion no permitida.');
            const response = await dependencies.rpc(names[intent.operation], intent.args);
            if (response.error) {
                const code = response.error.code;
                // Clear only after a recognized SQL rejection AND an authoritative reload.
                if (typeof code === 'string' && /^(?:02|03|09|0A|0B|0F|0L|0P|0Z|20|21|22|23|24|25|26|27|28|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|53|54|55|P0)[0-9A-Z]{3}$/.test(code)) {
                    await dependencies.refresh();
                    dependencies.store.clear(key);
                }
                throw Object.assign(new Error(response.error.message || 'No se pudo guardar la sesion.'), { code });
            }
            if (!response.data || response.data.session_id !== intent.sessionId || response.data.request_key !== intent.requestKey
                || !Number.isSafeInteger(response.data.revision)) throw new Error('No se recibio un comprobante valido. Reintenta los mismos datos.');
            // Even an old replay must reload current state, not apply its snapshot.
            // Keep the intent if reload fails after commit, so retry is observational.
            await dependencies.refresh();
            dependencies.store.clear(key);
            return response.data;
        } finally {
            active.delete(key);
        }
    }
});
