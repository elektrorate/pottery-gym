import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from './AuthContext';
import {
    Student, ClassSession, CeramicPiece, GiftCard, GiftCardMovement,
    InventoryItem, InventoryMovement, Teacher, MembershipTier, RenewalIntent, ClassAdjustmentIntent, SessionBusinessIntent, PendingSessionOperation,
    ManualCreditIntent, PenaltySettlementIntent, PendingStudentCreditOperation,
    WorkshopScheduleDay, WorkshopScheduleException, WorkshopCapacityDefault, CapacityActivity,
    DEFAULT_CAPACITY_BY_ACTIVITY, getDefaultSessionCapacity
} from '../types';
import { showError } from './toast';

// Import modular operations
import { extractTime, withTimeout, traceSupabaseQuery, RELOAD_TIMEOUT_MS, OpsContext, mapGiftCardRowToModel, mapStudentRowToModel, joinStudentMemberships } from './data/shared';
import { createMembershipOperations } from './data/membershipOps';
import { createStudentCreditOperations, StudentCreditIntentStore } from './data/studentCreditOps';
import { readAllRows } from './data/readAllRows';
import * as studentOps from './data/studentOps';
import * as sessionOps from './data/sessionOps';
import * as teacherOps from './data/teacherOps';
import * as pieceOps from './data/pieceOps';
import * as giftCardOps from './data/giftCardOps';
import * as inventoryOps from './data/inventoryOps';
import { attachAttendanceHistory } from '../utils/attendanceHistory';
import { attachSessionBusinessState } from '../utils/sessionBusiness';
import { attachStudentCreditProfiles } from '../utils/studentCredits';
import { getWorkshopDate } from '../utils/studentLifecycle';

const normalizeAttendanceStatus = (value: unknown): 'present' | 'absent' | undefined => {
    const status = String(value || '').trim().toLowerCase();
    if (status === 'present' || status === 'presente' || status === 'asiste') return 'present';
    if (status === 'absent' || status === 'ausente' || status === 'falta' || status === 'no asiste') return 'absent';
    return undefined;
};

interface DataContextType {
    // Data
    students: Student[];
    sessions: ClassSession[];
    pieces: CeramicPiece[];
    giftCards: GiftCard[];
    inventoryItems: InventoryItem[];
    inventoryMovements: InventoryMovement[];
    teachers: Teacher[];
    workshopSchedule: WorkshopScheduleDay[];
    workshopScheduleExceptions: WorkshopScheduleException[];
    capacityDefaults: WorkshopCapacityDefault[];
    isLoadingData: boolean;
    businessDataReady: boolean;
    loadError: string | null;

    // Student CRUD
    addStudent: (student: Omit<Student, 'id'>) => Promise<void>;
    updateStudent: (id: string, updates: Partial<Student>) => Promise<void>;
    deleteStudent: (id: string) => Promise<void>;
    renewStudent: (intent: RenewalIntent) => Promise<void>;
    confirmMembershipPayment: (studentId: string, periodId: string) => Promise<void>;
    activateMembership: (studentId: string) => Promise<void>;
    initializeLegacyMemberships: () => Promise<{ initialized: number; failed: number }>;
    adjustMembershipClasses: (intent: ClassAdjustmentIntent) => Promise<void>;
    approveStudentManualCredit: (intent: ManualCreditIntent) => Promise<void>;
    settlePendingStudentPenalty: (intent: PenaltySettlementIntent) => Promise<void>;
    waiveStudentPenalty: (intent: SessionBusinessIntent) => Promise<void>;
    canManageStudentCredits: (student: Student) => boolean;
    getPendingStudentCreditOperation: (studentId: string) => PendingStudentCreditOperation | null;
    retryPendingStudentCreditOperation: (studentId: string) => Promise<void>;

    // Session CRUD
    addSession: (session: Omit<ClassSession, 'id'>) => Promise<void>;
    updateSession: (id: string, updates: Partial<ClassSession>) => Promise<boolean>;
    deleteSession: (id: string) => Promise<void>;
    approveSessionException: (intent: SessionBusinessIntent) => Promise<void>;
    cancelSessionReservation: (intent: SessionBusinessIntent) => Promise<void>;
    waiveSessionPenalty: (intent: SessionBusinessIntent) => Promise<void>;
    isCurrentSedeOwner: boolean;
    canWaiveSessionPenalty: (session: ClassSession) => boolean;
    canAdjustMembershipClasses: boolean;
    getPendingSessionOperation: (id?: string) => PendingSessionOperation | null;
    retryPendingSessionOperation: (id?: string) => Promise<void>;

    // Teacher CRUD
    addTeacher: (teacher: Omit<Teacher, 'id'>) => Promise<void>;
    updateTeacher: (id: string, updates: Partial<Teacher>) => Promise<void>;
    deleteTeacher: (id: string) => Promise<void>;

    // Piece CRUD
    addPiece: (piece: Omit<CeramicPiece, 'id'>) => Promise<void>;
    updatePiece: (id: string, updates: Partial<CeramicPiece>) => Promise<void>;
    deletePiece: (id: string) => Promise<void>;

    // GiftCard CRUD
    addGiftCard: (card: Omit<GiftCard, 'id' | 'createdAt'>) => Promise<void>;
    updateGiftCard: (id: string, updates: Partial<GiftCard>) => Promise<void>;
    deleteGiftCard: (id: string) => Promise<void>;
    consumeGiftCard: (giftCardId: string, consumedAt?: string) => Promise<void>;
    cancelGiftCard: (giftCardId: string) => Promise<void>;
    confirmGiftCardPayment: (giftCardId: string) => Promise<void>;
    redeemGiftCardSession: (giftCardId: string, sessionId: string, studentId?: string) => Promise<void>;
    reverseGiftCardSession: (giftCardId: string | undefined, sessionId: string, studentId?: string) => Promise<boolean>;

