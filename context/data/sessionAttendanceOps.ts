import type { ClassSession, Student } from '../../types';

export type AttendanceStatus = 'present' | 'absent' | 'pending';
export type RevisionedSession = ClassSession & { revision?: number };
export type SessionUpdates = Partial<RevisionedSession>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface SessionIntent {
    readonly operation: 'attendance' | 'reservation';
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
    if (finalize && Object.values(byId).includes('pending')) throw new Error('Completa la asistencia de todos los IDs antes de finalizar.');
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
    studentIds: string[], giftCardIds: Record<string, string>, input: string, requestKey: string = crypto.randomUUID()
): SessionIntent => freeze({ operation: 'reservation', sessionId, requestKey, input, args: {
    p_session_id: sessionId, p_request_key: requestKey, p_expected_revision: expectedRevision,
    p_sede_id: sedeId, p_metadata: { ...metadata }, p_student_ids: [...studentIds].sort(), p_gift_card_ids: { ...giftCardIds }
} });

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
            const response = await dependencies.rpc(`save_session_${intent.operation}`, intent.args);
            if (response.error) {
                const code = response.error.code;
                // A SQL rejection proves rollback. Transport errors do not.
                if (/^[0-9A-Z]{5}$/.test(code || '') && !['08000', '08003', '08006', '57014'].includes(code)) {
                    dependencies.store.clear(key);
                }
                if (code === '40001') await dependencies.refresh();
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
