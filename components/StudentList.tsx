import { showError } from '../context/toast';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Student, AssignedClass, inferMembershipTier, MEMBERSHIP_PLANS, MembershipTier, RenewalIntent, ClassAdjustmentIntent } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';
import { getStudentLifecycle, getStudentPaymentStatus, getWorkshopDate, isStudentArchived, addMembershipMonth, DEFAULT_STUDENT_PAYMENT_STATUS, getStudentReactivationUpdates, isManagedMembership } from '../utils/studentLifecycle';
import { createRenewalIntent, createClassAdjustmentIntent, PendingMembershipIntentStore } from '../context/data/membershipOps';
import { useWorkshopDate } from '../utils/useWorkshopDate';
import type { ManualCreditIntent, PenaltySettlementIntent, SessionBusinessIntent, PendingStudentCreditOperation } from '../types';

interface StudentListProps {
  students: Student[];
  detailsLoading?: boolean;
  onAddStudent: (student: Omit<Student, 'id'>) => Promise<void>;
  onRenew: (intent: RenewalIntent) => Promise<void>;
  onConfirmPayment: (studentId: string, periodId: string) => Promise<void>;
  onActivateMembership: (studentId: string) => Promise<void>;
  onInitializeLegacyMemberships?: () => Promise<{ initialized: number; failed: number }>;
  onAdjustClasses: (intent: ClassAdjustmentIntent) => Promise<void>;
  canAdjustClasses?: boolean;
  onUpdate: (id: string, updates: Partial<Student>) => Promise<void>;
  onDeleteStudent: (id: string) => Promise<void>;
  selectedStudentId?: string | null;
  onClearSelectedStudent?: () => void;
  onApproveManualCredit?: (intent: ManualCreditIntent) => Promise<void>;
  onSettlePendingPenalty?: (intent: PenaltySettlementIntent) => Promise<void>;
  onWaivePendingPenalty?: (intent: SessionBusinessIntent) => Promise<void>;
  canManageStudentCredits?: (student: Student) => boolean;
  getPendingStudentCreditOperation?: (studentId: string) => PendingStudentCreditOperation | null;
  onRetryPendingStudentCreditOperation?: (studentId: string) => Promise<void>;
}

const CREDIT_ACTIVITY_LABELS = { mesa: 'Modelado / mesa', torno: 'Torno', coworking: 'Coworking', workshop: 'Workshop', privada: 'Privada' };