    // Inventory CRUD
    addInventoryItem: (item: InventoryItem) => Promise<void>;
    updateInventoryItem: (id: string, updates: Partial<InventoryItem>) => Promise<void>;
    archiveInventoryItem: (id: string) => Promise<void>;
    deleteInventoryItem: (id: string) => Promise<void>;
    addInventoryMovement: (movement: Omit<InventoryMovement, 'id'>) => Promise<void>;
    updateWorkshopSchedule: (schedule: WorkshopScheduleDay[]) => Promise<boolean>;
    updateWorkshopScheduleException: (exceptionDate: string, slots: Omit<WorkshopScheduleException, 'id' | 'exceptionDate'>[]) => Promise<boolean>;
    updateCapacityDefault: (classType: CapacityActivity, capacity: number) => Promise<boolean>;

    // Refresh
    loadAllData: () => Promise<void>;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

export const useData = () => {
    const context = useContext(DataContext);
    if (!context) {
        throw new Error('useData must be used within a DataProvider');
    }
    return context;
};

interface DataProviderProps {
    children: ReactNode;
}

export const DataProvider: React.FC<DataProviderProps> = ({ children }) => {
    const { session, sedeId, isSuperAdmin } = useAuth();
    const [students, setStudents] = useState<Student[]>([]);
    const [sessions, setSessions] = useState<ClassSession[]>([]);
    const [pieces, setPieces] = useState<CeramicPiece[]>([]);
    const [giftCards, setGiftCards] = useState<GiftCard[]>([]);
    const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
    const [inventoryMovements, setInventoryMovements] = useState<InventoryMovement[]>([]);
    const [teachers, setTeachers] = useState<Teacher[]>([]);
    const [workshopSchedule, setWorkshopSchedule] = useState<WorkshopScheduleDay[]>([]);
    const [workshopScheduleExceptions, setWorkshopScheduleExceptions] = useState<WorkshopScheduleException[]>([]);
    const [capacityDefaults, setCapacityDefaults] = useState<WorkshopCapacityDefault[]>(
        Object.entries(DEFAULT_CAPACITY_BY_ACTIVITY).map(([classType, capacity]) => ({ classType: classType as CapacityActivity, capacity }))
    );
    const [isLoadingData, setIsLoadingData] = useState(true);
    const [businessDataReady, setBusinessDataReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [ownedSedeIds, setOwnedSedeIds] = useState<string[]>([]);
    const hasLoadedOnceRef = useRef(false);
    const operationLockRef = useRef(false);
    const loadGenerationRef = useRef(0);
    const studentCreditStoreRef = useRef<StudentCreditIntentStore | null>(null);
    const scope = JSON.stringify([session?.user.id ?? null, sedeId, isSuperAdmin]);
    const scopeRef = useRef(scope);
    const scopeVersionRef = useRef(0);
    const ownedSedeIdsRef = useRef<string[]>([]);
    const activeRef = useRef(true);
    const businessReadyRef = useRef(false);
    const [loadedScope, setLoadedScope] = useState(scope);
    const studentsRef = useRef(students);
    const sessionsRef = useRef(sessions);
    const piecesRef = useRef(pieces);
    const giftCardsRef = useRef(giftCards);
    const capacityDefaultsRef = useRef(capacityDefaults);
    if (scopeRef.current !== scope) {
        scopeRef.current = scope;
        ++scopeVersionRef.current;
        ++loadGenerationRef.current;
        businessReadyRef.current = false;
        ownedSedeIdsRef.current = [];
        studentsRef.current = []; sessionsRef.current = []; giftCardsRef.current = []; piecesRef.current = [];
    }
    const scopeVersion = scopeVersionRef.current;
    const requireScope = useCallback(() => {
        if (!session?.user.id || !activeRef.current || scopeRef.current !== scope || scopeVersionRef.current !== scopeVersion) {
            throw new Error('La identidad o la sede activa ha cambiado. Recarga los datos antes de continuar.');
        }
    }, [session?.user.id, scope, scopeVersion]);
    const requireBusinessData = useCallback(() => {
        requireScope();
        if (!businessReadyRef.current) throw new Error('Espera a que se carguen los datos de negocio o recarga los datos antes de guardar.');
    }, [requireScope]);

    // ==================== DATA LOADING ====================
    const loadAllData = useCallback(async () => {
        requireScope();
        const generation = ++loadGenerationRef.current;
        // Removed sedeId guard: RLS on Supabase will filter by get_owned_sede_id()
        // This ensures staff users can load data even before sedeId resolves
        if (!hasLoadedOnceRef.current) setIsLoadingData(true);
        businessReadyRef.current = false;
        setBusinessDataReady(false);
        setLoadError(null);

        try {
            const today = new Date(`${getWorkshopDate()}T00:00:00Z`);
            const calendarStart = new Date(today);
            calendarStart.setUTCDate(calendarStart.getUTCDate() - 62);
            const calendarEnd = new Date(today);
            calendarEnd.setUTCDate(calendarEnd.getUTCDate() + 62);
            const calendarRange = {
                start: calendarStart.toISOString().slice(0, 10),
                end: calendarEnd.toISOString().slice(0, 10)
            };

            const buildQuery = (table: string, limit?: number, range?: { start: string; end: string }, signal?: AbortSignal,
                options: { columns?: string; exactCount?: boolean; studentCategory?: string } = {}) => {
                const activityRoster = table === 'session_activity_block_students';
                const exactCount = options.exactCount !== false;
                const select = () => {
                    // The child has no sede_id; disambiguate its two parent FKs and scope through the parent.
                    let query = supabase.from(table).select(options.columns || (activityRoster
                        ? '*,session_activity_blocks!session_activity_block_students_block_id_fkey!inner(sede_id)'
                        : '*'), exactCount ? { count: 'exact' } : undefined);
                    if (!isSuperAdmin && sedeId) query = query.eq(activityRoster ? 'session_activity_blocks.sede_id' : 'sede_id', sedeId);
                    if (table === 'students' && options.studentCategory) query = query.eq('student_category', options.studentCategory);
                    if (range && table === 'sessions') query = query.gte('date', range.start).lte('date', range.end);
                    return query;
                };
                const execute = (query: ReturnType<typeof select>) => signal
                    ? traceSupabaseQuery(`secondary.${table}.select`, Promise.resolve(query.abortSignal(signal)))
                    : withTimeout(`critical.${table}.select`, query, RELOAD_TIMEOUT_MS);
                if (limit !== undefined) {
                    let query = select();
                    if (table === 'students') query = query.order('name', { ascending: true }).order('surname', { ascending: true });
                    return execute(query.limit(limit));
                }
                const keys = activityRoster ? ['block_id', 'student_id']
                    : table === 'session_business_state' ? ['session_id', 'student_id']
                    : ['students_effective_membership', 'student_credit_profile'].includes(table) ? ['student_id'] : ['id'];
                return readAllRows((offset, size) => {
                    let query = select();
                    for (const key of keys) query = query.order(key, { ascending: true });
                    return execute(query.range(offset, offset + size - 1));
                }, exactCount ? 500 : 1000, { requireExactCount: exactCount });
            };

            // Optional domains must not hold the calendar hostage. They are
            // retried on the next refresh, while the critical roster/session
            // snapshot can render as soon as it is available.
            const optionalQuery = async (table: string) => {
                const controller = new AbortController();
                const fallback = { data: [], error: null };
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    return await Promise.race([
                        buildQuery(table, undefined, undefined, controller.signal),
                        new Promise<typeof fallback>(resolve => {
                            timer = setTimeout(() => { controller.abort(); resolve(fallback); }, 4500);
                        })
                    ]).catch(() => fallback);
                } finally {
                    clearTimeout(timer);
                }
            };

            // Phase 1: only the data required to render the dashboard/calendar.
            // Secondary domains are intentionally loaded below so inventory and
            // gift-card history cannot delay the first useful paint.
            const [studentsRes, teachersRes, sessionsRes, sessionStudentsRes, activityBlocksRes, activityBlockStudentsRes] = await traceSupabaseQuery(
                'phase.critical.snapshot',
                Promise.all([
                    // The first paint only needs a small, predictable page of
                    // membership students. The complete roster is hydrated
                    // by phase 2 for calendars, reports and exports.
                    buildQuery('students', 50, undefined, undefined, { exactCount: false, studentCategory: 'membresia' }),
                    buildQuery('teachers'), buildQuery('sessions', undefined, calendarRange),
                    buildQuery('session_students', undefined, undefined, undefined, {
                        columns: 'session_id,student_id,student_name,attendance,gift_card_id,manual_credit_id',
                        exactCount: false
                    }),
                    buildQuery('session_activity_blocks'), buildQuery('session_activity_block_students')
                ])
            );

            if (generation !== loadGenerationRef.current) throw new Error('Recarga reemplazada por una solicitud más reciente.');
            requireScope();
            if (studentsRes.error) throw studentsRes.error;
            if (teachersRes.error) throw teachersRes.error;
            if (sessionsRes.error) throw sessionsRes.error;
            if (sessionStudentsRes.error) throw sessionStudentsRes.error;
            if (activityBlocksRes.error) throw activityBlocksRes.error;
            if (activityBlockStudentsRes.error) throw activityBlockStudentsRes.error;
            // Membership projections are validated in phase 2. The calendar
            // snapshot only needs the base student identity and roster data.
            const normalizedStudents: Student[] = (studentsRes.data || []).map(mapStudentRowToModel);

            // Normalize session students
            const sessionStudentsMap: Record<string, any[]> = {};
            (sessionStudentsRes.data || []).forEach((row: any) => {
                if (!sessionStudentsMap[row.session_id]) sessionStudentsMap[row.session_id] = [];
                sessionStudentsMap[row.session_id].push(row);
            });
            const activityBlockStudentsMap: Record<string, any[]> = {};
            const activityBlocksById = new Map((activityBlocksRes.data || []).map((row: any) => [row.id, row] as const));
            (activityBlockStudentsRes.data || []).forEach((row: any) => {
                const block = activityBlocksById.get(row.block_id);
                if (!block || block.session_id !== row.session_id || block.sede_id !== row.session_activity_blocks?.sede_id
                    || !sessionStudentsMap[row.session_id]?.some(item => item.student_id === row.student_id)) {
                    throw new Error('El roster de actividades no coincide con el bloque, la sede o el alumno de la sesion. Recarga los datos.');
                }
                (activityBlockStudentsMap[row.block_id] ||= []).push(row);
            });
            const activityBlocksMap: Record<string, any[]> = {};
            (activityBlocksRes.data || []).forEach((row: any) => {
                (activityBlocksMap[row.session_id] ||= []).push(row);
            });

            // Capacity configuration is secondary; use stable defaults for the
            // first calendar render and replace them after the background load.
            const configuredCapacityDefaults = DEFAULT_CAPACITY_BY_ACTIVITY;

            const mapSession = (row: any): ClassSession => {
                const linked = sessionStudentsMap[row.id] || [];
                const attendance: Record<string, 'present' | 'absent'> = {};
                linked.forEach((item: any) => {
                    const status = normalizeAttendanceStatus(item.attendance);
                    if (status && item.student_name) {
                        attendance[item.student_name] = status;
                    }
                });
                const mapped: ClassSession = {
                    id: row.id, date: String(row.date).split('T')[0],
                    sedeId: row.sede_id,
                    attendancePolicyVersion: row.attendance_policy_version,
                    revision: Number.isSafeInteger(Number(row.revision)) && row.revision != null ? Number(row.revision) : undefined,
                    startTime: extractTime(row.start_time), endTime: extractTime(row.end_time),
                    classType: row.class_type,
                    capacity: row.capacity ?? getDefaultSessionCapacity(row.class_type, configuredCapacityDefaults),
                    students: linked.map((item: any) => item.student_name),
                    studentIds: linked.map((item: any) => item.student_id || ''),
                    attendance: Object.keys(attendance).length ? attendance : undefined,
                    attendanceByStudentId: linked.reduce((result: NonNullable<ClassSession['attendanceByStudentId']>, item: any) => {
                        const status = normalizeAttendanceStatus(item.attendance);
                        if (item.student_id) {
                            result[item.student_id] = status || 'pending';
                        }
                        return result;
                    }, {}),
                    giftCardIdByStudentId: linked.reduce((result: Record<string, string>, item: any) => {
                        if (item.student_id && item.gift_card_id) result[item.student_id] = item.gift_card_id;
                        return result;
                    }, {}),
                    manualCreditIdByStudentId: linked.reduce((result: Record<string, string>, item: any) => {
                        if (item.student_id && item.manual_credit_id) result[item.student_id] = item.manual_credit_id;
                        return result;
                    }, {}),
                    teacherId: row.teacher_id || undefined,
                    teacherSubstituteId: row.teacher_substitute_id || undefined,
                    completedAt: row.completed_at || undefined,
                    workshopName: row.workshop_name || undefined,
                    privateReason: row.private_reason || undefined,
                    sessionAudience: row.session_audience || undefined
                };
                mapped.activityBlocks = (activityBlocksMap[row.id] || []).map((block: any) => ({
                    id: block.id,
                    activityType: block.activity_type,
                    teacherId: block.teacher_id || undefined,
                    capacity: Number(block.capacity),
                    studentIds: (activityBlockStudentsMap[block.id] || []).map((item: any) => item.student_id)
                }));
                return mapped;
            };
            const normalizedSessions = (sessionsRes.data || []).map(mapSession);

            const studentsWithAttendance = attachAttendanceHistory(normalizedStudents, normalizedSessions);

            // Publish the critical snapshot now. The calendar no longer waits
            // for inventory/gift-card/schedule tables.
            // Credit projections are loaded in phase 2. The projection helper
            // requires one row per student, so do not call it with an empty
            // placeholder during the critical calendar render.
            setStudents(studentsWithAttendance);

            // Lifecycle is derived from the payment due date. Loading data must
            // never renew unpaid memberships or persist automatic archival.

            setTeachers((teachersRes.data || []) as Teacher[]);
            setSessions(normalizedSessions);
            setOwnedSedeIds([]);
            ownedSedeIdsRef.current = [];
            // Keep the first render independent from secondary domains.
            setLoadError(null);
            setIsLoadingData(false);
            hasLoadedOnceRef.current = true;

            // Optional domains never determine whether a durable intent can be cleared.
            let movementsByGiftCard: Record<string, GiftCardMovement[]> = {};
                void traceSupabaseQuery('phase.secondary.snapshot', Promise.all([
                optionalQuery('pieces'), optionalQuery('gift_card_movements'),
                optionalQuery('inventory_items'), optionalQuery('inventory_movements'),
                optionalQuery('workshop_schedules'), optionalQuery('workshop_capacity_defaults'),
                optionalQuery('workshop_schedule_exceptions')
            ])).then(([piecesRes, giftCardMovementsRes, inventoryRes, movementsRes, scheduleRes, capacityDefaultsRes, exceptionsRes]) => {
                if (generation !== loadGenerationRef.current || scopeRef.current !== scope || !activeRef.current) return;
                const normalizedPieces: CeramicPiece[] = (piecesRes.data || []).map((row: any) => ({
                    id: row.id, owner: row.owner_name, description: row.description, status: row.status,
                    glazeType: row.glaze_type || undefined, deliveryDate: row.delivery_date || undefined,
                    notes: row.notes || undefined, extraCommentary: row.extra_commentary || undefined, createdAt: row.created_at || undefined
                }));
                const giftCardMovements: GiftCardMovement[] = (giftCardMovementsRes.data || []).map((row: any) => ({
                    id: row.id, giftCardId: row.gift_card_id, sessionId: row.session_id || undefined,
                    studentId: row.student_id || undefined, type: row.movement_type, sessionsDelta: row.sessions_delta,
                    note: row.note || undefined, createdAt: row.created_at
                }));
                movementsByGiftCard = giftCardMovements.reduce<Record<string, GiftCardMovement[]>>((groups, movement) => {
                    (groups[movement.giftCardId] ||= []).push(movement); return groups;
                }, {});
                setPieces(normalizedPieces);
                setGiftCards(current => current.map(card => ({ ...card, movements: movementsByGiftCard[card.id] || [] })));
                setInventoryItems((inventoryRes.data || []) as InventoryItem[]);
                setInventoryMovements((movementsRes.data || []) as InventoryMovement[]);
                setWorkshopSchedule((scheduleRes.data || []).map((row: any) => ({
                    id: row.id, dayOfWeek: Number(row.day_of_week), slotIndex: Number(row.slot_index ?? 0), isOpen: Boolean(row.is_open),
                    opensAt: row.opens_at ? String(row.opens_at).slice(0, 5) : '', closesAt: row.closes_at ? String(row.closes_at).slice(0, 5) : ''
                })).sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.slotIndex - b.slotIndex));
                const loadedCapacityDefaults = (capacityDefaultsRes.error ? [] : (capacityDefaultsRes.data || []))
                    .filter((row: any) => row.class_type !== 'feriado')
                    .map((row: any) => ({ id: row.id, classType: row.class_type as CapacityActivity, capacity: Number(row.capacity) }));
                setCapacityDefaults(loadedCapacityDefaults.length
                    ? loadedCapacityDefaults
                    : Object.entries(DEFAULT_CAPACITY_BY_ACTIVITY).map(([classType, capacity]) => ({ classType: classType as CapacityActivity, capacity })));
                setWorkshopScheduleExceptions((exceptionsRes.error ? [] : (exceptionsRes.data || [])).map((row: any) => ({
                    id: row.id, exceptionDate: String(row.exception_date).slice(0, 10), slotIndex: Number(row.slot_index ?? 0), isOpen: Boolean(row.is_open),
                    opensAt: row.opens_at ? String(row.opens_at).slice(0, 5) : '', closesAt: row.closes_at ? String(row.closes_at).slice(0, 5) : '', reason: row.reason || undefined
                })).sort((a, b) => a.exceptionDate.localeCompare(b.exceptionDate) || a.slotIndex - b.slotIndex));
            }).catch(error => console.warn('Secondary data load skipped:', error));

            // Phase 2 is authoritative: full history, business state, funding and owner identity.
            const [fullStudentsRes, fullSessionsRes, sessionContractRes, giftContractRes, effectiveRes, periodsRes, businessRes, ownerRes, creditProfileRes, giftRes] = await Promise.all([
                buildQuery('students'), buildQuery('sessions'), buildQuery('session_operation_receipts', 0), buildQuery('gift_card_operation_receipts', 0),
                buildQuery('students_effective_membership'), buildQuery('student_membership_periods'),
                buildQuery('session_business_state'),
                readAllRows((offset, size) => withTimeout('sedes.owner.select',
                    supabase.from('sedes').select('id', { count: 'exact' }).eq('owner_id', session!.user.id).eq('is_active', true)
                        .order('id', { ascending: true }).range(offset, offset + size - 1), RELOAD_TIMEOUT_MS)),
                buildQuery('student_credit_profile'), buildQuery('gift_cards')
            ]);
            if (generation !== loadGenerationRef.current) throw new Error('Recarga reemplazada por una solicitud mas reciente.');
            requireScope();
            if (sessionContractRes.error || giftContractRes.error) {
                throw new Error('El backend no tiene los contratos de bonos y asistencia atomica. Requiere una actualizacion coordinada autorizada.');
            }
            for (const result of [fullStudentsRes, fullSessionsRes, effectiveRes, periodsRes, businessRes, ownerRes, creditProfileRes, giftRes]) {
                if (result.error) throw result.error;
            }
            const fullSessions = (fullSessionsRes.data || []).map(mapSession);
            const sessionIds = new Set(fullSessions.map(item => item.id));
            const businessBySession: Record<string, any[]> = {};
            (businessRes.data || []).forEach((row: any) => {
                if (!sessionIds.has(row.session_id)) throw new Error('El estado de negocio contiene una sesion no cargada. Recarga los datos.');
                (businessBySession[row.session_id] ||= []).push(row);
            });
            const enhancedSessions = fullSessions.map(item => attachSessionBusinessState(item, businessBySession[item.id] || []));
            const giftIds = new Set<string>();
            const normalizedGiftCards: GiftCard[] = (giftRes.data || []).map((row: any) => {
                if (typeof row.id !== 'string' || !row.id || giftIds.has(row.id)
                    || typeof row.sede_id !== 'string' || !row.sede_id || (!isSuperAdmin && sedeId && row.sede_id !== sedeId)
                    || !Number.isSafeInteger(row.num_classes) || row.num_classes <= 0
                    || !Number.isSafeInteger(row.sessions_used) || row.sessions_used < 0 || row.sessions_used > row.num_classes
                    || !['modelado', 'torno'].includes(row.type)
                    || (row.payment_status !== null && !['paid', 'pending', 'refunded'].includes(row.payment_status))
                    || !['pending', 'active', 'exhausted', 'consumed', 'expired', 'cancelled'].includes(row.status)) {
                    throw new Error('La proyeccion de bonos regalo no contiene una financiacion verificable. Recarga los datos.');
                }
                giftIds.add(row.id);
                return { ...mapGiftCardRowToModel(row), movements: movementsByGiftCard[row.id] || [] };
            });
            const ownerIds = (ownerRes.data || []).map((row: any) => row.id);
            if (ownerIds.some(id => typeof id !== 'string' || !id) || new Set(ownerIds).size !== ownerIds.length) {
                throw new Error('No se pudo verificar la identidad de las sedes del propietario.');
            }
            const enhancedStudents = attachStudentCreditProfiles(
                attachAttendanceHistory(joinStudentMemberships(fullStudentsRes.data || [], effectiveRes.data || [], periodsRes.data || []), enhancedSessions),
                creditProfileRes.data || [], enhancedSessions, normalizedGiftCards
            );
            studentsRef.current = enhancedStudents; sessionsRef.current = enhancedSessions; giftCardsRef.current = normalizedGiftCards;
            setSessions(enhancedSessions); setStudents(enhancedStudents); setGiftCards(normalizedGiftCards);
            setOwnedSedeIds(ownerIds);
            ownedSedeIdsRef.current = ownerIds;
            businessReadyRef.current = true;
            setBusinessDataReady(true);
        } catch (error) {
            if (generation !== loadGenerationRef.current || scopeRef.current !== scope || !activeRef.current) throw error;
            businessReadyRef.current = false;
            setBusinessDataReady(false);
            studentsRef.current = []; giftCardsRef.current = [];
            ownedSedeIdsRef.current = [];
            setStudents([]);
            setGiftCards([]); setOwnedSedeIds([]);
            console.error('Supabase load error', error);
            setLoadError('No se pudieron cargar los datos. Comprueba la conexión, los permisos y las migraciones de esta versión del backend.');
            throw error;
        } finally {
            if (generation === loadGenerationRef.current) {
                setIsLoadingData(false);
                hasLoadedOnceRef.current = true;
            }
        }
    }, [session, sedeId, isSuperAdmin, scope, requireScope]);

