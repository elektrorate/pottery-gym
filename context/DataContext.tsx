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
import { extractTime, withTimeout, RELOAD_TIMEOUT_MS, OpsContext, mapGiftCardRowToModel, joinStudentMemberships } from './data/shared';
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
    const [loadError, setLoadError] = useState<string | null>(null);
    const [ownedSedeIds, setOwnedSedeIds] = useState<string[]>([]);
    const hasLoadedOnceRef = useRef(false);
    const operationLockRef = useRef(false);
    const loadGenerationRef = useRef(0);
    const studentCreditStoreRef = useRef<StudentCreditIntentStore | null>(null);

    // ==================== DATA LOADING ====================
    const loadAllData = useCallback(async () => {
        if (!session) return;
        const generation = ++loadGenerationRef.current;
        // Removed sedeId guard: RLS on Supabase will filter by get_owned_sede_id()
        // This ensures staff users can load data even before sedeId resolves
        if (!hasLoadedOnceRef.current) setIsLoadingData(true);
        setLoadError(null);

        try {
            const buildQuery = (table: string, limit?: number) => {
                const select = () => {
                    let query = supabase.from(table).select('*', { count: 'exact' });
                    if (!isSuperAdmin && sedeId) query = query.eq('sede_id', sedeId);
                    return query;
                };
                if (limit !== undefined) return withTimeout(`${table}.select`, select().limit(limit), RELOAD_TIMEOUT_MS);
                const keys = table === 'session_business_state' ? ['session_id', 'student_id']
                    : ['students_effective_membership', 'student_credit_profile'].includes(table) ? ['student_id'] : ['id'];
                return readAllRows((offset, size) => {
                    let query = select();
                    for (const key of keys) query = query.order(key, { ascending: true });
                    return withTimeout(`${table}.select`, query.range(offset, offset + size - 1), RELOAD_TIMEOUT_MS);
                });
            };

            // Optional domains must not hold the calendar hostage. They are
            // retried on the next refresh, while the critical roster/session
            // snapshot can render as soon as it is available.
            const optionalQuery = <T,>(query: Promise<T>, fallback: T): Promise<T> => Promise.race([
                query,
                new Promise<T>(resolve => setTimeout(() => resolve(fallback), 4500))
            ]).catch(() => fallback);

            // Phase 1: only the data required to render the dashboard/calendar.
            // Secondary domains are intentionally loaded below so inventory and
            // gift-card history cannot delay the first useful paint.
            const [studentsRes, teachersRes, sessionsRes, sessionStudentsRes, sessionContractRes, giftContractRes, activityBlocksRes, activityBlockStudentsRes] = await Promise.all([
                buildQuery('students'), buildQuery('teachers'), buildQuery('sessions'),
                buildQuery('session_students'),
                buildQuery('session_operation_receipts', 0), buildQuery('gift_card_operation_receipts', 0),
                optionalQuery(buildQuery('session_activity_blocks'), { data: [], error: null }),
                optionalQuery(buildQuery('session_activity_block_students'), { data: [], error: null })
            ]);

            if (generation !== loadGenerationRef.current) throw new Error('Recarga reemplazada por una solicitud más reciente.');
            if (studentsRes.error) throw studentsRes.error;
            // Never mix new identity/atomic consumers with older writable projections.
            if (sessionContractRes.error || giftContractRes.error) {
                throw new Error('El backend no tiene los contratos de bonos y asistencia atómica. Requiere una actualización coordinada autorizada.');
            }
            if (teachersRes.error) throw teachersRes.error;
            if (sessionsRes.error) throw sessionsRes.error;
            if (sessionStudentsRes.error) throw sessionStudentsRes.error;
            const normalizedStudents = joinStudentMemberships(studentsRes.data || [], [], []);

            // Normalize session students
            const sessionStudentsMap: Record<string, any[]> = {};
            (sessionStudentsRes.data || []).forEach((row: any) => {
                if (!sessionStudentsMap[row.session_id]) sessionStudentsMap[row.session_id] = [];
                sessionStudentsMap[row.session_id].push(row);
            });
            const activityBlockStudentsMap: Record<string, any[]> = {};
            (activityBlockStudentsRes.data || []).forEach((row: any) => {
                (activityBlockStudentsMap[row.block_id] ||= []).push(row);
            });
            const activityBlocksMap: Record<string, any[]> = {};
            (activityBlocksRes.data || []).forEach((row: any) => {
                (activityBlocksMap[row.session_id] ||= []).push(row);
            });

            // Capacity configuration is secondary; use stable defaults for the
            // first calendar render and replace them after the background load.
            const configuredCapacityDefaults = DEFAULT_CAPACITY_BY_ACTIVITY;

            const normalizedSessions: ClassSession[] = (sessionsRes.data || []).map((row: any) => {
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
            });

            const studentsWithAttendance = attachAttendanceHistory(normalizedStudents, normalizedSessions);

            // Publish the critical snapshot now. The calendar no longer waits
            // for inventory/gift-card/schedule tables.
            setStudents(attachStudentCreditProfiles(studentsWithAttendance, [], normalizedSessions, []));

            // Lifecycle is derived from the payment due date. Loading data must
            // never renew unpaid memberships or persist automatic archival.

            setTeachers((teachersRes.data || []) as Teacher[]);
            setSessions(normalizedSessions);
            setOwnedSedeIds([]);
            // Keep the first render independent from secondary domains.
            setLoadError(null);

            // Phase 2: secondary data is best-effort and updates its own slices.
            void Promise.all([
                buildQuery('students_effective_membership'),
                buildQuery('student_membership_periods'),
                buildQuery('session_business_state'),
                readAllRows((offset, size) => withTimeout('sedes.owner.select',
                    supabase.from('sedes').select('id', { count: 'exact' }).eq('owner_id', session.user.id).eq('is_active', true)
                        .order('id', { ascending: true }).range(offset, offset + size - 1), RELOAD_TIMEOUT_MS)),
                buildQuery('student_credit_profile'),
                optionalQuery(buildQuery('pieces'), { data: [], error: null }),
                optionalQuery(buildQuery('gift_cards'), { data: [], error: null }),
                optionalQuery(buildQuery('gift_card_movements'), { data: [], error: null }),
                optionalQuery(buildQuery('inventory_items'), { data: [], error: null }),
                optionalQuery(buildQuery('inventory_movements'), { data: [], error: null }),
                optionalQuery(buildQuery('workshop_schedules'), { data: [], error: null }),
                optionalQuery(buildQuery('workshop_capacity_defaults'), { data: [], error: null }),
                optionalQuery(buildQuery('workshop_schedule_exceptions'), { data: [], error: null })
            ]).then(([effectiveRes, periodsRes, businessRes, ownerRes, creditProfileRes, piecesRes, giftRes, giftCardMovementsRes, inventoryRes, movementsRes, scheduleRes, capacityDefaultsRes, exceptionsRes]) => {
                if (generation !== loadGenerationRef.current) return;
                if (effectiveRes.error || periodsRes.error || businessRes.error || ownerRes.error || creditProfileRes.error) {
                    console.warn('Secondary membership/credit data load skipped');
                    return;
                }
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
                const movementsByGiftCard = giftCardMovements.reduce<Record<string, GiftCardMovement[]>>((groups, movement) => {
                    (groups[movement.giftCardId] ||= []).push(movement); return groups;
                }, {});
                const normalizedGiftCards: GiftCard[] = (giftRes.data || []).map((row: any) => ({
                    ...mapGiftCardRowToModel(row), movements: movementsByGiftCard[row.id] || []
                }));
                const enhancedStudents = attachStudentCreditProfiles(
                    attachAttendanceHistory(joinStudentMemberships(studentsRes.data || [], effectiveRes.data || [], periodsRes.data || []), normalizedSessions),
                    creditProfileRes.data || [], normalizedSessions, normalizedGiftCards
                );
                const businessBySession: Record<string, any[]> = {};
                (businessRes.data || []).forEach((row: any) => { (businessBySession[row.session_id] ||= []).push(row); });
                const enhancedSessions = normalizedSessions.map(item => attachSessionBusinessState(item, businessBySession[item.id] || []));
                setSessions(enhancedSessions);
                setStudents(enhancedStudents);
                setOwnedSedeIds((ownerRes.data || []).map((row: any) => row.id));
                setPieces(normalizedPieces); setGiftCards(normalizedGiftCards);
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
                // Re-attach gift-card state once the secondary domain arrives.
            }).catch(error => console.warn('Secondary data load skipped:', error));
        } catch (error) {
            if (generation !== loadGenerationRef.current) throw error;
            setStudents([]);
            console.error('Supabase load error', error);
            setLoadError('No se pudieron cargar los datos. Comprueba la conexión, los permisos y las migraciones de esta versión del backend.');
            throw error;
        } finally {
            if (generation === loadGenerationRef.current) {
                setIsLoadingData(false);
                hasLoadedOnceRef.current = true;
            }
        }
    }, [session, sedeId, isSuperAdmin]);

    const safeReload = useCallback(async () => {
        await loadAllData();
    }, [loadAllData]);

    useEffect(() => {
        if (session) {
            // Always load when there's a session. RLS protects data at DB level.
            void loadAllData().catch(() => undefined);
        }
        if (!session) {
            ++loadGenerationRef.current;
            setStudents([]); setSessions([]); setPieces([]);
            setOwnedSedeIds([]);
            setGiftCards([]); setInventoryItems([]); setInventoryMovements([]); setTeachers([]);
            setWorkshopSchedule([]);
            setWorkshopScheduleExceptions([]);
            setCapacityDefaults(Object.entries(DEFAULT_CAPACITY_BY_ACTIVITY).map(([classType, capacity]) => ({ classType: classType as CapacityActivity, capacity })));
            setLoadError(null);
        }
        return () => { ++loadGenerationRef.current; };
    }, [session, sedeId, isSuperAdmin, loadAllData]);

    // ==================== REFS FOR STABLE OPS CONTEXT ====================
    // Using refs prevents getOpsContext from changing on every state update,
    // which prevents React from aborting in-flight fetch requests (AbortError).
    const studentsRef = useRef(students);
    const sessionsRef = useRef(sessions);
    const piecesRef = useRef(pieces);
    const giftCardsRef = useRef(giftCards);
    const capacityDefaultsRef = useRef(capacityDefaults);
    useEffect(() => { studentsRef.current = students; }, [students]);
    useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
    useEffect(() => { piecesRef.current = pieces; }, [pieces]);
    useEffect(() => { giftCardsRef.current = giftCards; }, [giftCards]);
    useEffect(() => { capacityDefaultsRef.current = capacityDefaults; }, [capacityDefaults]);

    const getOpsContext = useCallback((): OpsContext => ({
        sedeId, isSuperAdmin, operationLockRef,
        get students() { return studentsRef.current; },
        get sessions() { return sessionsRef.current; },
        get giftCards() { return giftCardsRef.current; },
        get capacityDefaults() { return capacityDefaultsRef.current; },
        get pieces() { return piecesRef.current; },
        setStudents, setSessions, setTeachers, setPieces, setGiftCards,
        setInventoryItems, setInventoryMovements, safeReload
    }), [sedeId, isSuperAdmin, safeReload]);

    // ==================== DELEGATED CRUD ====================
    // No useCallback needed — getOpsContext is now stable
    const addStudent = async (s: Omit<Student, 'id'>) => studentOps.addStudent(getOpsContext(), s);
    const updateStudent = async (id: string, u: Partial<Student>) => studentOps.updateStudent(getOpsContext(), id, u);
    const deleteStudent = async (id: string) => studentOps.deleteStudent(getOpsContext(), id);
    const membership = createMembershipOperations({
        rpc: (name, args) => withTimeout(name, supabase.rpc(name, args)), refresh: safeReload
    });
    const renewStudent = async (intent: RenewalIntent) => { await membership.renew(intent); };
    const activateMembership = async (id: string) => { await membership.activate(id); };
    const initializeLegacyMemberships = async () => {
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
        if (!studentsRef.current.find(student => student.id === id)?.membershipPeriods?.some(period => period.id === periodId)) {
            throw new Error('Selecciona un período del alumno. Inicializa primero el registro legado si es necesario.');
        }
        await membership.confirm(periodId);
    };
    const adjustMembershipClasses = async (_intent: ClassAdjustmentIntent) => {
        throw new Error('Los ajustes genericos estan bloqueados para no eludir penalizaciones. Usa la exencion del propietario para una penalizacion registrada.');
    };

    const studentCreditOperations = () => {
        if (!session?.user.id) throw new Error('Inicia sesion antes de gestionar creditos.');
        studentCreditStoreRef.current ??= new StudentCreditIntentStore();
        return createStudentCreditOperations({ actorId: session.user.id, store: studentCreditStoreRef.current,
            rpc: (name, args) => withTimeout(name, supabase.rpc(name, args)), refresh: safeReload });
    };
    const canManageStudentCredits = (student: Student) => !!student.sedeId && ownedSedeIds.includes(student.sedeId);
    const requireCreditStudent = (id: string) => {
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
        // Recovery uses stored arguments, even when a commit changed the loaded incident.
        await studentCreditOperations().retry(studentId);
    };

    const addSession = async (s: Omit<ClassSession, 'id'>) => sessionOps.addSession(getOpsContext(), s);
    const updateSession = async (id: string, u: Partial<ClassSession>) => sessionOps.updateSession(getOpsContext(), id, u);
    const deleteSession = async (id: string) => sessionOps.deleteSession(getOpsContext(), id);
    const getPendingSessionOperation = (id?: string) => sessionOps.getPendingSessionOperation(getOpsContext(), id);
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
            setCapacityDefaults(previous => [...previous.filter(item => item.classType !== classType), saved]);
            return true;
        } catch (error: any) {
            showError(`No se pudo guardar la capacidad predeterminada. ${error.message || 'Conexión lenta, inténtalo de nuevo.'}`);
            return false;
        }
    };

    const value: DataContextType = {
        students, sessions, pieces, giftCards, inventoryItems, inventoryMovements, teachers, workshopSchedule, workshopScheduleExceptions, capacityDefaults, isLoadingData, loadError,
        addStudent, updateStudent, deleteStudent, renewStudent, confirmMembershipPayment, activateMembership, initializeLegacyMemberships, adjustMembershipClasses,
        approveStudentManualCredit, settlePendingStudentPenalty, waiveStudentPenalty, canManageStudentCredits,
        getPendingStudentCreditOperation, retryPendingStudentCreditOperation,
        addSession, updateSession, deleteSession,
        approveSessionException, cancelSessionReservation, waiveSessionPenalty,
        getPendingSessionOperation, retryPendingSessionOperation,
        isCurrentSedeOwner: !!sedeId && ownedSedeIds.includes(sedeId), canAdjustMembershipClasses: false,
        canWaiveSessionPenalty: (session: ClassSession) => !!session.sedeId && ownedSedeIds.includes(session.sedeId),
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

