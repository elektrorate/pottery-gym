import { MEMBERSHIP_PLANS } from '../../types';
import type { Student, MembershipTier, RenewalIntent, ClassAdjustmentIntent } from '../../types';
import { isManagedMembership } from '../../utils/studentLifecycle';

export interface MembershipDependencies {
    rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
    refresh: () => Promise<void>;
}

export const createRenewalIntent = (studentId: string, tier: MembershipTier): RenewalIntent =>
    Object.freeze({ studentId, membershipTier: tier, allocatedClasses: MEMBERSHIP_PLANS[tier].bonuses, requestKey: crypto.randomUUID() });

export const createClassAdjustmentIntent = (student: Student, delta: number): ClassAdjustmentIntent => {
    if (!isManagedMembership(student) || !student.effectivePeriodId) {
        throw new Error('Inicializa explícitamente el período de membresía antes de ajustar clases.');
    }
    return Object.freeze({ studentId: student.id, periodId: student.effectivePeriodId,
        expectedBalance: student.classesRemaining, delta, requestKey: crypto.randomUUID() });
};

// Callers retain these immutable intents on uncertain failures; no automatic retargeting.
export const createMembershipOperations = ({ rpc, refresh }: MembershipDependencies) => {
    const mutate = async (name: string, args: Record<string, unknown>) => {
        const result = await rpc(name, args);
        if (result.error) {
            if (result.error.code === '40001') {
                await refresh();
                throw Object.assign(new Error('El período o saldo cambió. Revisa los datos y crea un nuevo ajuste.'), { code: '40001' });
            }
            throw Object.assign(new Error(result.error.message || 'La operación de membresía falló.'), { code: result.error.code });
        }
        if (!result.data) throw new Error('El servidor no devolvió el resultado de membresía.');
        // A historical receipt never overwrites the current effective balance.
        await refresh();
        return result.data;
    };
    return {
        renew: (intent: RenewalIntent) => mutate('schedule_student_membership', {
            student_id: intent.studentId, request_key: intent.requestKey,
            membership_tier: intent.membershipTier, allocated_classes: intent.allocatedClasses
        }),
        activate: (studentId: string) => mutate('activate_student_membership', { student_id: studentId }),
        confirm: (periodId: string) => mutate('confirm_student_membership_payment', { period_id: periodId }),
        adjust: (intent: ClassAdjustmentIntent) => mutate('adjust_student_membership_classes', {
            student_id: intent.studentId, period_id: intent.periodId, request_key: intent.requestKey,
            expected_balance: intent.expectedBalance, delta: intent.delta
        })
    };
};

export class PendingMembershipIntentStore {
    private fallback = new Map<string, string>();
    constructor(private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
        if (!storage && typeof window !== 'undefined') this.storage = window.sessionStorage;
    }
    get<T>(key: string): T | null {
        const value = this.storage ? this.storage.getItem(`membership-intent:${key}`) : this.fallback.get(key);
        return value ? Object.freeze(JSON.parse(value)) as T : null;
    }
    set(key: string, value: RenewalIntent | ClassAdjustmentIntent) {
        const serialized = JSON.stringify(value);
        if (this.storage) this.storage.setItem(`membership-intent:${key}`, serialized);
        else this.fallback.set(key, serialized);
    }
    clear(key: string) {
        if (this.storage) this.storage.removeItem(`membership-intent:${key}`);
        else this.fallback.delete(key);
    }
}

const activeAttendanceMutations = new Set<string>();
export const persistAttendanceAfterAdjustments = async (
    adjust: () => Promise<void>, persistSession: () => Promise<void>, sessionId?: string
) => {
    if (sessionId && activeAttendanceMutations.has(sessionId)) throw new Error('Ya se está guardando esta asistencia.');
    if (sessionId) activeAttendanceMutations.add(sessionId);
    try {
        await adjust();
        await persistSession();
    } finally {
        if (sessionId) activeAttendanceMutations.delete(sessionId);
    }
};

// Retained until session persistence succeeds, so partial batches replay original receipts.
export class AttendanceMembershipIntents {
    private intents = new Map<string, ClassAdjustmentIntent>();
    private conflicted = new Set<string>();
    private batches = new Map<string, string>();
    constructor(private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
        if (!storage && typeof window !== 'undefined') this.storage = window.sessionStorage;
    }
    private read() {
        const saved = this.storage?.getItem('membership-attendance-intents-v1');
        if (saved) {
            const state = JSON.parse(saved);
            this.intents = new Map(state.intents);
            this.conflicted = new Set(state.conflicted);
            this.batches = new Map(state.batches || []);
        } else if (this.storage) {
            this.intents.clear(); this.conflicted.clear(); this.batches.clear();
        }
    }
    private persist() {
        this.storage?.setItem('membership-attendance-intents-v1', JSON.stringify({
            intents: [...this.intents], conflicted: [...this.conflicted], batches: [...this.batches]
        }));
    }
    begin(sessionId: string, attendance: Record<string, unknown>) {
        this.read();
        const target = JSON.stringify(Object.entries(attendance).sort(([a], [b]) => a.localeCompare(b)));
        const existing = this.batches.get(sessionId);
        if (existing && existing !== target) throw new Error('Hay un guardado parcial. Reintenta la asistencia original antes de cambiarla.');
        this.batches.set(sessionId, target);
        this.persist();
    }
    get(sessionId: string, student: Student, delta: number, sessionDate: string): ClassAdjustmentIntent {
        this.read();
        const key = `${sessionId}:${student.id}:${delta}`;
        if (this.conflicted.has(key)) throw new Error('Ajuste obsoleto: revisa la asistencia antes de iniciar un nuevo intento.');
        const existing = this.intents.get(key);
        if (existing) return Object.freeze(existing);
        // Attendance has no durable period link. Never guess a historical credit.
        if (!student.membershipActivatedAt || !student.expiryDate ||
            sessionDate < student.membershipActivatedAt.slice(0, 10) || sessionDate > student.expiryDate.slice(0, 10)) {
            throw new Error('Asistencia de otro período o sin fechas: no se puede ajustar el saldo automáticamente.');
        }
        if (delta > 0) throw new Error('La asistencia histórica no tiene vínculo de período. Revisa y usa un ajuste explícito de clases.');
        const intent = createClassAdjustmentIntent(student, delta);
        this.intents.set(key, intent);
        this.persist();
        return intent;
    }
    reviewConflicts(sessionId: string) {
        this.read();
        for (const key of this.conflicted) {
            if (key.startsWith(`${sessionId}:`)) {
                this.conflicted.delete(key);
                this.intents.delete(key);
            }
        }
        this.persist();
    }
    releaseUnattempted(sessionId: string) {
        this.read();
        if (![...this.intents.keys()].some(key => key.startsWith(`${sessionId}:`))) {
            this.batches.delete(sessionId);
            this.persist();
        }
    }
    conflict(sessionId: string, studentId: string, delta: number) {
        this.read();
        this.conflicted.add(`${sessionId}:${studentId}:${delta}`);
        this.persist();
    }
    complete(sessionId: string) {
        this.read();
        for (const key of this.intents.keys()) if (key.startsWith(`${sessionId}:`)) this.intents.delete(key);
        this.batches.delete(sessionId);
        this.persist();
    }
}