    const safeReload = useCallback(async () => {
        await loadAllData();
    }, [loadAllData]);

    useEffect(() => {
        activeRef.current = true;
        if (loadedScope !== scope || !session) {
            ++loadGenerationRef.current;
            businessReadyRef.current = false;
            setBusinessDataReady(false);
            hasLoadedOnceRef.current = false;
            setIsLoadingData(!!session);
            setLoadedScope(scope);
            setStudents([]); setSessions([]); setPieces([]); setGiftCards([]);
            setOwnedSedeIds([]); setInventoryItems([]); setInventoryMovements([]); setTeachers([]);
            ownedSedeIdsRef.current = [];
            setWorkshopSchedule([]); setWorkshopScheduleExceptions([]);
            setCapacityDefaults(Object.entries(DEFAULT_CAPACITY_BY_ACTIVITY).map(([classType, capacity]) => ({ classType: classType as CapacityActivity, capacity })));
            setLoadError(null);
        }
        if (session) {
            // Always load when there's a session. RLS protects data at DB level.
            void loadAllData().catch(() => undefined);
        }
        return () => { activeRef.current = false; businessReadyRef.current = false; ++loadGenerationRef.current; };
    }, [session, sedeId, isSuperAdmin, loadAllData]);

    // ==================== REFS FOR STABLE OPS CONTEXT ====================
    // Using refs prevents getOpsContext from changing on every state update,
    // which prevents React from aborting in-flight fetch requests (AbortError).
    useEffect(() => { studentsRef.current = students; }, [students]);
    useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
    useEffect(() => { piecesRef.current = pieces; }, [pieces]);
    useEffect(() => { giftCardsRef.current = giftCards; }, [giftCards]);
    useEffect(() => { capacityDefaultsRef.current = capacityDefaults; }, [capacityDefaults]);

