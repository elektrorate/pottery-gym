import type { ManualCreditIntent, PenaltySettlementIntent, SessionBusinessIntent, PendingStudentCreditOperation } from '../../types';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Operation = PendingStudentCreditOperation['operation'];
type StoredIntent = {
    readonly actorId: string;
    readonly operation: Operation;
    readonly descriptor: PendingStudentCreditOperation;
    readonly args: Readonly<Record<string, any>>;
};

const rpcNames: Record<Operation, string> = {
    approve_manual: 'approve_student_manual_credit',
    settle_penalty: 'settle_student_penalty',
    waive_penalty: 'waive_session_penalty'
};
const approvalFields = ['studentId', 'requestKey', 'mode', 'quantity', 'expectedLegacyBalance', 'activity', 'startsOn', 'endsOn', 'reason', 'evidence'];
const settlementFields = ['penaltyId', 'studentId', 'requestKey', 'expectedRevision', 'reason'];
const waiverFields = ['operation', 'sessionId', 'studentId', 'requestKey', 'expectedRevision', 'reason'];
const postgresIntMax = 2147483647;
const validId = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const validInteger = (value: unknown): value is number => Number.isSafeInteger(value)
    && (value as number) >= -2147483648 && (value as number) <= postgresIntMax;
const validText = (value: unknown, max: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const validDate = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const requireFields = (value: unknown, fields: string[]): Record<string, any> => {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error('Intento de credito invalido.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
        throw new Error('Campos de credito no permitidos o incompletos.');
    }
    return value as Record<string, any>;
};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const namespace = (actorId: string, studentId: string) => {
    if (!validId(actorId) || !validId(studentId)) throw new Error('IDs de actor y alumno requeridos.');
    return `student-credit-intent:${JSON.stringify([actorId, studentId])}`;
};

const validateStoredIntent = (value: unknown, actorId: string, studentId: string): StoredIntent => {
    const intent = requireFields(value, ['actorId', 'operation', 'descriptor', 'args']);
    if (intent.actorId !== actorId || typeof intent.operation !== 'string' || !Object.hasOwn(rpcNames, intent.operation)) {
        throw new Error('Operacion o actor de credito invalido.');
    }
    const operation = intent.operation as Operation;
    const descriptor = requireFields(intent.descriptor, ['operation', 'studentId', 'requestKey', 'reason',
        ...(operation === 'approve_manual' ? [] : ['penaltyId', 'sessionId'])]);
    if (descriptor.operation !== operation || descriptor.studentId !== studentId || !validId(descriptor.requestKey)
        || !validText(descriptor.reason, 2000)
        || (operation !== 'approve_manual' && (!validId(descriptor.penaltyId) || !validId(descriptor.sessionId)))) {
        throw new Error('Identidades o motivo del intento de credito invalidos.');
    }
    const args = requireFields(intent.args, operation === 'approve_manual'
        ? ['p_student_id', 'p_request_key', 'p_mode', 'p_quantity', 'p_expected_legacy_balance', 'p_activity', 'p_starts_on', 'p_ends_on', 'p_reason', 'p_evidence']
        : operation === 'settle_penalty' ? ['p_penalty_id', 'p_request_key', 'p_expected_revision', 'p_reason']
            : ['p_session_id', 'p_student_id', 'p_request_key', 'p_expected_revision', 'p_reason']);
    if (args.p_request_key !== descriptor.requestKey || args.p_reason !== descriptor.reason) {
        throw new Error('El intento de credito no coincide con sus argumentos.');
    }
    if (operation === 'approve_manual') {
        if (args.p_student_id !== studentId || !['new_manual', 'reconcile_legacy'].includes(args.p_mode)
            || !validInteger(args.p_quantity) || args.p_quantity <= 0
            || (args.p_expected_legacy_balance !== null && !validInteger(args.p_expected_legacy_balance))
            || (args.p_mode === 'reconcile_legacy' && (args.p_expected_legacy_balance === null
                || args.p_expected_legacy_balance <= 0 || args.p_quantity !== args.p_expected_legacy_balance))
            || !['mesa', 'torno', 'coworking', 'workshop', 'privada'].includes(args.p_activity)
            || !validDate(args.p_starts_on) || !validDate(args.p_ends_on) || args.p_ends_on < args.p_starts_on
            || !validText(args.p_evidence, 10000)) throw new Error('Datos del credito manual invalidos.');
    } else if (!validRevision(args.p_expected_revision)
        || (operation === 'settle_penalty' ? args.p_penalty_id !== descriptor.penaltyId
            : args.p_session_id !== descriptor.sessionId || args.p_student_id !== studentId)) {
        throw new Error('Identidades o revision de la penalizacion invalidas.');
    }
    return Object.freeze({ actorId, operation,
        descriptor: Object.freeze({ ...descriptor }) as PendingStudentCreditOperation,
        args: Object.freeze({ ...args }) });
};

export class StudentCreditIntentStore {
    private fallback = new Map<string, string>();
    constructor(private storage?: StorageLike) {
        if (!storage && typeof window !== 'undefined') this.storage = window.sessionStorage;
    }
    get(actorId: string, studentId: string): StoredIntent | null {
        const key = namespace(actorId, studentId);
        const value = this.storage ? this.storage.getItem(key) : this.fallback.get(key) ?? null;
        if (value === null) return null;
        let parsed: unknown;
        try { parsed = JSON.parse(value); }
        catch { throw new Error('Intento de credito almacenado corrupto.'); }
        return validateStoredIntent(parsed, actorId, studentId);
    }
    set(actorId: string, studentId: string, value: StoredIntent) {
        const key = namespace(actorId, studentId);
        const intent = validateStoredIntent(value, actorId, studentId);
        const stored = this.get(actorId, studentId);
        if (stored && canonical(stored) !== canonical(intent)) throw new Error('Hay un intento pendiente. Reintenta los datos originales.');
        if (stored) return;
        const serialized = canonical(intent);
        if (this.storage) this.storage.setItem(key, serialized);
        else this.fallback.set(key, serialized);
        if (canonical(this.get(actorId, studentId)) !== serialized) throw new Error('No se pudo persistir el intento de credito.');
    }
    clear(actorId: string, studentId: string) {
        const key = namespace(actorId, studentId);
        if (this.storage) this.storage.removeItem(key);
        else this.fallback.delete(key);
    }
}

const active = new Set<string>();
export const createStudentCreditOperations = ({ rpc, refresh, store, actorId }: {
    rpc: (name: string, args: Record<string, any>) => PromiseLike<{ data: any; error: any }>;
    refresh: () => Promise<void>;
    store: StudentCreditIntentStore;
    actorId: string;
}) => {
    if (!validId(actorId)) throw new Error('ID de actor requerido.');
    const createIntent = (operation: Operation, value: unknown, relatedId?: string): StoredIntent => {
        const input = requireFields(value, operation === 'approve_manual' ? approvalFields
            : operation === 'settle_penalty' ? settlementFields : waiverFields);
        namespace(actorId, input.studentId);
        if (operation !== 'approve_manual' && (!validId(relatedId)
            || (operation === 'waive_penalty' && input.operation !== 'waive_penalty'))) {
            throw new Error('Operacion o identidad de penalizacion invalida.');
        }
        return validateStoredIntent({ actorId, operation, descriptor: {
            operation, studentId: input.studentId, requestKey: input.requestKey, reason: input.reason,
            ...(operation === 'settle_penalty' ? { penaltyId: input.penaltyId, sessionId: relatedId }
                : operation === 'waive_penalty' ? { penaltyId: relatedId, sessionId: input.sessionId } : {})
        }, args: operation === 'approve_manual' ? {
            p_student_id: input.studentId, p_request_key: input.requestKey, p_mode: input.mode, p_quantity: input.quantity,
            p_expected_legacy_balance: input.expectedLegacyBalance, p_activity: input.activity,
            p_starts_on: input.startsOn, p_ends_on: input.endsOn, p_reason: input.reason, p_evidence: input.evidence
        } : operation === 'settle_penalty' ? {
            p_penalty_id: input.penaltyId, p_request_key: input.requestKey, p_expected_revision: input.expectedRevision, p_reason: input.reason
        } : {
            p_session_id: input.sessionId, p_student_id: input.studentId, p_request_key: input.requestKey,
            p_expected_revision: input.expectedRevision, p_reason: input.reason
        } }, actorId, input.studentId);
    };
    const execute = async (studentId: string, proposed?: StoredIntent): Promise<any> => {
        const key = namespace(actorId, studentId);
        if (active.has(key)) throw new Error('Ya se esta guardando una operacion de este alumno.');
        active.add(key);
        try {
            let intent = store.get(actorId, studentId);
            if (intent && proposed && canonical(intent) !== canonical(proposed)) {
                throw new Error('Hay un intento pendiente. Reintenta los datos originales.');
            }
            if (!intent) {
                if (!proposed) throw new Error('No hay un intento de credito pendiente.');
                store.set(actorId, studentId, proposed); // Persist BEFORE the only write.
                intent = store.get(actorId, studentId);
                if (!intent) throw new Error('No se pudo recuperar el intento de credito persistido.');
            }
            let response: { data: any; error: any };
            try { response = await rpc(rpcNames[intent.operation], intent.args); }
            catch (error) { response = { data: null, error }; }
            if (response?.error) {
                const code = response.error.code;
                // Only recognized SQL rejection classes prove rollback, not transport or server shutdown.
                if (typeof code === 'string' && /^(?:02|03|09|0A|0B|0F|0L|0P|0Z|20|21|22|23|24|25|26|27|28|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|53|54|55|P0)[0-9A-Z]{3}$/.test(code)) {
                    await refresh();
                    store.clear(actorId, studentId);
                }
                throw Object.assign(new Error(response.error.message || 'No se pudo guardar la operacion de credito.'), { code });
            }
            const data = response?.data;
            const descriptor = intent.descriptor;
            if (!data || typeof data !== 'object' || Array.isArray(data) || data.student_id !== studentId
                || data.request_key !== descriptor.requestKey
                || (intent.operation === 'approve_manual' ? !validId(data.entitlement_id)
                    || !validInteger(data.remaining_classes) || data.remaining_classes < 0
                    : data.session_id !== descriptor.sessionId || !validRevision(data.revision)
                        || (intent.operation === 'settle_penalty' && (data.penalty_id !== descriptor.penaltyId || !validId(data.settlement_id))))) {
                throw new Error('No se recibio un comprobante valido. Reintenta los datos originales.');
            }
            // Receipts are historical snapshots; reload authoritative state even on replay.
            await refresh();
            store.clear(actorId, studentId);
            return data;
        } finally {
            active.delete(key);
        }
    };
    return {
        approve: async (intent: ManualCreditIntent) => execute(intent.studentId, createIntent('approve_manual', intent)),
        settle: async (intent: PenaltySettlementIntent, sessionId: string) => execute(intent.studentId, createIntent('settle_penalty', intent, sessionId)),
        waive: async (intent: SessionBusinessIntent, penaltyId: string) => execute(intent.studentId, createIntent('waive_penalty', intent, penaltyId)),
        getPending: (studentId: string): PendingStudentCreditOperation | null => store.get(actorId, studentId)?.descriptor ?? null,
        retry: (studentId: string): Promise<any> => execute(studentId)
    };
};