const StudentCreditPanel: React.FC<Pick<StudentListProps, 'onApproveManualCredit' | 'onSettlePendingPenalty' | 'onWaivePendingPenalty' |
  'canManageStudentCredits' | 'getPendingStudentCreditOperation' | 'onRetryPendingStudentCreditOperation'> & { student: Student; today: string }> =
  ({ student, today, onApproveManualCredit, onSettlePendingPenalty, onWaivePendingPenalty,
    canManageStudentCredits, getPendingStudentCreditOperation, onRetryPendingStudentCreditOperation }) => {
  const [draft, setDraft] = useState({ mode: 'new_manual' as ManualCreditIntent['mode'], quantity: '',
    activity: '' as ManualCreditIntent['activity'] | '', startsOn: today, endsOn: addMembershipMonth(today), reason: '', evidence: '' });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const latest = useRef({ student, getPendingStudentCreditOperation, onRetryPendingStudentCreditOperation });
  latest.current = { student, getPendingStudentCreditOperation, onRetryPendingStudentCreditOperation };
  const pending = getPendingStudentCreditOperation?.(student.id) ?? null;
  const locked = busy || !!pending;
  const ownerHint = canManageStudentCredits?.(student) === true;
  const recoveryAvailable = !!getPendingStudentCreditOperation && !!onRetryPendingStudentCreditOperation;
  const legacyBalance = typeof student.legacyManualBalance === 'number' && Number.isFinite(student.legacyManualBalance)
    ? student.legacyManualBalance : null;
  const canReconcile = student.canReconcileLegacy !== false && !isManagedMembership(student)
    && !student.effectivePeriodId && !student.materializedPeriodId && !student.membershipPeriods?.length
    && Number.isSafeInteger(legacyBalance) && legacyBalance! > 0
    && !(student.manualCredits || []).some(credit => credit.mode === 'reconcile_legacy');
  const validDraft = Number.isSafeInteger(Number(draft.quantity)) && Number(draft.quantity) > 0
    && !!draft.activity && Object.hasOwn(CREDIT_ACTIVITY_LABELS, draft.activity)
    && /^\d{4}-\d{2}-\d{2}$/.test(draft.startsOn) && /^\d{4}-\d{2}-\d{2}$/.test(draft.endsOn)
    && Number.isFinite(Date.parse(draft.startsOn)) && Number.isFinite(Date.parse(draft.endsOn))
    && draft.startsOn <= draft.endsOn && !!draft.reason.trim() && draft.reason.trim().length <= 2000
    && !!draft.evidence.trim() && draft.evidence.trim().length <= 10000
    && (draft.mode !== 'reconcile_legacy' || (canReconcile && Number(draft.quantity) === legacyBalance));
  const controlClass = 'w-full min-w-0 h-10 px-3 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952] disabled:opacity-60';
  const buttonClass = 'min-h-10 px-3 py-2 rounded-md border border-[#DDBFA4] text-[12px] font-bold text-[#7B3F22] hover:bg-[#F0E2D6] disabled:opacity-50 disabled:cursor-not-allowed';

  const runOperation = async (operation: PendingStudentCreditOperation['operation'] | 'retry', penaltyId?: string) => {
    if (submitting.current) return;
    const current = latest.current;
    const stored = current.getPendingStudentCreditOperation?.(current.student.id);
    if (operation !== 'retry' && (stored || locked || !ownerHint || !recoveryAvailable || !current.student.sedeId)) return;
    let action: (() => Promise<void>) | undefined;
    if (operation === 'retry') {
      if (!stored || stored.studentId !== current.student.id || !current.onRetryPendingStudentCreditOperation) return;
      action = () => current.onRetryPendingStudentCreditOperation!(current.student.id);
    } else if (operation === 'approve_manual') {
      if (!onApproveManualCredit || !validDraft) return;
      // Only explicit raw observations are concurrency tokens, never a projected ledger total.
      const intent: ManualCreditIntent = Object.freeze({ studentId: current.student.id, requestKey: crypto.randomUUID(),
        mode: draft.mode, quantity: Number(draft.quantity), expectedLegacyBalance: legacyBalance,
        activity: draft.activity as ManualCreditIntent['activity'], startsOn: draft.startsOn, endsOn: draft.endsOn,
        reason: draft.reason.trim(), evidence: draft.evidence.trim() });
      action = () => onApproveManualCredit(intent);
    } else {
      const penalty = current.student.pendingPenalties?.find(item => item.id === penaltyId);
      const reason = reasons[penaltyId || '']?.trim();
      if (!penalty?.id || penalty.studentId !== current.student.id || penalty.sedeId !== current.student.sedeId
        || !['pending', 'charged'].includes(penalty.state) || !penalty.sessionId || !Number.isSafeInteger(penalty.sessionRevision)
        || penalty.sessionRevision! < 0 || !reason || reason.length > 2000) return;
      if (operation === 'settle_penalty') {
        const sources = [penalty.originalPeriodId, penalty.originalGiftCardId, penalty.originalManualCreditId].filter(Boolean);
        if (!onSettlePendingPenalty || penalty.state !== 'pending' || penalty.canSettle !== true || sources.length !== 1) return;
        const intent: PenaltySettlementIntent = Object.freeze({ penaltyId: penalty.id, studentId: current.student.id,
          requestKey: crypto.randomUUID(), expectedRevision: penalty.sessionRevision!, reason });
        action = () => onSettlePendingPenalty(intent);
      } else {
        if (!onWaivePendingPenalty) return;
        const intent: SessionBusinessIntent = Object.freeze({ operation: 'waive_penalty', sessionId: penalty.sessionId,
          studentId: current.student.id, requestKey: crypto.randomUUID(), expectedRevision: penalty.sessionRevision!, reason });
        action = () => onWaivePendingPenalty(intent);
      }
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      // The callback refreshes authoritative props before resolving. Never apply a receipt as a balance.
      const remaining = latest.current.getPendingStudentCreditOperation?.(student.id);
      if (remaining) setError('El resultado sigue pendiente. Reintenta la misma operación con sus datos originales.');
      else if (operation === 'approve_manual' || stored?.operation === 'approve_manual') setDraft(value => ({ ...value, quantity: '', reason: '', evidence: '' }));
      else setReasons({});
    } catch (failure: any) {
      const remaining = latest.current.getPendingStudentCreditOperation?.(student.id);
      const rejected = /^[0-9A-Z]{5}$/.test(failure?.code || '') && !['08000', '08003', '08006', '57014'].includes(failure.code);
      // Main retains any uncertain write until its receipt/refresh is resolved.
      // No stored intent means pre-write validation or a fully refreshed rejection.
      setError(`${failure?.message || 'No se pudo completar la operación.'}${remaining
        ? ' Resultado sin confirmar. Reintenta los mismos datos originales; no crees otro intento.'
        : rejected ? ' Revisa los datos recargados antes de aprobar un nuevo intento.'
          : ' Revisa y corrige los datos antes de volver a intentarlo.'}`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return <section aria-label="Créditos manuales e incidencias" data-testid="student-credit-panel" data-student-id={student.id}
    className="min-w-0 space-y-4 border-t border-[#E6D8CB] py-6 text-[12px] text-[#8B6B5E]">
    <div><h4 className="text-[14px] font-bold text-[#7B3F22]">Créditos manuales e incidencias</h4>
      <p className="mt-1">Aprobar un crédito no confirma pagos, no cambia categorías, no reactiva fichas y no renueva membresías. Solo el propietario de esta sede puede gestionar estos derechos; el servidor verifica su identidad y permiso.</p>
      <p className="break-all">Alumno: <code>{student.id}</code> · Sede: <code>{student.sedeId || 'Sin sede verificada'}</code></p></div>
    {error && <p role="alert" className="rounded-md border border-[#E8CABB] bg-[#FBF1EC] p-3 text-[#A85D3B]">{error}</p>}
    {pending && <div role="status" data-testid="pending-student-credit-operation" data-operation={pending.operation}
      className="space-y-2 rounded-md border border-[#DDBFA4] bg-[#F7F1EB] p-3">
      <p>Operación pendiente: {pending.operation === 'approve_manual' ? 'Aprobación de crédito manual' : pending.operation === 'settle_penalty' ? 'Descuento de incidencia' : 'Exención de incidencia'}. Se recuperan sus datos originales, sin generar otro intento.</p>
      {pending.penaltyId && <p className="break-all">Incidencia: <code>{pending.penaltyId}</code></p>}
      {pending.sessionId && <p className="break-all">Sesión: <code>{pending.sessionId}</code></p>}
      {pending.reason && <p className="break-words">Motivo original: {pending.reason}</p>}
      {onRetryPendingStudentCreditOperation && pending.studentId === student.id
        ? <button type="button" disabled={busy} className={buttonClass} onClick={() => void runOperation('retry')}>{busy ? 'Procesando operación...' : 'Reintentar operación pendiente'}</button>
        : <p>La recuperación no está disponible. No se pueden crear operaciones de reemplazo.</p>}
    </div>}
    <div className="rounded-md border border-[#E6D8CB] bg-white p-3" data-testid="legacy-credit-observation">
      <h5 className="font-bold text-[#7B3F22]">Observación del saldo legado</h5>
      <p>Saldo legado observado: {legacyBalance === null ? 'Desconocido / sin observación de origen' : legacyBalance}.</p>
      <p>{canReconcile ? 'Saldo positivo sin derecho administrado: requiere conciliación explícita.' : 'No hay saldo legado conciliable con los datos de origen disponibles.'} No se suma al registro de derechos manuales ni prueba un pago.</p>
      {(student.manualCredits || []).some(credit => credit.mode === 'reconcile_legacy') && <p>Este saldo ya fue conciliado. La observación original se conserva como historial, no como crédito adicional.</p>}
    </div>
    <div className="space-y-2" data-testid="manual-credit-ledger"><h5 className="font-bold text-[#7B3F22]">Derechos manuales aprobados</h5>
      {(student.manualCredits || []).length === 0 ? <p>Sin derechos manuales aprobados.</p> : student.manualCredits!.map(credit => <article key={credit.id}
        data-manual-credit-id={credit.id} className="min-w-0 space-y-1 rounded-md border border-[#E6D8CB] bg-white p-3 break-words">
        <p className="font-bold text-[#7B3F22]">{credit.mode === 'reconcile_legacy' ? 'Conciliación de saldo legado' : 'Nuevo crédito manual'} · {CREDIT_ACTIVITY_LABELS[credit.activity]}</p>
        <p>{credit.remainingClasses} restantes / {credit.allocatedClasses} aprobadas · {credit.startsOn} a {credit.endsOn}</p>
        <p className="break-all">Derecho: <code>{credit.id}</code> · Alumno: <code>{credit.studentId}</code> · Sede: <code>{credit.sedeId}</code></p>
        <p>Motivo: {credit.reason}</p><p>Evidencia / origen: {credit.evidence}</p>
        <p className="break-all">Aprobado por (ID de actor): <code>{credit.approvedBy}</code> · {credit.approvedAt}</p>
      </article>)}
    </div>
    {ownerHint ? <fieldset disabled={locked || !student.sedeId || !recoveryAvailable || !onApproveManualCredit} className="min-w-0 space-y-3 rounded-md border border-[#DDBFA4] p-3">
      <legend className="px-1 font-bold text-[#7B3F22]">Aprobación explícita de crédito manual</legend>
      {(!onApproveManualCredit || !recoveryAvailable) && <p>La aprobación o la recuperación segura no está disponible.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label>Modo del crédito manual<select aria-label="Modo del crédito manual" className={controlClass} value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as ManualCreditIntent['mode'] })}>
          <option value="new_manual">Nuevo crédito manual</option><option value="reconcile_legacy" disabled={!canReconcile}>Conciliar saldo legado</option>
        </select></label>
        <label>Actividad del crédito manual<select aria-label="Actividad del crédito manual" className={controlClass} value={draft.activity} onChange={event => setDraft({ ...draft, activity: event.target.value as ManualCreditIntent['activity'] })}>
          <option value="">Seleccionar actividad</option>{Object.entries(CREDIT_ACTIVITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Cantidad de clases manuales<input aria-label="Cantidad de clases manuales" className={controlClass} type="number" min="1" step="1" value={draft.quantity} onChange={event => setDraft({ ...draft, quantity: event.target.value })} /></label>
        <p>{draft.mode === 'reconcile_legacy' ? `La conciliación debe incluir el saldo legado completo (${legacyBalance ?? 'desconocido'} clases), no una cantidad parcial. ` : ''}La cantidad, actividad y vigencia requieren aprobación expresa. Las fechas propuestas son editables; no acreditan validez antes de aprobar.</p>
        <label>Inicio del crédito manual<input aria-label="Inicio del crédito manual" className={controlClass} type="date" value={draft.startsOn} onChange={event => setDraft({ ...draft, startsOn: event.target.value })} /></label>
        <label>Fin del crédito manual<input aria-label="Fin del crédito manual" className={controlClass} type="date" value={draft.endsOn} onChange={event => setDraft({ ...draft, endsOn: event.target.value })} /></label>
      </div>
      <label>Motivo del crédito manual<textarea aria-label="Motivo del crédito manual" maxLength={2000} className={`${controlClass} min-h-20 py-2`} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></label>
      <label>Evidencia / origen del crédito manual<textarea aria-label="Evidencia / origen del crédito manual" maxLength={10000} className={`${controlClass} min-h-20 py-2`} value={draft.evidence} onChange={event => setDraft({ ...draft, evidence: event.target.value })} /></label>
      <p>Motivo: máximo 2000 caracteres. Evidencia / origen: máximo 10000 caracteres.</p>
      <button type="button" disabled={!validDraft} className={`${buttonClass} bg-[#7B3F22] text-white hover:bg-[#63321C]`} onClick={() => void runOperation('approve_manual')}>Aprobar crédito manual</button>
    </fieldset> : <p>Solo lectura. La gestión corresponde al propietario de esta sede, no al rol de administrador ni al de superadministrador.</p>}
    <div className="space-y-2" data-testid="student-penalty-list"><h5 className="font-bold text-[#7B3F22]">Incidencias y derecho original</h5>
      <p>Solo se descuenta el derecho original. No se elige otro bono ni se usa el período actual como sustituto. Si no es utilizable, la incidencia permanece pendiente o el propietario puede eximirla. Eximir un cargo ya aplicado revierte únicamente su derecho original, con validación del servidor.</p>
      {(student.pendingPenalties || []).length === 0 ? <p>Sin incidencias registradas.</p> : student.pendingPenalties!.map(penalty => {
        const sources = [['Período original', penalty.originalPeriodId], ['Gift Card original', penalty.originalGiftCardId], ['Crédito manual original', penalty.originalManualCreditId]].filter(([, id]) => !!id);
        const identityAvailable = !!penalty.id && penalty.studentId === student.id && !!student.sedeId && penalty.sedeId === student.sedeId
          && !!penalty.sessionId && Number.isSafeInteger(penalty.sessionRevision) && penalty.sessionRevision! >= 0;
        const validReason = !!reasons[penalty.id]?.trim() && reasons[penalty.id].trim().length <= 2000;
        return <article key={penalty.id} data-penalty-id={penalty.id} data-penalty-state={penalty.state} className="min-w-0 space-y-2 rounded-md border border-[#E6D8CB] bg-white p-3 break-words">
          <p className="font-bold text-[#7B3F22]">{penalty.kind === 'no_show' ? 'Falta sin asistencia' : 'Cancelación tardía'} · {penalty.state === 'pending' ? 'Pendiente de resolución' : penalty.state === 'charged' ? 'Descuento aplicado' : 'Eximida'}</p>
          <p>{penalty.sessionDate} · {penalty.sessionStart} · Revisión de sesión: {penalty.sessionRevision ?? 'Sin revisión'}</p>
          <p className="break-all">Incidencia: <code>{penalty.id}</code> · Sesión: <code>{penalty.sessionId}</code> · Alumno: <code>{penalty.studentId}</code> · Sede: <code>{penalty.sedeId}</code></p>
          <div data-testid="penalty-original-source">{sources.length ? sources.map(([label, id]) => <p key={label} className="break-all">{label}: <code>{id}</code></p>) : <p>Sin derecho original atribuible. No se sustituye por el saldo actual.</p>}</div>
          <p>Motivo registrado: {penalty.reason}</p>
          {(penalty.settlementId || penalty.settlementReason || penalty.settledBy || penalty.settledAt) && <div data-testid="penalty-settlement-audit" className="space-y-1 border-t border-[#E6D8CB] pt-2">
            <p className="font-bold text-[#7B3F22]">Liquidación registrada</p>
            {penalty.settlementId && <p className="break-all">Liquidación: <code>{penalty.settlementId}</code></p>}
            {penalty.settlementReason && <p>Motivo de liquidación: {penalty.settlementReason}</p>}
            {penalty.settledBy && <p className="break-all">Aplicada por (ID de actor): <code>{penalty.settledBy}</code></p>}
            {penalty.settledAt && <p>Fecha de liquidación: {penalty.settledAt}</p>}
          </div>}
          {penalty.blockedReason && <p>{penalty.blockedReason}</p>}
          {penalty.state === 'pending' && <p>La disponibilidad indicada se calcula en la aplicación sobre el derecho original; no concede permiso ni garantiza un cargo. El servidor valida la operación final.{penalty.canSettle !== true ? ' El descuento no está disponible con los datos actuales.' : ''}</p>}
          {ownerHint && (penalty.state === 'pending' || (penalty.state === 'charged' && onWaivePendingPenalty)) && <fieldset disabled={locked || !identityAvailable || !recoveryAvailable} className="min-w-0 space-y-2 border-0 p-0">
            <label>Motivo de resolución<input aria-label={`Motivo de resolución ${penalty.id}`} maxLength={2000} className={controlClass} value={reasons[penalty.id] || ''} onChange={event => setReasons({ ...reasons, [penalty.id]: event.target.value })} /></label>
            <p>Motivo obligatorio: máximo 2000 caracteres.</p>
            <div className="flex flex-wrap gap-2">{penalty.state === 'pending' && <button type="button" className={buttonClass} disabled={!onSettlePendingPenalty || penalty.canSettle !== true || sources.length !== 1 || !validReason} onClick={() => void runOperation('settle_penalty', penalty.id)}>Aplicar descuento pendiente</button>}
              {onWaivePendingPenalty && <button type="button" className={buttonClass} disabled={!validReason} onClick={() => void runOperation('waive_penalty', penalty.id)}>Eximir incidencia</button>}</div>
            {penalty.state === 'pending' && !onSettlePendingPenalty && <p>La liquidación no está disponible.</p>}
          </fieldset>}
        </article>;
      })}
    </div>
  </section>;
};

type TabType = 'all' | 'active' | 'pending' | 'expired';
type CategoryFilter = 'todos' | 'membresia' | 'temporal' | 'archivados';
type MembershipTierFilter = 'todos' | MembershipTier;

const CATEGORY_LABELS: Record<string, string> = {
  membresia: 'Membresía',
  temporal: 'Bonos temporales',
  archivados: 'Archivados'
};

const getMonthKey = (date: string) => date.slice(0, 7);

const formatMonthLabel = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
};

const getMonthCalendarDays = (monthKey: string): Array<number | null> => {
  const [year, month] = monthKey.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  return [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1)
  ];
};

const StudentList: React.FC<StudentListProps> = ({
  students,
  detailsLoading = false,
  onAddStudent,
  onRenew,
  onConfirmPayment, onActivateMembership, onInitializeLegacyMemberships, onAdjustClasses, canAdjustClasses = true,
  onUpdate,
  onDeleteStudent,
  selectedStudentId,
  onClearSelectedStudent,
  onApproveManualCredit, onSettlePendingPenalty, onWaivePendingPenalty, canManageStudentCredits,
  getPendingStudentCreditOperation, onRetryPendingStudentCreditOperation
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('all');
  // La primera vista prioriza las membresías: es el grupo operativo más
  // frecuente y permite pintar una página pequeña sin esperar todo el detalle.
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('membresia');
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [membershipTierFilter, setMembershipTierFilter] = useState<MembershipTierFilter>('todos');
  const [showLegacyInitialization, setShowLegacyInitialization] = useState(false);
  const [initializingLegacy, setInitializingLegacy] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showPersonalInfo, setShowPersonalInfo] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [studentToDelete, setStudentToDelete] = useState<string | null>(null);
  const [studentToArchive, setStudentToArchive] = useState<string | null>(null);
  const [pendingCategory, setPendingCategory] = useState<'membresia' | 'temporal' | null>(null);
  const [pendingMembershipTier, setPendingMembershipTier] = useState<MembershipTier | null>(null);
  const today = useWorkshopDate();
  const currentMonthKey = getMonthKey(today);
  const [expandedAttendanceMonth, setExpandedAttendanceMonth] = useState(currentMonthKey);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingIntents = useRef(new PendingMembershipIntentStore());
  const renewalIntentRef = useRef<RenewalIntent | null>(null);
  const adjustmentIntentRef = useRef<ClassAdjustmentIntent | null>(null);
  const [renewalTier, setRenewalTier] = useState<MembershipTier>('gold');
  const [adjustmentDelta, setAdjustmentDelta] = useState(-1);
  const [adjustmentNeedsReview, setAdjustmentNeedsReview] = useState(false);
  const managedEdit = Boolean(editingStudent && isManagedMembership(editingStudent));
  const liveEditingStudent = students.find(student => student.id === editingStudent?.id) || editingStudent;

  const [form, setForm] = useState({
    name: '',
    surname: '',
    email: '',
    phone: '',
    notes: '',
    observations: '',
    classesRemaining: 4,
    price: MEMBERSHIP_PLANS.gold.price,
    paymentStatus: DEFAULT_STUDENT_PAYMENT_STATUS as 'paid' | 'pending' | 'unknown',
    classType: 'Modelado',
    expiryDate: addMembershipMonth(today),
    assignedClasses: [] as AssignedClass[],
    studentCategory: 'membresia' as NonNullable<Student['studentCategory']>,
    membershipTier: 'gold' as MembershipTier,
    membershipActivatedAt: '',
    groupName: '',
    bonosAsignados: 4,
    repetirMensualmente: false
  });

  const [newSessionDate, setNewSessionDate] = useState('');
  const [newSessionTime, setNewSessionTime] = useState('10:00');

  useEffect(() => {
    if (!selectedStudentId) return;
    const student = students.find(s => s.id === selectedStudentId);
    if (!student) return;
    handleEditClick(student);
    if (onClearSelectedStudent) onClearSelectedStudent();
  }, [selectedStudentId, students, onClearSelectedStudent]);

  const getCalculatedStatus = (studentData: typeof form) => {
    if (studentData.studentCategory === 'temporal') return 'new';
    if (!studentData.expiryDate || studentData.expiryDate < today || studentData.paymentStatus === 'pending') {
      return 'needs_renewal';
    }
    return 'membresia';
  };

  const handleEditClick = (student: Student) => {
    setEditingStudent(student);
    renewalIntentRef.current = pendingIntents.current.get<RenewalIntent>(`renew:${student.id}`);
    adjustmentIntentRef.current = pendingIntents.current.get<ClassAdjustmentIntent>(`adjust:${student.id}`);
    setAdjustmentNeedsReview(false);
    setAdjustmentDelta(adjustmentIntentRef.current?.delta ?? -1);
    setRenewalTier(renewalIntentRef.current?.membershipTier ?? inferMembershipTier(student.membershipTier, student.price));
    setShowPersonalInfo(false);
    const membershipTier = inferMembershipTier(student.membershipTier, student.price);
    const isTemporal = student.studentCategory === 'temporal';
    const assignedBonuses = student.bonosAsignados ?? (isTemporal ? 1 : MEMBERSHIP_PLANS[membershipTier].bonuses);
    setForm({
      name: student.name,
      surname: student.surname || '',
      email: student.email || '',
      phone: student.phone,
      notes: student.notes || '',
      observations: student.observations || '',
      classesRemaining: student.classesRemaining,
      price: student.price ?? (isTemporal ? 0 : MEMBERSHIP_PLANS[membershipTier].price),
      paymentStatus: getStudentPaymentStatus(student),
      classType: student.classType || 'Modelado',
      expiryDate: student.expiryDate || '',
      assignedClasses: student.assignedClasses || [],
      studentCategory: student.studentCategory || 'membresia',
      membershipTier,
      membershipActivatedAt: student.membershipActivatedAt || '',
      groupName: student.groupName || '',
      bonosAsignados: assignedBonuses,
      repetirMensualmente: isTemporal ? false : (student.repetirMensualmente ?? false)
    });
    setShowModal(true);
  };

  const handleCreateClick = () => {
    setEditingStudent(null);
    setShowPersonalInfo(false);
    const nextMonth = addMembershipMonth(today);
    setForm({
      name: '', surname: '', email: '', phone: '', notes: '', observations: '',
      classesRemaining: MEMBERSHIP_PLANS.gold.bonuses, price: MEMBERSHIP_PLANS.gold.price, paymentStatus: DEFAULT_STUDENT_PAYMENT_STATUS, classType: 'Modelado',
      expiryDate: nextMonth, assignedClasses: [],
      studentCategory: 'membresia', membershipTier: 'gold', membershipActivatedAt: getWorkshopDate(), groupName: '', bonosAsignados: MEMBERSHIP_PLANS.gold.bonuses, repetirMensualmente: false
    });
    setShowModal(true);
  };

  const applyCategoryChange = (category: 'membresia' | 'temporal') => {
    const plan = MEMBERSHIP_PLANS[form.membershipTier];
    setForm(current => ({
      ...current,
      studentCategory: category,
      bonosAsignados: category === 'temporal' ? 1 : plan.bonuses,
      classesRemaining: category === 'temporal' ? Math.min(1, current.classesRemaining) : Math.min(plan.bonuses, current.classesRemaining),
      repetirMensualmente: category === 'membresia' ? current.repetirMensualmente : false
    }));
    setPendingCategory(null);
  };

  const requestCategoryChange = (category: 'membresia' | 'temporal') => {
    if (category === form.studentCategory) return;
    setPendingCategory(category);
  };

  const applyMembershipTierChange = (tier: MembershipTier) => {
    const plan = MEMBERSHIP_PLANS[tier];
    setForm(current => ({
      ...current,
      membershipTier: tier,
      price: plan.price,
      bonosAsignados: plan.bonuses,
      classesRemaining: editingStudent ? Math.min(current.classesRemaining, plan.bonuses) : plan.bonuses
    }));
    setPendingMembershipTier(null);
  };

  const requestMembershipTierChange = (tier: MembershipTier) => {
    if (tier === form.membershipTier) return;
    setPendingMembershipTier(tier);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.name.trim()) {
      showError('El nombre es obligatorio.');
      return;
    }
    const isMembership = form.studentCategory === 'membresia';
    const plan = MEMBERSHIP_PLANS[form.membershipTier];
    const membershipActivatedAt = form.membershipActivatedAt || editingStudent?.membershipActivatedAt || editingStudent?.createdAt?.split('T')[0] || getWorkshopDate();
    const { assignedClasses: _assignedClasses, ...studentForm } = form;
    const data = {
      ...studentForm,
      price: isMembership ? plan.price : form.price,
      bonosAsignados: isMembership ? form.bonosAsignados : Math.min(Math.max(1, editingStudent?.studentCategory === 'temporal' ? editingStudent.bonosAsignados ?? 1 : 1), Math.max(1, form.bonosAsignados)),
      classesRemaining: Math.max(0, form.classesRemaining),
      repetirMensualmente: isMembership ? form.repetirMensualmente : false,
      membershipTier: isMembership ? form.membershipTier : undefined,
      membershipActivatedAt: isMembership ? membershipActivatedAt : undefined,
      archivedAt: editingStudent?.archivedAt,
      status: getCalculatedStatus(form) as Student['status'],
      groupName: ''
    };
    setIsSubmitting(true);
    try {
      if (editingStudent?.id) {
        if (managedEdit) {
          if (form.classesRemaining !== editingStudent.classesRemaining || form.bonosAsignados !== (editingStudent.bonosAsignados ?? MEMBERSHIP_PLANS[form.membershipTier].bonuses) ||
              form.expiryDate !== (editingStudent.expiryDate || '') || form.membershipTier !== inferMembershipTier(editingStudent.membershipTier, editingStudent.price) ||
              form.price !== (editingStudent.price ?? MEMBERSHIP_PLANS[form.membershipTier].price) || form.studentCategory !== (editingStudent.studentCategory ?? 'membresia') ||
              form.paymentStatus !== getStudentPaymentStatus(editingStudent)) throw new Error('Los datos de período no se pueden editar desde el perfil.');
          await onUpdate(editingStudent.id, { name: form.name, surname: form.surname, email: form.email,
            phone: form.phone, notes: form.notes, observations: form.observations, classType: form.classType });
        } else {
          await onUpdate(editingStudent.id, { ...data, studentCategory: editingStudent.studentCategory,
            paymentStatus: form.paymentStatus === 'unknown' ? null : form.paymentStatus });
        }
      } else {
        await onAddStudent({ ...data, paymentStatus: 'pending' });
      }
      setShowModal(false);
      setEditingStudent(null);
    } catch (error: any) { showError(error.message || 'No se pudo guardar el alumno.'); }
    finally { setIsSubmitting(false); }
  };

  const handleRenewMembership = async () => {
    if (!editingStudent || isSubmitting) return;
    setIsSubmitting(true);
    try {
      renewalIntentRef.current ||= createRenewalIntent(editingStudent.id, renewalTier);
      pendingIntents.current.set(`renew:${editingStudent.id}`, renewalIntentRef.current);
      await onRenew(renewalIntentRef.current);
      pendingIntents.current.clear(`renew:${editingStudent.id}`);
      renewalIntentRef.current = null;
      setShowModal(false);
      setEditingStudent(null);
    } catch (error: any) { showError(error.message || 'No se pudo renovar. Reintenta el mismo intento.'); }
    finally { setIsSubmitting(false); }
  };

  const runMembershipAction = async (action: () => Promise<void>) => {
    setIsSubmitting(true);
    try { await action(); }
    catch (error: any) { showError(error.message || 'La operación falló.'); }
    finally { setIsSubmitting(false); }
  };

  const handleAddSession = () => {
    if (!newSessionDate) return;
    const [h, m] = newSessionTime.split(':').map(Number);
    const endTime = `${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    setForm(prev => ({
      ...prev,
      assignedClasses: [...prev.assignedClasses, { date: newSessionDate, startTime: newSessionTime, endTime, status: 'pending' }]
    }));
    setNewSessionDate('');
  };

  const attendanceByMonth = useMemo(() => {
    return form.assignedClasses.reduce<Record<string, AssignedClass[]>>((groups, attendance) => {
      const monthKey = getMonthKey(attendance.date);
      if (!groups[monthKey]) groups[monthKey] = [];
      groups[monthKey].push(attendance);
      return groups;
    }, {});
  }, [form.assignedClasses]);

  const attendanceMonths = Object.keys(attendanceByMonth).sort((a, b) => b.localeCompare(a));
  const previousAttendanceMonths = attendanceMonths.filter(month => month !== currentMonthKey).slice(0, 3);
  const currentMonthAttendance = attendanceByMonth[currentMonthKey] || [];
  const currentAttendanceByDate = currentMonthAttendance.reduce<Record<string, AssignedClass[]>>((groups, attendance) => {
    if (!groups[attendance.date]) groups[attendance.date] = [];
    groups[attendance.date].push(attendance);
    return groups;
  }, {});

  const filteredStudents = useMemo(() => {
    return students.filter(s => {
      const archived = isStudentArchived(s, today);
      const lifecycle = getStudentLifecycle(s, today);
      const fullName = `${s.name} ${s.surname || ''}`.trim().toLowerCase();
      const matchesSearch = !searchQuery.trim() || fullName.includes(searchQuery.trim().toLowerCase());
      const cat = s.studentCategory || 'membresia';
      const matchesCategory = categoryFilter === 'todos' || cat === categoryFilter;
      const membershipTier = inferMembershipTier(s.membershipTier, s.price);
      const matchesTier = categoryFilter !== 'membresia' || membershipTierFilter === 'todos' || membershipTier === membershipTierFilter;
      if (categoryFilter === 'archivados') return archived && matchesSearch;
      if (archived || !matchesSearch || !matchesCategory || !matchesTier) return false;
      if (activeTab === 'expired') return lifecycle === 'expired';
      if (activeTab === 'pending') return lifecycle === 'pending';
      if (activeTab === 'active') return lifecycle === 'active';
      return matchesSearch && matchesCategory && matchesTier;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [students, activeTab, searchQuery, categoryFilter, membershipTierFilter, today]);

  useEffect(() => {
    setVisibleLimit(50);
  }, [activeTab, categoryFilter, membershipTierFilter, searchQuery]);

  const visibleStudents = useMemo(() => filteredStudents.slice(0, visibleLimit), [filteredStudents, visibleLimit]);
  const hasMoreStudents = visibleStudents.length < filteredStudents.length;

  const suggestions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return students
      .map(s => `${s.name} ${s.surname || ''}`.trim())
      .filter(name => name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [students, searchQuery]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { todos: 0, membresia: 0, temporal: 0, archivados: 0 };
    students.forEach(s => {
      const cat = s.studentCategory || 'membresia';
      if (isStudentArchived(s, today)) counts.archivados++;
      else {
        counts.todos++;
        if (cat === 'membresia') counts.membresia++;
        if (cat === 'temporal') counts.temporal++;
      }
    });
    return counts;
  }, [students, today]);
  const legacyMembershipCount = useMemo(() => students.filter(student =>
    (student.studentCategory || 'membresia') === 'membresia'
    && !student.effectivePeriodId && !student.materializedPeriodId && !student.membershipPeriods?.length
  ).length, [students]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F7F3EF] text-neutral-textMain" style={{ fontFamily: "'Outfit', sans-serif" }}>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 sm:px-6 lg:px-10 pt-5 sm:pt-7 pb-24">
        <div className="max-w-[1280px] mx-auto">
          <header className="animate-fade-in">
            <div className="flex items-start justify-between gap-4">
              <div>
                 <h1 className="ui-page-title text-[#7B3F22]" style={{ fontFamily: "'Outfit', sans-serif" }}>Alumnos</h1>
                 <p className="ui-secondary mt-2">Personas, bonos y actividad del taller.</p>
              </div>
              <button onClick={handleCreateClick} className="shrink-0 flex items-center gap-2 h-10 px-3 sm:px-4 bg-[#7B3F22] text-white rounded-lg text-[11px] font-bold uppercase tracking-[0.12em] hover:bg-[#63321C] focus:outline-none focus:ring-2 focus:ring-[#C68952]/50 transition-colors" aria-label="Crear nuevo alumno">
                <span className="text-lg leading-none">+</span><span className="hidden sm:inline">Nuevo alumno</span><span className="sm:hidden">Nuevo</span>
              </button>
            </div>
          </header>

          <div className="mt-5 flex items-center gap-6 border-y border-[#DDBFA4]/70 py-3.5 text-[13px]" aria-label="Resumen de alumnos">
              <span><strong className="mr-1.5 text-[28px] leading-none font-bold text-[#F18B4B]">{categoryCounts.membresia}</strong><span className="font-medium text-neutral-textSec">membresías</span></span>
              <span className="h-5 w-px bg-neutral-border" />
              <span><strong className="mr-1.5 text-[28px] leading-none font-bold text-[#F18B4B]">{categoryCounts.temporal}</strong><span className="font-medium text-neutral-textSec">bonos temporales</span></span>
          </div>

          <section className="mb-4 pt-4" aria-label="Filtros de alumnos">
            <div className="relative">
              <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
              <input value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true); }} onFocus={() => setShowSuggestions(true)} onBlur={() => setTimeout(() => setShowSuggestions(false), 150)} placeholder="Buscar por nombre o apellidos" aria-label="Buscar alumno por nombre o apellidos" className="w-full h-12 pl-10 pr-10 bg-white border border-[#CFCAC5] rounded-xl text-[15px] text-[#7B3F22] placeholder:text-[#8B6B5E]/70 outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15 transition-all" />
              {searchQuery && <button type="button" onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B6B5E] hover:text-[#7B3F22]" aria-label="Limpiar búsqueda">×</button>}
              {showSuggestions && suggestions.length > 0 && <div className="absolute left-0 right-0 mt-1 bg-white border border-[#DDBFA4] rounded-lg shadow-[0_8px_24px_rgba(123,63,34,0.12)] z-20 overflow-hidden">{suggestions.map(name => <button key={name} onMouseDown={() => { setSearchQuery(name); setShowSuggestions(false); }} className="w-full text-left px-4 py-3 text-[13px] text-[#7B3F22] hover:bg-[#F7F1EB] border-b last:border-0 border-[#F0E5DB]">{name}</button>)}</div>}
            </div>
            <div className="mt-4 border-t border-[#E5DED8] pt-4">
              <div className="flex gap-2 overflow-x-auto no-scrollbar" role="tablist" aria-label="Categoría de alumnos">
                {(['membresia', 'temporal', 'archivados'] as CategoryFilter[]).map(cat => <button key={cat} onClick={() => { setCategoryFilter(cat); setActiveTab('all'); }} className={`shrink-0 rounded-lg border px-3.5 py-2 text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${categoryFilter === cat ? 'border-[#E99A65] bg-[#FFF6EE] text-[#7B3F22]' : 'border-[#E1DDD9] bg-white text-[#8B6B5E] hover:border-[#C68952]'}`}>{CATEGORY_LABELS[cat]} <span className="ml-1 opacity-60">{categoryCounts[cat] || 0}</span></button>)}
              </div>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                {categoryFilter === 'membresia' && <label className="relative shrink-0"><span className="sr-only">Elegir plan</span><select value={membershipTierFilter} onChange={(event) => setMembershipTierFilter(event.target.value as MembershipTierFilter)} className="h-10 min-w-[190px] appearance-none border border-[#CFCAC5] bg-white px-3 pr-9 text-[13px] text-[#6F6A66] outline-none focus:border-[#C68952]"><option value="todos">Elegir plan</option>{(['plata', 'gold', 'platinum'] as MembershipTierFilter[]).map(tier => <option key={tier} value={tier}>{MEMBERSHIP_PLANS[tier].label}</option>)}</select><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8B6B5E]">⌄</span></label>}
                <div className="flex min-w-0 items-center overflow-x-auto no-scrollbar" role="tablist" aria-label="Estado de alumnos">
                  {(['all', 'active', 'pending', 'expired'] as TabType[]).map((tab, index) => <React.Fragment key={tab}>{index > 0 && <span className="mx-2 h-5 w-px shrink-0 bg-[#9E9892]" aria-hidden="true" />}<button type="button" onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} className={`shrink-0 py-2 text-[12px] font-bold uppercase tracking-[0.12em] transition-colors ${activeTab === tab ? 'text-[#7B3F22]' : 'text-[#8B6B5E] hover:text-[#7B3F22]'}`}>{tab === 'all' ? 'Todos' : tab === 'active' ? 'Al día' : tab === 'expired' ? 'Vencidas' : 'Pendientes'}</button></React.Fragment>)}
                </div>
              </div>
            </div>
          </section>

          {legacyMembershipCount > 0 && onInitializeLegacyMemberships && <div className="mb-4 flex flex-col gap-2 rounded-lg border border-[#E8CABB] bg-[#FBF1EC] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-[#7B3F22]">Hay {legacyMembershipCount} membresías antiguas sin período inicializado.</p>
            <button type="button" onClick={() => setShowLegacyInitialization(true)} className="min-h-10 shrink-0 rounded-md bg-[#7B3F22] px-3 py-2 text-[12px] font-bold text-white hover:bg-[#63321C]">Inicializar períodos</button>
          </div>}

           <div className="bg-white border border-[#DDBFA4] rounded-xl overflow-hidden">
             <div className="hidden md:grid grid-cols-[minmax(260px,1.8fr)_1fr_110px_118px] gap-4 px-5 py-3 border-b border-[#EDE2D8] text-[12px] font-bold uppercase tracking-[0.1em] text-[#8B6B5E]"><span>Alumno</span><span>Actividad</span><span>Bonos</span><span>Estado</span></div>
            {detailsLoading && <div className="flex items-center gap-2 border-b border-[#EDE2D8] bg-[#FFF9F4] px-5 py-2.5 text-[12px] text-[#8B6B5E]" role="status"><span className="h-2 w-2 animate-pulse rounded-full bg-[#C68952]" />Cargando bonos y detalles en segundo plano…</div>}
            {filteredStudents.length === 0 ? <div className="px-6 py-16 text-center"><p className="text-[15px] text-[#7B3F22]" style={{ fontFamily: "'Outfit', sans-serif" }}>No hay alumnos que mostrar</p><p className="text-[12px] text-[#8B6B5E] mt-1">Prueba a cambiar la búsqueda o los filtros.</p></div> : visibleStudents.map(s => {
              const isArchived = isStudentArchived(s, today);
              const lifecycle = getStudentLifecycle(s, today);
              const isPending = lifecycle === 'pending';
              const isExpired = lifecycle === 'expired';
              const cat = s.studentCategory || 'membresia';
              const membershipTier = inferMembershipTier(s.membershipTier, s.price);
              const initials = `${s.name.charAt(0)}${s.surname?.charAt(0) || ''}`.toUpperCase();
              const percentage = Math.min(100, (s.classesRemaining / (s.bonosAsignados || 4)) * 100);
               return <button key={s.id} data-student-id={s.id} onClick={() => handleEditClick(s)} className="ui-list w-full text-left grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(260px,1.8fr)_1fr_110px_118px] gap-3 md:gap-4 items-center px-4 md:px-5 py-3.5 border-b last:border-0 border-[#EDE2D8] hover:bg-[#FCF8F4] focus:outline-none focus:bg-[#FCF8F4] transition-colors group">
                  <div className="flex items-center gap-3 min-w-0"><span className="w-11 h-11 shrink-0 rounded-full bg-[#F0E2D6] text-[#7B3F22] flex items-center justify-center text-[12px] font-bold">{initials}</span><span className="min-w-0"><strong className="ui-card-title block text-[#7B3F22] truncate group-hover:text-[#C68952] transition-colors">{s.name} {s.surname}</strong><span className="ui-meta block truncate">{s.phone || s.email || 'Sin contacto añadido'}</span><span className="ui-meta md:hidden block mt-1">{s.classType || 'Sin actividad'} · {isArchived ? CATEGORY_LABELS.archivados : CATEGORY_LABELS[cat] || cat}</span></span></div>
                  <div className="hidden md:block min-w-0"><span className="ui-data block text-[#7B3F22] truncate">{s.classType || 'Sin actividad'}</span><span className="inline-flex mt-1 px-2 py-0.5 rounded border border-[#DDBFA4] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8B6B5E]">{isArchived ? CATEGORY_LABELS.archivados : cat === 'membresia' ? MEMBERSHIP_PLANS[membershipTier].label : CATEGORY_LABELS[cat] || cat}</span></div>
                  <div className="text-right md:text-left"><strong className={`text-[16px] tabular-nums ${isPending ? 'text-[#A85D3B]' : 'text-[#7B3F22]'}`}>{s.classesRemaining}<span className="ui-meta font-normal">/{s.bonosAsignados || 4}</span></strong><div className="w-16 h-1 bg-[#F0E5DB] rounded-full overflow-hidden mt-1 ml-auto md:ml-0"><span className={`block h-full ${isPending ? 'bg-[#C68952]' : 'bg-[#7B3F22]'}`} style={{ width: `${percentage}%` }} /></div></div>
                  <span className={`hidden md:inline-flex justify-center px-2 py-1 rounded text-[12px] font-bold uppercase tracking-[0.06em] border ${isArchived ? 'bg-[#F0E5DB] text-[#8B6B5E] border-[#DDBFA4]' : isPending ? 'bg-[#FBF1EC] text-[#A85D3B] border-[#E8CABB]' : 'bg-[#F5F1E9] text-[#7B3F22] border-[#D8CDBE]'}`}>{isArchived ? 'Archivado' : cat === 'temporal' ? 'Bonos temporales' : isExpired ? 'Vencida' : isPending ? 'Pendiente' : 'Activo'}</span>
              </button>;
            })}
            {hasMoreStudents && <div className="flex justify-center border-t border-[#EDE2D8] px-4 py-4"><button type="button" onClick={() => setVisibleLimit(limit => limit + 50)} className="min-h-10 rounded-lg border border-[#C68952] bg-white px-4 py-2 text-[12px] font-bold text-[#7B3F22] hover:bg-[#F7F1EB]">Cargar más alumnos ({filteredStudents.length - visibleStudents.length} restantes)</button></div>}
          </div>
        </div>
      </div>

      {showModal && <div className="fixed inset-0 bg-[#4B2A1D]/45 backdrop-blur-[2px] z-[100] flex items-end md:items-center justify-center overflow-hidden">
        <div className="bg-[#FDFBF9] w-full md:max-w-5xl h-[100dvh] md:h-auto md:max-h-[92dvh] md:rounded-xl shadow-[0_20px_60px_rgba(75,42,29,0.2)] relative flex flex-col overflow-hidden animate-fade-in">
          <div className="px-4 sm:px-7 py-4 border-b border-[#E6D8CB] flex items-center justify-between shrink-0 bg-[#FDFBF9]"><div className="flex items-center gap-3 min-w-0"><span className="hidden sm:flex w-10 h-10 rounded-full bg-[#F0E2D6] text-[#7B3F22] items-center justify-center text-[12px] font-bold">{editingStudent ? `${editingStudent.name.charAt(0)}${editingStudent.surname?.charAt(0) || ''}` : '+'}</span><div className="min-w-0"><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8B6B5E]">{editingStudent ? 'Perfil del alumno' : 'Nuevo alumno'}</p><h3 className="text-[20px] text-[#7B3F22] truncate" style={{ fontFamily: "'Outfit', sans-serif" }}>{editingStudent ? `${editingStudent.name} ${editingStudent.surname || ''}`.trim() : 'Crear ficha'}</h3></div></div><button onClick={() => setShowModal(false)} className="w-9 h-9 rounded-md border border-[#DDBFA4] text-[#8B6B5E] flex items-center justify-center hover:bg-[#F0E2D6] hover:text-[#7B3F22] transition-colors" aria-label="Cerrar ficha"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 6l12 12M18 6 6 18" /></svg></button></div>

            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 pb-28 sm:px-7 md:pb-28"><form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 py-5 md:py-6 lg:grid-cols-[1.2fr_1fr] lg:gap-8">
              <div className="space-y-5">
               <section><button type="button" onClick={() => setShowPersonalInfo(value => !value)} aria-expanded={showPersonalInfo} className="w-full flex items-center justify-between gap-3 mb-3 text-left"><span><h4 className="text-[14px] font-bold text-[#7B3F22]">Información personal</h4><span className="text-[11px] text-[#8B6B5E]">Datos de contacto</span></span><span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#8B6B5E]">{showPersonalInfo ? 'Ocultar' : 'Mostrar'} <span className="ml-1">{showPersonalInfo ? '−' : '+'}</span></span></button>{showPersonalInfo && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre" aria-label="Nombre" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /><input value={form.surname} onChange={(e) => setForm({ ...form, surname: e.target.value })} placeholder="Apellidos" aria-label="Apellidos" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" aria-label="Email" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15 sm:col-span-2" /><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Teléfono" aria-label="Teléfono" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15 sm:col-span-2" /></div>}</section>
               <section className="border-t border-[#E6D8CB] pt-3"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-2">Actividad y categoría</h4><div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5"><select value={form.classType} onChange={(e) => setForm({ ...form, classType: e.target.value })} aria-label="Tipo de clase" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option>Modelado</option><option>Torno</option><option>Coworking</option><option>Iniciación</option></select><select disabled={!!editingStudent} value={form.studentCategory} onChange={(e) => requestCategoryChange(e.target.value as 'membresia' | 'temporal')} aria-label="Categoría del alumno" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option value="membresia">Membresía</option><option value="temporal">Bonos temporales</option><option value="grupal">Grupal</option><option value="grupo_temporal">Grupo temporal</option></select><select disabled={managedEdit || !editingStudent} value={form.paymentStatus} onChange={(e) => setForm({ ...form, paymentStatus: e.target.value as 'paid' | 'pending' })} aria-label="Estado del pago" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option value="unknown">Pago desconocido</option><option value="paid">Pago al día</option><option value="pending">Pago pendiente</option></select><input disabled={managedEdit || form.studentCategory === 'membresia'} type="number" value={form.price} onChange={(e) => setForm({ ...form, price: parseInt(e.target.value) })} placeholder="Cuota" aria-label="Cuota" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952]" /></div></section>
                {form.studentCategory === 'membresia' && <div className="grid grid-cols-3 gap-1.5 mt-2">
                    {(['plata', 'gold', 'platinum'] as MembershipTier[]).map(tier => <button key={tier} type="button" disabled={managedEdit} onClick={() => requestMembershipTierChange(tier)} className={`min-h-11 rounded-lg border px-2 text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${form.membershipTier === tier ? 'border-brand bg-brand text-white shadow-sm' : 'border-neutral-border bg-white text-neutral-textMain hover:border-brand hover:text-brand'}`}><span>{MEMBERSHIP_PLANS[tier].label}</span><span className={`block text-[11px] font-medium normal-case tracking-normal ${form.membershipTier === tier ? 'text-white/90' : 'text-neutral-textSec'}`}>{MEMBERSHIP_PLANS[tier].price}€ · {MEMBERSHIP_PLANS[tier].bonuses} bonos</span></button>)}
               </div>}

               <fieldset disabled={managedEdit || form.studentCategory === 'membresia'} className="border-t border-[#E6D8CB] pt-3">
                 <div className="flex items-baseline justify-between mb-2">
                  <h4 className="text-[14px] font-bold text-[#7B3F22]">Bonos</h4>
                </div>
                 <div className="grid grid-cols-2 gap-1.5">
                  <div>
                      <label className="block text-[16px] font-medium text-[#7B3F22] mb-1">Bonos contratados</label>
                     <div className="flex items-center bg-white border border-[#E7B899] rounded-md overflow-hidden h-10">
                       <button type="button" onClick={() => setForm(f => ({ ...f, bonosAsignados: Math.max(1, f.bonosAsignados - 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Reducir bonos">-</button>
                      <input type="number" readOnly value={form.bonosAsignados} aria-label="Bonos contratados" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                       <button type="button" onClick={() => setForm(f => ({ ...f, bonosAsignados: Math.min(f.studentCategory === 'temporal' ? Math.max(1, editingStudent?.studentCategory === 'temporal' ? editingStudent.bonosAsignados ?? 1 : 1) : MEMBERSHIP_PLANS[f.membershipTier].bonuses, f.bonosAsignados + 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Aumentar bonos">+</button>
                    </div>
                  </div>
                  <div>
                     <div className="flex items-center justify-between mb-1"><label className="block text-[16px] font-medium text-[#7B3F22]">Bonos restantes</label><span className="text-[11px] font-bold text-[#A85D3B]">{form.classesRemaining}/{form.bonosAsignados}</span></div>
                     <div className="flex items-center bg-white border border-[#E7B899] rounded-md overflow-hidden h-10">
                       <button type="button" onClick={() => setForm(f => ({ ...f, classesRemaining: Math.max(0, f.classesRemaining - 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Reducir clases restantes">-</button>
                      <input type="number" readOnly value={form.classesRemaining} aria-label="Bonos restantes" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                        <button type="button" onClick={() => setForm(f => ({ ...f, classesRemaining: Math.min(f.bonosAsignados, f.classesRemaining + 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Aumentar clases restantes">+</button>
                    </div>
                  </div>
                </div>
                 <div className="h-1 bg-[#F0E5DB] rounded-full overflow-hidden mt-2"><div className={`h-full ${form.classesRemaining <= 0 ? 'bg-[#A85D3B]' : 'bg-[#7B3F22]'}`} style={{ width: `${Math.min(100, (form.classesRemaining / form.bonosAsignados) * 100)}%` }} /></div>
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2">
                   <input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} aria-label="Fecha de vencimiento de membresía" className="h-10 px-2.5 bg-white border border-[#E7B899] rounded-md text-[12px] text-[#A85D3B] outline-none focus:border-[#C68952]" />
                    {form.studentCategory === 'membresia' && <p className="text-[12px] text-[#8B6B5E]">Membresía pendiente durante los cinco días posteriores al vencimiento y vencida desde el sexto. Renovar no confirma el pago ni reactiva una ficha archivada.</p>}
                </div>
              </fieldset>
              {managedEdit && <p className="text-sm">El perfil no modifica categoría, plan, fechas, precio, clases ni pagos. Usa las acciones de período. No se puede revertir un pago confirmado ni eliminar el historial; el archivo manual sigue disponible.</p>}
            </div>

             <div id="student-attendance-panel" className="space-y-7">
               <style>{`#student-attendance-panel > section:first-of-type { display: none; }`}</style>
              <section><div className="flex items-baseline justify-between mb-3"><h4 className="text-[14px] font-bold text-[#7B3F22]">Asistencia</h4><span className="text-[11px] text-[#8B6B5E]">Registro de sesiones</span></div><div className="space-y-2 max-h-52 overflow-y-auto custom-scrollbar">{form.assignedClasses.length === 0 ? <p className="py-6 border border-dashed border-[#DDBFA4] rounded-md text-center text-[12px] text-[#8B6B5E]">No hay asistencias registradas aún.</p> : form.assignedClasses.map((ac, idx) => <div key={idx} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-white border border-[#E6D8CB] rounded-md"><div><p className="text-[13px] font-bold text-[#7B3F22]">{ac.date}</p><p className="text-[11px] text-[#8B6B5E]">{ac.startTime} - {ac.endTime}</p></div><div className="flex gap-1"><button type="button" onClick={() => { const updated = [...form.assignedClasses]; updated[idx].status = updated[idx].status === 'present' ? 'pending' : 'present'; setForm({ ...form, assignedClasses: updated }); }} className={`w-8 h-8 rounded-md flex items-center justify-center border ${ac.status === 'present' ? 'bg-[#7B3F22] text-white border-[#7B3F22]' : 'bg-white text-[#8B6B5E] border-[#DDBFA4]'}`} aria-label="Marcar presente">✓</button><button type="button" onClick={() => { const updated = [...form.assignedClasses]; updated[idx].status = updated[idx].status === 'absent' ? 'pending' : 'absent'; setForm({ ...form, assignedClasses: updated }); }} className={`w-8 h-8 rounded-md flex items-center justify-center border ${ac.status === 'absent' ? 'bg-[#A85D3B] text-white border-[#A85D3B]' : 'bg-white text-[#8B6B5E] border-[#DDBFA4]'}`} aria-label="Marcar ausente">×</button></div></div>)}</div><div className="grid grid-cols-[1fr_1fr_44px] gap-2 mt-3"><input type="date" value={newSessionDate} onChange={(e) => setNewSessionDate(e.target.value)} aria-label="Fecha de asistencia" className="h-10 px-2 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22]" /><input type="time" value={newSessionTime} onChange={(e) => setNewSessionTime(e.target.value)} aria-label="Hora de asistencia" className="h-10 px-2 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22]" /><button type="button" onClick={handleAddSession} className="h-10 rounded-md bg-[#F0E2D6] text-[#7B3F22] text-lg hover:bg-[#DDBFA4]" aria-label="Añadir asistencia">+</button></div></section>
                <section className="border-t border-[#E6D8CB] pt-6">
                  <div className="flex items-baseline justify-between mb-3">
                    <h4 className="text-[14px] font-bold text-[#7B3F22]">Asistencia de {formatMonthLabel(currentMonthKey)}</h4>
                    <span className="text-[11px] text-[#8B6B5E]">Desde el calendario</span>
                  </div>
                  <div className="grid grid-cols-7 gap-1 mb-1.5">
                    {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(day => <span key={day} className="text-center text-[11px] font-bold uppercase text-[#8B6B5E]">{day}</span>)}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {getMonthCalendarDays(currentMonthKey).map((day, index) => {
                      const dateKey = day ? `${currentMonthKey}-${String(day).padStart(2, '0')}` : '';
                      const records = dateKey ? currentAttendanceByDate[dateKey] || [] : [];
                      const hasPresent = records.some(record => record.status === 'present');
                      const hasAbsent = records.some(record => record.status === 'absent');
                       const dayStatus = hasPresent && hasAbsent ? 'calendar-attendance-mixed' : hasPresent ? 'calendar-attendance-present' : hasAbsent ? 'calendar-attendance-absent' : 'calendar-attendance-empty';
                       return <div key={`${dateKey || 'empty'}-${index}`} title={hasPresent && hasAbsent ? 'Presente y falta' : hasPresent ? 'Presente' : hasAbsent ? 'Falta' : undefined} className={`calendar-mini-cell ${day ? dayStatus : 'border-transparent'}`}>
                         {day && <span className="text-[11px] font-semibold">{day}</span>}
                      </div>;
                    })}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[#8B6B5E]"><span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#5F8065]" />Presente</span><span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#9C4235]" />Falta</span><span>{currentMonthAttendance.length} registros</span></div>
                </section>
                <section className="border-t border-[#E6D8CB] pt-6">
                  <div className="flex items-baseline justify-between mb-3"><h4 className="text-[14px] font-bold text-[#7B3F22]">Historial por meses</h4><span className="text-[11px] text-[#8B6B5E]">{previousAttendanceMonths.length} meses anteriores</span></div>
                  {previousAttendanceMonths.length === 0 ? <p className="py-5 border border-dashed border-[#DDBFA4] rounded-md text-center text-[12px] text-[#8B6B5E]">No hay meses anteriores registrados.</p> : <div className="space-y-2">{previousAttendanceMonths.map(monthKey => {
                    const records = attendanceByMonth[monthKey];
                    const isExpanded = expandedAttendanceMonth === monthKey;
                    const presentCount = records.filter(record => record.status === 'present').length;
                    const absentCount = records.filter(record => record.status === 'absent').length;
                    return <div key={monthKey} className="rounded-md border border-[#E6D8CB] bg-white overflow-hidden"><button type="button" onClick={() => setExpandedAttendanceMonth(isExpanded ? currentMonthKey : monthKey)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[#FCF8F4]"><span className="text-[12px] font-bold capitalize text-[#7B3F22]">{formatMonthLabel(monthKey)}</span><span className="text-[11px] text-[#8B6B5E]">{presentCount} presentes · {absentCount} faltas <span className="ml-1">{isExpanded ? '−' : '+'}</span></span></button>{isExpanded && <div className="border-t border-[#E6D8CB] px-3 py-2 space-y-1.5">{records.map((record, index) => <div key={`${record.date}-${record.startTime}-${index}`} className="flex items-center justify-between text-[11px]"><span className="text-[#7B3F22]">{record.date} · {record.startTime} - {record.endTime}</span><span className={`font-bold ${record.status === 'present' ? 'text-[#47704D]' : 'text-[#9C4235]'}`}>{record.status === 'present' ? 'Presente' : 'Falta'}</span></div>)}</div>}</div>;
                  })}</div>}
                </section>
               <section className="border-t border-[#E6D8CB] pt-6"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-3">Observaciones internas</h4><textarea value={form.observations} onChange={(e) => setForm({ ...form, observations: e.target.value })} placeholder="Preferencias, nivel o avisos relevantes" aria-label="Observaciones internas" className="w-full min-h-[120px] p-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none resize-y focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></section>
               <div className="text-[11px] text-[#8B6B5E] border-t border-[#E6D8CB] pt-4">{editingStudent?.createdAt ? `Ficha creada el ${new Date(editingStudent.createdAt).toLocaleDateString('es-ES')}` : 'La ficha se registrará al guardar.'}</div>
               {managedEdit && liveEditingStudent && <section className="space-y-3 border-t pt-4">
                 <h4 className="font-bold">Períodos y pagos</h4>
                 {(liveEditingStudent.membershipPeriods || []).map(period => <div key={period.id} className="border rounded p-3 text-sm">
                   <p>{period.startsOn || 'Sin inicio'} — {period.endsOn || 'Sin vencimiento'} · {period.membershipTier || 'Plan desconocido'}</p>
                   <p>{period.id === liveEditingStudent.effectivePeriodId ? 'Período actual' : period.startsOn && period.startsOn > today ? 'Renovación programada' : 'Historial'} · {period.paymentStatus === 'paid' ? 'Pagado' : period.paymentStatus === 'pending' ? 'Pago pendiente' : 'Pago desconocido'}</p>
                   {period.paymentStatus !== 'paid' && <button type="button" disabled={isSubmitting} onClick={() => void runMembershipAction(() => onConfirmPayment(liveEditingStudent.id, period.id))}>Confirmar pago de este período</button>}
                 </div>)}
                 {!liveEditingStudent.effectivePeriodId && <div className="space-y-2">
                   <p>Registro legado: el período se inicializa solo mediante una acción explícita.</p>
                   <button type="button" disabled={isSubmitting} onClick={() => void runMembershipAction(() => onActivateMembership(liveEditingStudent.id))}>Inicializar período</button>
                 </div>}
                 <label>Plan del próximo período <select value={renewalTier} disabled={isSubmitting || !!renewalIntentRef.current} onChange={event => setRenewalTier(event.target.value as MembershipTier)}>{Object.entries(MEMBERSHIP_PLANS).map(([tier, plan]) => <option key={tier} value={tier}>{plan.label} · {plan.price}€ · {plan.bonuses} clases</option>)}</select></label>
                 <p>Renovar programa un único sucesor pendiente; conserva las clases y el pago actuales hasta su inicio.</p>
                 <button type="button" disabled={isSubmitting} onClick={handleRenewMembership}>Programar renovación / reintentar</button>
                 <p>Saldo actual del período: {liveEditingStudent.classesRemaining} / {liveEditingStudent.bonosAsignados ?? 'desconocido'}</p>
                  {canAdjustClasses ? <>
                  {adjustmentNeedsReview && <button type="button" disabled={isSubmitting} onClick={() => { pendingIntents.current.clear(`adjust:${liveEditingStudent.id}`); adjustmentIntentRef.current = null; setAdjustmentNeedsReview(false); }}>Revisé el período y saldo: crear un nuevo intento</button>}
                 <label>Ajuste explícito de clases <input type="number" value={adjustmentDelta} disabled={isSubmitting || !!adjustmentIntentRef.current} onChange={event => setAdjustmentDelta(Number(event.target.value))} /></label>
                 <button type="button" disabled={isSubmitting || adjustmentNeedsReview || !liveEditingStudent.effectivePeriodId || !Number.isInteger(adjustmentDelta) || !adjustmentDelta} onClick={() => void runMembershipAction(async () => {
                   adjustmentIntentRef.current ||= createClassAdjustmentIntent(liveEditingStudent, adjustmentDelta);
                   pendingIntents.current.set(`adjust:${liveEditingStudent.id}`, adjustmentIntentRef.current);
                   try { await onAdjustClasses(adjustmentIntentRef.current); pendingIntents.current.clear(`adjust:${liveEditingStudent.id}`); adjustmentIntentRef.current = null; }
                   catch (error: any) { if (error.code === '40001') setAdjustmentNeedsReview(true); throw error; }
                  })}>Aplicar ajuste / reintentar</button>
                  </> : <p className="text-sm">Los ajustes genéricos están bloqueados para no eludir penalizaciones. Las exenciones se revisan en el control de asistencia y solo las realiza el propietario. Un ajuste anterior sin confirmar requiere revisar su recibo, no crear otro.</p>}
               </section>}
               {editingStudent && isStudentArchived(editingStudent, today) && <button type="button" disabled={isSubmitting} onClick={async () => { setIsSubmitting(true); try { await onUpdate(editingStudent.id, getStudentReactivationUpdates()); setShowModal(false); setEditingStudent(null); } catch (error: any) { showError(error.message || 'No se pudo reactivar.'); } finally { setIsSubmitting(false); } }} className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7B3F22] hover:text-[#C68952] disabled:opacity-50">Reactivar alumno manualmente</button>}
               {editingStudent && !isStudentArchived(editingStudent, today) && <button type="button" onClick={() => setStudentToArchive(editingStudent.id)} className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7B3F22] hover:text-[#C68952]">Archivar alumno manualmente</button>}
               {editingStudent && !managedEdit && <button type="button" onClick={() => setStudentToDelete(editingStudent.id)} className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#A85D3B] hover:text-[#7B3F22]">Eliminar alumno</button>}
            </div>
          </form>
          {editingStudent && students.find(student => student.id === editingStudent.id) && <StudentCreditPanel key={editingStudent.id}
            student={students.find(student => student.id === editingStudent.id)!} today={today}
            onApproveManualCredit={onApproveManualCredit} onSettlePendingPenalty={onSettlePendingPenalty}
            onWaivePendingPenalty={onWaivePendingPenalty} canManageStudentCredits={canManageStudentCredits}
            getPendingStudentCreditOperation={getPendingStudentCreditOperation} onRetryPendingStudentCreditOperation={onRetryPendingStudentCreditOperation} />}
          </div>

          <div className="absolute bottom-0 left-0 right-0 px-4 sm:px-7 py-3 bg-[#FDFBF9]/95 backdrop-blur border-t border-[#E6D8CB] flex items-center justify-end gap-3 shrink-0 z-10"><button type="button" onClick={() => setShowModal(false)} className="h-10 px-3 text-[11px] font-bold uppercase tracking-[0.1em] text-[#8B6B5E] hover:text-[#7B3F22]">Cancelar</button><button onClick={handleSubmit} disabled={isSubmitting} className="h-10 px-4 sm:px-5 bg-[#7B3F22] text-white rounded-md text-[11px] font-bold uppercase tracking-[0.1em] hover:bg-[#63321C] transition-colors disabled:opacity-60 disabled:cursor-not-allowed">{isSubmitting ? 'Guardando...' : (editingStudent ? 'Guardar cambios' : 'Guardar alumno')}</button></div>
        </div>
      </div>}
      <ConfirmModal isOpen={showLegacyInitialization} title="¿Inicializar períodos?" message={`Se crearán los períodos de membresía para ${legacyMembershipCount} alumnos antiguos. No se modifican pagos ni bonos existentes.`} confirmText="Inicializar" isDestructive={false} loading={initializingLegacy} loadingText="Inicializando..." onCancel={() => { if (!initializingLegacy) setShowLegacyInitialization(false); }} onConfirm={async () => {
        if (!onInitializeLegacyMemberships || initializingLegacy) return;
        setInitializingLegacy(true);
        try {
          const result = await onInitializeLegacyMemberships();
          setShowLegacyInitialization(false);
          if (result.failed > 0) showError(`Se inicializaron ${result.initialized} períodos; ${result.failed} requieren revisión.`);
        } catch (error: any) { showError(error?.message || 'No se pudieron inicializar los períodos.'); }
        finally { setInitializingLegacy(false); }
      }} />

        <ConfirmModal isOpen={!!pendingCategory} title="¿Cambiar categoría?" message={`Vas a cambiar este alumno a ${pendingCategory === 'temporal' ? 'Bonos temporales' : 'Membresía'}. Se ajustarán sus bonos y la renovación automática.`} confirmText="Cambiar categoría" isDestructive={false} onConfirm={() => { if (pendingCategory) applyCategoryChange(pendingCategory); }} onCancel={() => setPendingCategory(null)} />
        <ConfirmModal isOpen={!!pendingMembershipTier} title="¿Cambiar nivel?" message={`Vas a cambiar la membresía a ${pendingMembershipTier ? MEMBERSHIP_PLANS[pendingMembershipTier].label : ''}. Se actualizarán el precio y los bonos contratados.`} confirmText="Cambiar nivel" isDestructive={false} onConfirm={() => { if (pendingMembershipTier) applyMembershipTierChange(pendingMembershipTier); }} onCancel={() => setPendingMembershipTier(null)} />
        <ConfirmModal isOpen={!!studentToArchive} title="¿Archivar alumno?" message="El alumno dejará de aparecer entre los activos. Podrás reactivarlo con la acción Reactivar alumno manualmente, sin renovar ni confirmar un pago." confirmText="Archivar" isDestructive={false} onConfirm={async () => { if (studentToArchive && !isSubmitting) { setIsSubmitting(true); try { await onUpdate(studentToArchive, { archivedAt: getWorkshopDate() }); setStudentToArchive(null); setShowModal(false); setEditingStudent(null); } catch (error: any) { showError(error.message || 'No se pudo archivar.'); } finally { setIsSubmitting(false); } } }} onCancel={() => setStudentToArchive(null)} />
       <ConfirmModal isOpen={!!studentToDelete} title="¿Eliminar alumno?" message="¿Seguro que deseas eliminar el historial de este alumno? Esta acción no se puede deshacer." isDestructive={true} onConfirm={async () => { if (studentToDelete && !isSubmitting) { setIsSubmitting(true); try { await onDeleteStudent(studentToDelete); setStudentToDelete(null); setShowModal(false); setEditingStudent(null); } catch (error: any) { showError(error.message || 'No se pudo eliminar.'); } finally { setIsSubmitting(false); } } }} onCancel={() => setStudentToDelete(null)} />
    </div>
  );
};

export default StudentList;