    const getOpsContext = useCallback((requiresReady = true): OpsContext => {
        if (requiresReady) requireBusinessData();
        else requireScope();
        const guarded = <T,>(setter: React.Dispatch<React.SetStateAction<T>>): React.Dispatch<React.SetStateAction<T>> => update => {
            requireScope();
            setter(update);
        };
        return {
            assertScope: requiresReady ? requireBusinessData : requireScope,
            sedeId, isSuperAdmin, operationLockRef,
            get students() { return studentsRef.current; },
            get sessions() { return sessionsRef.current; },
            get giftCards() { return giftCardsRef.current; },
            get capacityDefaults() { return capacityDefaultsRef.current; },
            get pieces() { return piecesRef.current; },
            setStudents: guarded(setStudents), setSessions: guarded(setSessions), setTeachers: guarded(setTeachers),
            setPieces: guarded(setPieces), setGiftCards: guarded(setGiftCards),
            setInventoryItems: guarded(setInventoryItems), setInventoryMovements: guarded(setInventoryMovements), safeReload
        };
    }, [sedeId, isSuperAdmin, safeReload, requireBusinessData, requireScope]);

    // ==================== DELEGATED CRUD ====================
    // No useCallback needed — getOpsContext is now stable
    const addStudent = async (s: Omit<Student, 'id'>) => studentOps.addStudent(getOpsContext(), s);
    const updateStudent = async (id: string, u: Partial<Student>) => studentOps.updateStudent(getOpsContext(), id, u);
    const deleteStudent = async (id: string) => studentOps.deleteStudent(getOpsContext(), id);
    const membership = createMembershipOperations({
        rpc: (name, args) => { requireBusinessData(); return withTimeout(name, supabase.rpc(name, args)); }, refresh: safeReload
    });
    const renewStudent = async (intent: RenewalIntent) => { await membership.renew(intent); };
    const activateMembership = async (id: string) => { await membership.activate(id); };
    const initializeLegacyMemberships = async () => {
        requireBusinessData();
        const legacyMemberships = studentsRef.current.filter(student =>
            (student.studentCategory || 'membresia') === 'membresia'
            && !student.effectivePeriodId
            && !student.materializedPeriodId
            && !student.membershipPeriods?.length
        );
        let initialized = 0;
        let failed = 0;
        for (const student of legacyMemberships) {
            try {
                requireBusinessData();
                const result = await withTimeout('activate_student_membership', supabase.rpc('activate_student_membership', { student_id: student.id }));
                if (result.error || !result.data) failed++;
                else initialized++;
            } catch {
                failed++;
            }
        }
        if (legacyMemberships.length > 0) await safeReload();
        return { initialized, failed };
    };
    const confirmMembershipPayment = async (id: string, periodId: string) => {
        requireBusinessData();
        if (!studentsRef.current.find(student => student.id === id)?.membershipPeriods?.some(period => period.id === periodId)) {
            throw new Error('Selecciona un período del alumno. Inicializa primero el registro legado si es necesario.');
        }
        await membership.confirm(periodId);
    };
    const adjustMembershipClasses = async (_intent: ClassAdjustmentIntent) => {
        throw new Error('Los ajustes genericos estan bloqueados para no eludir penalizaciones. Usa la exencion del propietario para una penalizacion registrada.');
    };

    const studentCreditOperations = () => {
        requireScope();
        if (!session?.user.id) throw new Error('Inicia sesion antes de gestionar creditos.');
        studentCreditStoreRef.current ??= new StudentCreditIntentStore();
        return createStudentCreditOperations({ actorId: session.user.id, store: studentCreditStoreRef.current,
            rpc: (name, args) => { requireBusinessData(); return withTimeout(name, supabase.rpc(name, args)); }, refresh: safeReload });
    };
    const canManageStudentCredits = (student: Student) => activeRef.current && scopeRef.current === scope
        && scopeVersionRef.current === scopeVersion && businessReadyRef.current && !!student.sedeId && ownedSedeIdsRef.current.includes(student.sedeId);
    const requireCreditStudent = (id: string) => {
        requireBusinessData();
        const student = studentsRef.current.find(item => item.id === id);
        if (!student || !canManageStudentCredits(student)) throw new Error('Solo el propietario de la sede del alumno puede gestionar sus creditos.');
        return student;
    };
    const approveStudentManualCredit = async (intent: ManualCreditIntent) => {
        requireCreditStudent(intent.studentId);
        await studentCreditOperations().approve(intent);
    };
    const settlePendingStudentPenalty = async (intent: PenaltySettlementIntent) => {
        const student = requireCreditStudent(intent.studentId);
        const penalty = student.pendingPenalties?.find(item => item.id === intent.penaltyId);
        if (!penalty || penalty.studentId !== student.id || penalty.sedeId !== student.sedeId) throw new Error('Recarga la incidencia original del alumno antes de liquidarla.');
        if (sessionOps.getPendingSessionOperation(getOpsContext(), penalty.sessionId)) throw new Error('Recupera primero la operacion pendiente de esta sesion.');
        await studentCreditOperations().settle(intent, penalty.sessionId);
    };
    const waiveStudentPenalty = async (intent: SessionBusinessIntent) => {
        const student = requireCreditStudent(intent.studentId);
        const penalty = student.pendingPenalties?.find(item => item.sessionId === intent.sessionId);
        if (!penalty || penalty.studentId !== student.id || penalty.sedeId !== student.sedeId) throw new Error('Recarga la penalizacion original antes de eximirla.');
        if (sessionOps.getPendingSessionOperation(getOpsContext(), penalty.sessionId)) throw new Error('Recupera primero la operacion pendiente de esta sesion.');
        await studentCreditOperations().waive(intent, penalty.id);
    };
    const getPendingStudentCreditOperation = (studentId: string) => session?.user.id
        ? studentCreditOperations().getPending(studentId) : null;
    const retryPendingStudentCreditOperation = async (studentId: string) => {
        requireBusinessData();
        // Recovery uses stored arguments, even when a commit changed the loaded incident.
        await studentCreditOperations().retry(studentId);
    };

    const addSession = async (s: Omit<ClassSession, 'id'>) => sessionOps.addSession(getOpsContext(), s);
    const updateSession = async (id: string, u: Partial<ClassSession>) => sessionOps.updateSession(getOpsContext(), id, u);
    const deleteSession = async (id: string) => sessionOps.deleteSession(getOpsContext(), id);
    const getPendingSessionOperation = (id?: string) => sessionOps.getPendingSessionOperation(getOpsContext(false), id);
    const retryPendingSessionOperation = async (id?: string) => sessionOps.retryPendingSessionOperation(getOpsContext(), id);
    const approveSessionException = async (intent: SessionBusinessIntent) => {
        if (intent.operation !== 'approve_exception') throw new Error('Operacion incompatible con la aprobacion.');
        await sessionOps.applySessionBusinessOperation(getOpsContext(), intent);
    };
    const cancelSessionReservation = async (intent: SessionBusinessIntent) => {
        if (intent.operation !== 'cancel_reservation') throw new Error('Operacion incompatible con la cancelacion.');
        await sessionOps.applySessionBusinessOperation(getOpsContext(), intent);
    };
    const waiveSessionPenalty = async (intent: SessionBusinessIntent) => {
        if (intent.operation !== 'waive_penalty') throw new Error('Operacion incompatible con la exencion.');
        await sessionOps.applySessionBusinessOperation(getOpsContext(), intent);
    };

    const addTeacher = async (t: Omit<Teacher, 'id'>) => teacherOps.addTeacher(getOpsContext(), t);
    const updateTeacher = async (id: string, u: Partial<Teacher>) => teacherOps.updateTeacher(getOpsContext(), id, u);
    const deleteTeacher = async (id: string) => teacherOps.deleteTeacher(getOpsContext(), id);

    const addPiece = async (p: Omit<CeramicPiece, 'id'>) => pieceOps.addPiece(getOpsContext(), p);
    const updatePiece = async (id: string, u: Partial<CeramicPiece>) => pieceOps.updatePiece(getOpsContext(), id, u);
    const deletePiece = async (id: string) => pieceOps.deletePiece(getOpsContext(), id);

    const addGiftCard = async (c: Omit<GiftCard, 'id' | 'createdAt'>) => giftCardOps.addGiftCard(getOpsContext(), c);
    const updateGiftCard = async (id: string, u: Partial<GiftCard>) => giftCardOps.updateGiftCard(getOpsContext(), id, u, giftCardsRef.current);
    const deleteGiftCard = async (id: string) => giftCardOps.deleteGiftCard(getOpsContext(), id);
    const consumeGiftCard = async (giftCardId: string, consumedAt?: string) => giftCardOps.consumeGiftCard(getOpsContext(), giftCardId, consumedAt);
    const cancelGiftCard = async (giftCardId: string) => giftCardOps.cancelGiftCard(getOpsContext(), giftCardId);
    const confirmGiftCardPayment = async (giftCardId: string) => {
        requireBusinessData();
        const { error } = await withTimeout('gift_cards.confirm_payment', supabase.rpc('confirm_gift_card_payment', { p_gift_card_id: giftCardId }));
        if (error) throw error;
        await safeReload();
    };
    const redeemGiftCardSession = async (giftCardId: string, sessionId: string, studentId?: string) => giftCardOps.redeemGiftCardSession(getOpsContext(), giftCardId, sessionId, studentId);
    const reverseGiftCardSession = async (giftCardId: string | undefined, sessionId: string, studentId?: string) => giftCardOps.reverseGiftCardSession(getOpsContext(), giftCardId || '', sessionId, studentId);

    const addInventoryItem = async (i: InventoryItem) => inventoryOps.addInventoryItem(getOpsContext(), i);
    const updateInventoryItem = async (id: string, u: Partial<InventoryItem>) => inventoryOps.updateInventoryItem(getOpsContext(), id, u);
    const archiveInventoryItem = async (id: string) => inventoryOps.archiveInventoryItem(getOpsContext(), id);
    const deleteInventoryItem = async (id: string) => inventoryOps.deleteInventoryItem(getOpsContext(), id);
    const addInventoryMovement = async (m: Omit<InventoryMovement, 'id'>) => inventoryOps.addInventoryMovement(getOpsContext(), m);

    const updateWorkshopSchedule = async (schedule: WorkshopScheduleDay[]) => {
        requireBusinessData();
        if (!sedeId) {
            showError('No se pudo identificar la sede activa.');
            return false;
        }
        const rows = schedule.map(day => ({
            day_of_week: day.dayOfWeek,
            slot_index: day.slotIndex,
            is_open: day.isOpen,
            opens_at: day.isOpen ? day.opensAt : null,
            closes_at: day.isOpen ? day.closesAt : null
        }));
        try {
            const { data, error } = await withTimeout('workshop_schedules.replace',
                supabase.rpc('replace_workshop_schedule', { p_sede_id: sedeId, p_schedule: rows })
            );
            if (error) {
                showError(`No se pudo guardar el horario. ${error.message || ''}`);
                return false;
            }
            requireScope();
            const savedRows = (data || rows.map(row => ({ ...row, id: crypto.randomUUID() }))) as any[];
            setWorkshopSchedule(savedRows.map(row => ({
                id: row.id,
                dayOfWeek: Number(row.day_of_week),
                slotIndex: Number(row.slot_index),
                isOpen: Boolean(row.is_open),
                opensAt: row.opens_at || '',
                closesAt: row.closes_at || ''
            })).sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.slotIndex - b.slotIndex));
            return true;
        } catch (error: any) {
            showError(`No se pudo guardar el horario. ${error.message || 'Conexión lenta, inténtalo de nuevo.'}`);
            return false;
        }
    };

    const updateWorkshopScheduleException = async (exceptionDate: string, slots: Omit<WorkshopScheduleException, 'id' | 'exceptionDate'>[]) => {
        requireBusinessData();
        if (!sedeId) {
            showError('No se pudo identificar la sede activa.');
            return false;
        }
        const rows = slots.map(slot => ({
            slot_index: slot.slotIndex,
            is_open: slot.isOpen,
            opens_at: slot.isOpen ? slot.opensAt : null,
            closes_at: slot.isOpen ? slot.closesAt : null,
            reason: slot.reason || null
        }));
        try {
            const { data, error } = await withTimeout('workshop_schedule_exceptions.replace',
                supabase.rpc('replace_workshop_schedule_exception', {
                    p_sede_id: sedeId,
                    p_exception_date: exceptionDate,
                    p_slots: rows
                })
            );
            if (error) {
                showError(`No se pudo guardar la excepción. ${error.message || ''}`);
                return false;
            }
            const savedRows = (data || rows.map(row => ({ ...row, exception_date: exceptionDate, id: crypto.randomUUID() }))) as any[];
            requireScope();
            const mapped = savedRows.map(row => ({
                id: row.id,
                exceptionDate,
                slotIndex: Number(row.slot_index ?? row.slotIndex),
                isOpen: Boolean(row.is_open ?? row.isOpen),
                opensAt: row.opens_at || row.opensAt || '',
                closesAt: row.closes_at || row.closesAt || '',
                reason: row.reason || undefined
            }));
            setWorkshopScheduleExceptions(previous => [...previous.filter(item => item.exceptionDate !== exceptionDate), ...mapped]
                .sort((a, b) => a.exceptionDate.localeCompare(b.exceptionDate) || a.slotIndex - b.slotIndex));
            return true;
        } catch (error: any) {
            showError(`No se pudo guardar la excepción. ${error.message || 'Conexión lenta, inténtalo de nuevo.'}`);
            return false;
        }
    };

    const updateCapacityDefault = async (classType: CapacityActivity, capacity: number) => {
        requireBusinessData();
        if (!sedeId) {
            showError('No se pudo identificar la sede activa.');
            return false;
        }
        try {
            const { data, error } = await withTimeout('workshop_capacity_defaults.upsert',
                supabase.from('workshop_capacity_defaults').upsert({ sede_id: sedeId, class_type: classType, capacity }, { onConflict: 'sede_id,class_type' }).select().single()
            );
            if (error) {
                showError(`No se pudo guardar la capacidad predeterminada. ${error.message || ''}`);
                return false;
            }
            const saved = { id: data?.id, classType, capacity };
            requireScope();
            setCapacityDefaults(previous => [...previous.filter(item => item.classType !== classType), saved]);
            return true;
        } catch (error: any) {
            showError(`No se pudo guardar la capacidad predeterminada. ${error.message || 'Conexión lenta, inténtalo de nuevo.'}`);
            return false;
        }
    };

    const value: DataContextType = {
        students: loadedScope === scope ? students : [], sessions: loadedScope === scope ? sessions : [],
        pieces: loadedScope === scope ? pieces : [], giftCards: loadedScope === scope ? giftCards : [],
        inventoryItems: loadedScope === scope ? inventoryItems : [], inventoryMovements: loadedScope === scope ? inventoryMovements : [],
        teachers: loadedScope === scope ? teachers : [], workshopSchedule: loadedScope === scope ? workshopSchedule : [],
        workshopScheduleExceptions: loadedScope === scope ? workshopScheduleExceptions : [],
        capacityDefaults: loadedScope === scope ? capacityDefaults : Object.entries(DEFAULT_CAPACITY_BY_ACTIVITY).map(([classType, capacity]) => ({ classType: classType as CapacityActivity, capacity })),
        isLoadingData: loadedScope !== scope || isLoadingData, businessDataReady: loadedScope === scope && businessDataReady, loadError: loadedScope === scope ? loadError : null,
        addStudent, updateStudent, deleteStudent, renewStudent, confirmMembershipPayment, activateMembership, initializeLegacyMemberships, adjustMembershipClasses,
        approveStudentManualCredit, settlePendingStudentPenalty, waiveStudentPenalty, canManageStudentCredits,
        getPendingStudentCreditOperation, retryPendingStudentCreditOperation,
        addSession, updateSession, deleteSession,
        approveSessionException, cancelSessionReservation, waiveSessionPenalty,
        getPendingSessionOperation, retryPendingSessionOperation,
        isCurrentSedeOwner: loadedScope === scope && businessDataReady && !!sedeId && ownedSedeIds.includes(sedeId), canAdjustMembershipClasses: false,
        canWaiveSessionPenalty: (session: ClassSession) => activeRef.current && scopeRef.current === scope
            && scopeVersionRef.current === scopeVersion && businessReadyRef.current && !!session.sedeId && ownedSedeIdsRef.current.includes(session.sedeId),
        addTeacher, updateTeacher, deleteTeacher,
        addPiece, updatePiece, deletePiece,
        addGiftCard, updateGiftCard, deleteGiftCard, consumeGiftCard, cancelGiftCard, confirmGiftCardPayment,
        redeemGiftCardSession, reverseGiftCardSession,
        addInventoryItem, updateInventoryItem, archiveInventoryItem, deleteInventoryItem, addInventoryMovement, updateWorkshopSchedule, updateWorkshopScheduleException, updateCapacityDefault,
        loadAllData
    };

    return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export default DataContext;

