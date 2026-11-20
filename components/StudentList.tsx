import { hasVerifiedMembership, isClassesRunningLow, needsStudentReview, studentBalanceLabel, studentGiftCardBalance, studentActivityLabel, studentClassTypeFromGiftCards, giftCardTypeLabel, giftCardPaymentLabel, giftCardSessionsRemaining } from '../utils/studentPresentation';
import { showError } from '../context/toast';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Student, AssignedClass, GiftCard, inferMembershipTier, MEMBERSHIP_PLANS, MembershipTier, RenewalIntent, ClassAdjustmentIntent, ScalarClassAdjustment } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';
import { ClassAdjustmentDialog } from './shared/ClassAdjustmentDialog';
import { DangerZone } from './shared/DangerZone';
import DateField from './shared/DateField';
import TimeField from './shared/TimeField';
import { formatDate, formatDateTime, formatTime } from '../utils/dateFormat';
import { countVisibleStudentsByCategory, getPendingMembershipPayments, getStudentLifecycle, getStudentPaymentStatus, getWorkshopDate, isStudentArchived, addMembershipMonth, DEFAULT_STUDENT_PAYMENT_STATUS, getStudentReactivationUpdates, isManagedMembership, isNonMembershipCategory, studentHasPendingPayment, selectConfirmablePaymentPeriodId } from '../utils/studentLifecycle';
import { createRenewalIntent, createClassAdjustmentIntent, PendingMembershipIntentStore } from '../context/data/membershipOps';
import { useWorkshopDate } from '../utils/useWorkshopDate';
import { STUDENT_CATEGORY_LABELS, studentCategoryLabel } from '../utils/classTypeLabels';
import { businessReasonLabel, penaltyKindLabel } from '../utils/businessReasonLabels';
import type { ManualCreditIntent, PenaltySettlementIntent, SessionBusinessIntent, PendingStudentCreditOperation } from '../types';

const TEMPORAL_MAX_BONOS = 50;

const deleteStudentMessage = (student?: Student) => {
  const name = student ? `${student.name} ${student.surname || ''}`.trim() : 'este alumno';
  return `Vas a eliminar a ${name}. Esta acción no se puede deshacer. Si solo quieres ocultar la ficha, usa Archivar.`;
};

interface StudentListProps {
  students: Student[];
  giftCards?: GiftCard[];
  detailsLoading?: boolean;
  reviewOnly?: boolean;
  listPreset?: ListPreset | null;
  enrolledStudentIds?: string[];
  initialCategory?: CategoryFilter;
  initialTab?: TabType;
  onClearListPreset?: () => void;
  onAddStudent: (student: Omit<Student, 'id'>) => Promise<void>;
  onRenew: (intent: RenewalIntent) => Promise<void>;
  onConfirmPayment: (studentId: string, periodId: string) => Promise<void>;
  onActivateMembership: (studentId: string) => Promise<void>;
  onAdjustClasses: (intent: ClassAdjustmentIntent) => Promise<void>;
  onAdjustRemainingClasses?: (adjustment: ScalarClassAdjustment) => Promise<void>;
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
      <p className="mt-1">Aprobar un crédito no confirma pagos, no cambia categorías, no reactiva fichas y no renueva membresías. Solo el propietario de este taller puede gestionar estos derechos; el servidor verifica su identidad y permiso.</p>
      <p className="break-all">Alumno: <code>{student.id}</code> · Taller: <code>{student.sedeId || 'Sin taller verificado'}</code></p></div>
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
<p>{credit.remainingClasses} restantes / {credit.allocatedClasses} aprobadas · {formatDate(credit.startsOn)} a {formatDate(credit.endsOn)}</p>
        <p className="break-all">Derecho: <code>{credit.id}</code> · Alumno: <code>{credit.studentId}</code> · Taller: <code>{credit.sedeId}</code></p>
        <p>Motivo: {credit.reason}</p><p>Evidencia / origen: {credit.evidence}</p>
        <p className="break-all">Aprobado por (ID de actor): <code>{credit.approvedBy}</code> · {formatDateTime(credit.approvedAt)}</p>
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
        <label>Inicio del crédito manual<DateField aria-label="Inicio del crédito manual" className={controlClass} value={draft.startsOn} onChange={startsOn => setDraft({ ...draft, startsOn })} /></label>
        <label>Fin del crédito manual<DateField aria-label="Fin del crédito manual" className={controlClass} value={draft.endsOn} onChange={endsOn => setDraft({ ...draft, endsOn })} /></label>
      </div>
      <label>Motivo del crédito manual<textarea aria-label="Motivo del crédito manual" maxLength={2000} className={`${controlClass} min-h-20 py-2`} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></label>
      <label>Evidencia / origen del crédito manual<textarea aria-label="Evidencia / origen del crédito manual" maxLength={10000} className={`${controlClass} min-h-20 py-2`} value={draft.evidence} onChange={event => setDraft({ ...draft, evidence: event.target.value })} /></label>
      <p>Motivo: máximo 2000 caracteres. Evidencia / origen: máximo 10000 caracteres.</p>
      <button type="button" disabled={!validDraft} className={`${buttonClass} bg-[#7B3F22] text-white hover:bg-[#63321C]`} onClick={() => void runOperation('approve_manual')}>Aprobar crédito manual</button>
    </fieldset> : <p>Solo lectura. La gestión corresponde al propietario de este taller, no al rol de administrador ni al de superadministrador.</p>}
    <div className="space-y-2" data-testid="student-penalty-list"><h5 className="font-bold text-[#7B3F22]">Incidencias y derecho original</h5>
      <p>Solo se descuenta el derecho original. No se elige otro bono de clases ni otro bono regalo, y no se usa el período actual como sustituto. Si no es utilizable, la incidencia permanece pendiente o el propietario puede eximirla. Eximir un cargo ya aplicado revierte únicamente su derecho original, con validación del servidor.</p>
      {(student.pendingPenalties || []).length === 0 ? <p>Sin incidencias registradas.</p> : student.pendingPenalties!.map(penalty => {
        const sources = [['Período original', penalty.originalPeriodId], ['Bono regalo original', penalty.originalGiftCardId], ['Crédito manual original', penalty.originalManualCreditId]].filter(([, id]) => !!id);
        const identityAvailable = !!penalty.id && penalty.studentId === student.id && !!student.sedeId && penalty.sedeId === student.sedeId
          && !!penalty.sessionId && Number.isSafeInteger(penalty.sessionRevision) && penalty.sessionRevision! >= 0;
        const validReason = !!reasons[penalty.id]?.trim() && reasons[penalty.id].trim().length <= 2000;
        return <article key={penalty.id} data-penalty-id={penalty.id} data-penalty-state={penalty.state} className="min-w-0 space-y-2 rounded-md border border-[#E6D8CB] bg-white p-3 break-words">
          <p className="font-bold text-[#7B3F22]">{penaltyKindLabel(penalty.kind)} · {penalty.state === 'pending' ? 'Pendiente de resolución' : penalty.state === 'charged' ? 'Descuento aplicado' : 'Eximida'}</p>
<p>{formatDate(penalty.sessionDate)} · {formatTime(penalty.sessionStart)} · Revisión de sesión: {penalty.sessionRevision ?? 'Sin revisión'}</p>
          <p className="break-all">Incidencia: <code>{penalty.id}</code> · Sesión: <code>{penalty.sessionId}</code> · Alumno: <code>{penalty.studentId}</code> · Taller: <code>{penalty.sedeId}</code></p>
          <div data-testid="penalty-original-source">{sources.length ? sources.map(([label, id]) => <p key={label} className="break-all">{label}: <code>{id}</code></p>) : <p>Sin derecho original atribuible. No se sustituye por el saldo actual.</p>}</div>
          <p>Motivo registrado: {businessReasonLabel(penalty.reason)}</p>
          {(penalty.settlementId || penalty.settlementReason || penalty.settledBy || penalty.settledAt) && <div data-testid="penalty-settlement-audit" className="space-y-1 border-t border-[#E6D8CB] pt-2">
            <p className="font-bold text-[#7B3F22]">Liquidación registrada</p>
            {penalty.settlementId && <p className="break-all">Liquidación: <code>{penalty.settlementId}</code></p>}
            {penalty.settlementReason && <p>Motivo de liquidación: {penalty.settlementReason}</p>}
            {penalty.settledBy && <p className="break-all">Aplicada por (ID de actor): <code>{penalty.settledBy}</code></p>}
            {penalty.settledAt && <p>Fecha de liquidación: {formatDateTime(penalty.settledAt)}</p>}
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
type CategoryFilter = 'todos' | 'membresia' | 'temporal' | 'grupal' | 'grupo_temporal' | 'archivados';
type ListPreset = 'payment' | 'low-classes' | 'enrolled';
type MembershipTierFilter = 'todos' | MembershipTier;
type StudentCategoryValue = NonNullable<Student['studentCategory']>;

const CATEGORY_LABELS: Record<string, string> = {
  ...STUDENT_CATEGORY_LABELS,
  archivados: 'Archivados'
};

const getMonthKey = (date: string) => date.slice(0, 7);

const formatMonthLabel = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map(Number);
  return formatDate(`${year}-${String(month).padStart(2, '0')}-01`, 'monthYear');
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
  giftCards = [],
  detailsLoading = false, reviewOnly = false,
  listPreset = null, enrolledStudentIds, initialCategory, initialTab, onClearListPreset,
  onAddStudent,
  onRenew,
  onConfirmPayment, onActivateMembership, onAdjustClasses, onAdjustRemainingClasses, canAdjustClasses = true,
  onUpdate,
  onDeleteStudent,
  selectedStudentId,
  onClearSelectedStudent,
  onApproveManualCredit, onSettlePendingPenalty, onWaivePendingPenalty, canManageStudentCredits,
  getPendingStudentCreditOperation, onRetryPendingStudentCreditOperation
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab || 'all');
  // La primera vista prioriza las membresías: es el grupo operativo más
  // frecuente y permite pintar una página pequeña sin esperar todo el detalle.
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(initialCategory || 'membresia');
  const [activePreset, setActivePreset] = useState<ListPreset | null>(listPreset);
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [membershipTierFilter, setMembershipTierFilter] = useState<MembershipTierFilter>('todos');
  const [showModal, setShowModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [studentToDelete, setStudentToDelete] = useState<string | null>(null);
  const [studentToArchive, setStudentToArchive] = useState<string | null>(null);
  const [pendingClassAdjustment, setPendingClassAdjustment] = useState<{ current: number; next: number } | null>(null);
  const [pendingCategory, setPendingCategory] = useState<StudentCategoryValue | null>(null);
  const [pendingMembershipTier, setPendingMembershipTier] = useState<MembershipTier | null>(null);
  const today = useWorkshopDate();
  const currentMonthKey = getMonthKey(today);
  const [expandedAttendanceMonth, setExpandedAttendanceMonth] = useState(currentMonthKey);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingIntents = useRef(new PendingMembershipIntentStore());
  const renewalIntentRef = useRef<RenewalIntent | null>(null);
  const adjustmentIntentRef = useRef<ClassAdjustmentIntent | null>(null);
  const [renewalTier, setRenewalTier] = useState<MembershipTier | ''>('');
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

  useEffect(() => { setActivePreset(listPreset); }, [listPreset]);
  useEffect(() => { if (initialCategory) setCategoryFilter(initialCategory); }, [initialCategory]);
  useEffect(() => { if (initialTab) setActiveTab(initialTab); }, [initialTab]);

  useEffect(() => {
    if (!selectedStudentId) return;
    const student = students.find(s => s.id === selectedStudentId);
    if (!student) return;
    handleEditClick(student);
    if (onClearSelectedStudent) onClearSelectedStudent();
  }, [selectedStudentId, students, onClearSelectedStudent]);

  const getCalculatedStatus = (studentData: typeof form) => {
    if (isNonMembershipCategory(studentData.studentCategory)) return 'new';
    if (!studentData.expiryDate || studentData.expiryDate < today || studentData.paymentStatus === 'pending') {
      return 'needs_renewal';
    }
    return 'membresia';
  };

  const handleEditClick = (student: Student) => {
    setPendingClassAdjustment(null);
    setEditingStudent(student);
    renewalIntentRef.current = pendingIntents.current.get<RenewalIntent>(`renew:${student.id}`);
    adjustmentIntentRef.current = pendingIntents.current.get<ClassAdjustmentIntent>(`adjust:${student.id}`);
    setAdjustmentNeedsReview(false);
    setAdjustmentDelta(adjustmentIntentRef.current?.delta ?? -1);
    setRenewalTier(renewalIntentRef.current?.membershipTier ?? (hasVerifiedMembership(student) ? student.membershipTier! : ''));
    const membershipTier = inferMembershipTier(student.membershipTier, student.price);
    const isPack = isNonMembershipCategory(student.studentCategory);
    const assignedBonuses = student.bonosAsignados ?? (isPack ? Math.max(1, student.classesRemaining || 1) : MEMBERSHIP_PLANS[membershipTier].bonuses);
    setForm({
      name: student.name,
      surname: student.surname || '',
      email: student.email || '',
      phone: student.phone,
      notes: student.notes || '',
      observations: student.observations || '',
      classesRemaining: student.classesRemaining,
      price: student.price ?? (isPack ? 0 : MEMBERSHIP_PLANS[membershipTier].price),
      paymentStatus: getStudentPaymentStatus(student),
      classType: student.classType || studentClassTypeFromGiftCards(student, giftCards) || 'Modelado',
      expiryDate: student.expiryDate || '',
      assignedClasses: student.assignedClasses || [],
      studentCategory: student.studentCategory || 'membresia',
      membershipTier,
      membershipActivatedAt: student.membershipActivatedAt || '',
      groupName: student.groupName || '',
      bonosAsignados: assignedBonuses,
      repetirMensualmente: isPack ? false : (student.repetirMensualmente ?? false)
    });
    setShowModal(true);
  };

  const handleCreateClick = () => {
    setEditingStudent(null);
    const nextMonth = addMembershipMonth(today);
    setForm({
      name: '', surname: '', email: '', phone: '', notes: '', observations: '',
      classesRemaining: MEMBERSHIP_PLANS.gold.bonuses, price: MEMBERSHIP_PLANS.gold.price, paymentStatus: DEFAULT_STUDENT_PAYMENT_STATUS, classType: 'Modelado',
      expiryDate: nextMonth, assignedClasses: [],
      studentCategory: 'membresia', membershipTier: 'gold', membershipActivatedAt: getWorkshopDate(), groupName: '', bonosAsignados: MEMBERSHIP_PLANS.gold.bonuses, repetirMensualmente: false
    });
    setShowModal(true);
  };

  const applyCategoryChange = (category: StudentCategoryValue) => {
    const plan = MEMBERSHIP_PLANS[form.membershipTier];
    const toPack = isNonMembershipCategory(category);
    setForm(current => ({
      ...current,
      studentCategory: category,
      bonosAsignados: toPack ? Math.max(1, current.bonosAsignados || 1) : plan.bonuses,
      classesRemaining: toPack
        ? Math.min(Math.max(1, current.bonosAsignados || current.classesRemaining || 1), Math.max(1, current.classesRemaining || 1))
        : Math.min(plan.bonuses, current.classesRemaining),
      repetirMensualmente: category === 'membresia' ? current.repetirMensualmente : false
    }));
    setPendingCategory(null);
  };

  const requestCategoryChange = (category: StudentCategoryValue) => {
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
    const packBonos = Math.min(TEMPORAL_MAX_BONOS, Math.max(1, form.bonosAsignados));
    const data = {
      ...studentForm,
      price: isMembership ? plan.price : form.price,
      bonosAsignados: isMembership ? form.bonosAsignados : packBonos,
      classesRemaining: isMembership
        ? Math.max(0, form.classesRemaining)
        : Math.min(packBonos, Math.max(0, form.classesRemaining)),
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
          const linkedBalance = studentGiftCardBalance(editingStudent.id, giftCards);
          const { bonosAsignados: _bonosAsignados, classesRemaining: _classesRemaining, ...profileWithoutGiftBalance } = data;
          const update = linkedBalance.cards.length
            ? profileWithoutGiftBalance
            : data;
          await onUpdate(editingStudent.id, { ...update, studentCategory: editingStudent.studentCategory,
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
    if (!editingStudent || isSubmitting || !renewalTier || !hasVerifiedMembership(editingStudent)) return;
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

  const confirmVisiblePayment = async () => {
    if (!liveEditingStudent || isSubmitting || !studentHasPendingPayment(liveEditingStudent)) return;
    const periodId = selectConfirmablePaymentPeriodId(liveEditingStudent);
    setIsSubmitting(true);
    try {
      if (periodId) {
        await onConfirmPayment(liveEditingStudent.id, periodId);
        if (periodId === liveEditingStudent.effectivePeriodId || !liveEditingStudent.membershipPeriods?.length) {
          setForm(current => ({ ...current, paymentStatus: 'paid' }));
        }
      } else if (!isManagedMembership(liveEditingStudent)) {
        await onUpdate(liveEditingStudent.id, { paymentStatus: 'paid' });
        setForm(current => ({ ...current, paymentStatus: 'paid' }));
      } else {
        showError('Inicializa el período antes de confirmar el pago.');
      }
    } catch (error: any) {
      showError(error.message || 'No se pudo confirmar el pago.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const requestRemainingClassChange = (delta: number) => {
    if (!editingStudent) {
      setForm(current => ({ ...current, classesRemaining: Math.max(0, Math.min(current.bonosAsignados, current.classesRemaining + delta)) }));
      return;
    }
    if (pendingClassAdjustment || isSubmitting) return;
    const current = form.classesRemaining;
    const next = Math.max(0, Math.min(form.bonosAsignados, current + delta));
    if (next === current) return;
    setPendingClassAdjustment({ current, next });
  };

  const confirmRemainingClassChange = async (reason: string) => {
    if (!editingStudent || !pendingClassAdjustment || isSubmitting) return;
    const { current, next } = pendingClassAdjustment;
    const adjustment: ScalarClassAdjustment = {
      studentId: editingStudent.id, expectedBalance: current, delta: next - current, resultingBalance: next, reason
    };
    setIsSubmitting(true);
    try {
      if (onAdjustRemainingClasses) await onAdjustRemainingClasses(adjustment);
      else await onUpdate(editingStudent.id, { classesRemaining: next });
      setForm(value => ({ ...value, classesRemaining: next }));
      setPendingClassAdjustment(null);
    } catch (error: any) {
      showError(error.message || 'No se pudo ajustar las clases.');
    } finally {
      setIsSubmitting(false);
    }
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

  const clearPreset = () => { setActivePreset(null); onClearListPreset?.(); };

  const filteredStudents = useMemo(() => {
    return students.filter(s => {
      const archived = isStudentArchived(s, today);
      const lifecycle = getStudentLifecycle(s, today);
      const fullName = `${s.name} ${s.surname || ''}`.trim().toLowerCase();
      const matchesSearch = !searchQuery.trim() || fullName.includes(searchQuery.trim().toLowerCase());
      if (activePreset === 'payment') return matchesSearch && getPendingMembershipPayments(s).length > 0;
      if (activePreset === 'low-classes') return matchesSearch && !archived && isClassesRunningLow(s, giftCards);
      if (activePreset === 'enrolled') return matchesSearch && !!enrolledStudentIds?.includes(s.id);
      const cat = s.studentCategory || 'membresia';
      const matchesCategory = categoryFilter === 'todos' || cat === categoryFilter;
      const membershipTier = inferMembershipTier(s.membershipTier, s.price);
      if (reviewOnly && !needsStudentReview(s)) return false;
      const matchesTier = categoryFilter !== 'membresia' || membershipTierFilter === 'todos' || hasVerifiedMembership(s) && membershipTier === membershipTierFilter;
      if (categoryFilter === 'archivados') return archived && matchesSearch;
      if (archived || !matchesSearch || !matchesCategory || !matchesTier) return false;
      // Los bonos temporales no tienen estados de membresía (al día,
      // pendientes o vencidas); solo se consultan por categoría o búsqueda.
      if (categoryFilter === 'membresia') {
        if (activeTab === 'expired') return lifecycle === 'expired';
        if (activeTab === 'pending') return lifecycle === 'pending';
        if (activeTab === 'active') return lifecycle === 'active';
      }
      return matchesSearch && matchesCategory && matchesTier;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [students, activeTab, searchQuery, categoryFilter, membershipTierFilter, today, reviewOnly, activePreset, enrolledStudentIds, giftCards]);

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

  const categoryCounts = useMemo(() => countVisibleStudentsByCategory(students, today), [students, today]);
  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F7F3EF] text-neutral-textMain" style={{ fontFamily: "'Outfit', sans-serif" }}>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 sm:px-6 lg:px-10 pt-5 sm:pt-7 pb-24">
        <div className="max-w-[1280px] mx-auto">
          <header className="animate-fade-in">
            <div className="flex items-start justify-between gap-4">
              <div>
                 <h1 className="ui-page-title text-[#7B3F22]" style={{ fontFamily: "'Outfit', sans-serif" }}>Alumnos</h1>
                 <p className="ui-secondary mt-2">Personas, clases y actividad del taller.</p>
              </div>
              <button onClick={handleCreateClick} className="shrink-0 flex items-center gap-2 h-10 px-3 sm:px-4 bg-[#7B3F22] text-white rounded-lg text-[11px] font-bold uppercase tracking-[0.12em] hover:bg-[#63321C] focus:outline-none focus:ring-2 focus:ring-[#C68952]/50 transition-colors" aria-label="Crear nuevo alumno">
                <span className="text-lg leading-none">+</span><span className="hidden sm:inline">Nuevo alumno</span><span className="sm:hidden">Nuevo</span>
              </button>
            </div>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-[#DDBFA4]/70 py-3.5 text-[13px]" aria-label="Resumen de alumnos">
              <span><strong className="mr-1.5 text-[28px] leading-none font-bold text-[#F18B4B]">{categoryCounts.membresia}</strong><span className="font-medium text-neutral-textSec">membresías</span></span>
              <span className="h-5 w-px bg-neutral-border" />
              <span><strong className="mr-1.5 text-[28px] leading-none font-bold text-[#F18B4B]">{categoryCounts.temporal}</strong><span className="font-medium text-neutral-textSec">bonos de clases</span></span>
              <span className="h-5 w-px bg-neutral-border" />
              <span><strong className="mr-1.5 text-[28px] leading-none font-bold text-[#F18B4B]">{categoryCounts.grupal}</strong><span className="font-medium text-neutral-textSec">grupales</span></span>
              <span className="h-5 w-px bg-neutral-border" />
              <span><strong className="mr-1.5 text-[28px] leading-none font-bold text-[#F18B4B]">{categoryCounts.grupo_temporal}</strong><span className="font-medium text-neutral-textSec">grupo temporal</span></span>
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
                {(['membresia', 'temporal', 'grupal', 'grupo_temporal', 'archivados'] as CategoryFilter[]).map(cat => <button key={cat} onClick={() => { setCategoryFilter(cat); setActiveTab('all'); clearPreset(); }} className={`shrink-0 rounded-lg border px-3.5 py-2 text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${!activePreset && categoryFilter === cat ? 'border-brand bg-brand-soft text-brand' : 'border-neutral-border bg-white text-neutral-textHelper hover:border-brand hover:text-brand'}`}>{CATEGORY_LABELS[cat]} <span className="ml-1 opacity-60">{categoryCounts[cat] || 0}</span></button>)}
              </div>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                {categoryFilter === 'membresia' && <label className="relative shrink-0"><span className="sr-only">Elegir plan</span><select value={membershipTierFilter} onChange={(event) => setMembershipTierFilter(event.target.value as MembershipTierFilter)} className="h-10 min-w-[190px] appearance-none border border-neutral-border bg-white px-3 pr-9 text-[13px] text-neutral-textHelper outline-none focus:border-brand"><option value="todos">Elegir plan</option>{(['plata', 'gold', 'platinum'] as MembershipTierFilter[]).map(tier => <option key={tier} value={tier}>{MEMBERSHIP_PLANS[tier].label}</option>)}</select><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-textHelper">⌄</span></label>}
                {categoryFilter === 'membresia' && <div className="flex min-w-0 items-center overflow-x-auto no-scrollbar" role="tablist" aria-label="Estado de membresías">
                  {(['all', 'active', 'pending', 'expired'] as TabType[]).map((tab, index) => <React.Fragment key={tab}>{index > 0 && <span className="mx-2 h-5 w-px shrink-0 bg-[#9E9892]" aria-hidden="true" />}<button type="button" onClick={() => { setActiveTab(tab); clearPreset(); }} role="tab" aria-selected={!activePreset && activeTab === tab} className={`shrink-0 py-2 text-[12px] font-bold uppercase tracking-[0.12em] ${!activePreset && activeTab === tab ? 'text-[#7B3F22]' : 'text-[#8B6B5E] hover:text-[#7B3F22]'}`}>{tab === 'all' ? 'Todos' : tab === 'active' ? 'Al día' : tab === 'expired' ? 'Vencidas' : 'Pendientes'}</button></React.Fragment>)}
                </div>}
              </div>
            </div>
          </section>

          {activePreset && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E7B899] bg-[#FFF9F4] px-4 py-3 text-[13px] text-[#7B3F22]" role="status"><span>{activePreset === 'payment' ? 'Alumnos con un pago pendiente.' : activePreset === 'low-classes' ? 'Alumnos con las clases agotándose.' : 'Alumnos con clase hoy.'}</span><button type="button" onClick={clearPreset} className="min-h-9 rounded-lg border border-[#DDBFA4] bg-white px-3 text-[12px] font-bold text-[#7B3F22]">Quitar filtro</button></div>}

           <div className="bg-white border border-[#DDBFA4] rounded-xl overflow-hidden">
             <div className="hidden md:grid grid-cols-[minmax(260px,1.8fr)_1fr_110px_118px] gap-4 px-5 py-3 border-b border-[#EDE2D8] text-[12px] font-bold uppercase tracking-[0.1em] text-[#8B6B5E]"><span>Alumno</span><span>Actividad</span><span>Clases</span><span>Estado</span></div>
            {detailsLoading && <div className="flex items-center gap-2 border-b border-[#EDE2D8] bg-[#FFF9F4] px-5 py-2.5 text-[12px] text-[#8B6B5E]" role="status"><span className="h-2 w-2 animate-pulse rounded-full bg-[#C68952]" />Cargando clases y detalles en segundo plano…</div>}
            {filteredStudents.length === 0 ? <div className="px-6 py-16 text-center"><p className="text-[16px] font-semibold text-neutral-textMain">{students.length === 0 ? 'Todavía no hay alumnos' : (searchQuery.trim() || activeTab !== 'all' || membershipTierFilter !== 'todos' || reviewOnly ? 'Ningún alumno coincide con estos filtros' : `No hay alumnos en ${CATEGORY_LABELS[categoryFilter].toLowerCase()}`)}</p><p className="mt-2 text-[15px] text-neutral-textSec">{students.length === 0 ? 'Crea la primera ficha para llevar sus clases y su pago.' : (searchQuery.trim() || activeTab !== 'all' || membershipTierFilter !== 'todos' || reviewOnly ? 'Prueba con otro nombre, otro estado o limpia la búsqueda.' : 'Puedes cambiar de categoría o crear una ficha nueva.')}</p>{students.length === 0 && <button type="button" onClick={handleCreateClick} className="mt-5 inline-flex min-h-11 items-center rounded-[10px] bg-brand px-4 text-[14px] font-semibold text-white">Añadir el primer alumno</button>}</div> : visibleStudents.map(s => {
              const isArchived = isStudentArchived(s, today);
              const lifecycle = getStudentLifecycle(s, today);
              const isPending = lifecycle === 'pending';
              const isExpired = lifecycle === 'expired';
              const cat = s.studentCategory || 'membresia';
              const membershipTier = inferMembershipTier(s.membershipTier, s.price);
              const initials = `${s.name.charAt(0)}${s.surname?.charAt(0) || ''}`.toUpperCase();
              const percentage = hasVerifiedMembership(s) ? Math.min(100, (s.classesRemaining / s.bonosAsignados!) * 100) : 0;
               return <button key={s.id} data-student-id={s.id} onClick={() => handleEditClick(s)} className="ui-list w-full text-left grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(260px,1.8fr)_1fr_110px_118px] gap-3 md:gap-4 items-center px-4 md:px-5 py-3.5 border-b last:border-0 border-[#EDE2D8] hover:bg-[#FCF8F4] focus:outline-none focus:bg-[#FCF8F4] transition-colors group">
                  <div className="flex items-center gap-3 min-w-0"><span className="w-11 h-11 shrink-0 rounded-full bg-[#F0E2D6] text-[#7B3F22] flex items-center justify-center text-[12px] font-bold">{initials}</span><span className="min-w-0"><strong className="ui-card-title block text-[#7B3F22] truncate group-hover:text-[#C68952] transition-colors">{s.name} {s.surname}</strong><span className="ui-meta block truncate">{s.phone || s.email || 'Sin contacto añadido'}</span><span className="ui-meta md:hidden block mt-1">{studentActivityLabel(s, giftCards) || 'Sin actividad'} · {isArchived ? CATEGORY_LABELS.archivados : cat === 'membresia' && !hasVerifiedMembership(s) ? 'Plan por confirmar · Por verificar' : studentCategoryLabel(cat)}</span></span></div>
                  <div className="hidden md:block min-w-0"><span className="ui-data block text-[#7B3F22] truncate">{studentActivityLabel(s, giftCards) || 'Sin actividad'}</span><span className="inline-flex mt-1 px-2 py-0.5 rounded border border-[#DDBFA4] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8B6B5E]">{isArchived ? CATEGORY_LABELS.archivados : cat === 'membresia' ? (hasVerifiedMembership(s) ? MEMBERSHIP_PLANS[membershipTier].label : 'Plan por confirmar') : studentCategoryLabel(cat)}</span></div>
                  <div className="max-w-[112px] text-right md:max-w-none md:text-left"><strong className={`text-[16px] tabular-nums ${isPending ? 'text-[#A85D3B]' : 'text-[#7B3F22]'}`}>{hasVerifiedMembership(s) ? <>{s.classesRemaining}<span className="ui-meta font-normal">/{s.bonosAsignados}</span></> : <span className="block whitespace-normal text-[12px] leading-snug">{studentBalanceLabel(s, giftCards)}</span>}</strong><div className="w-16 h-1 bg-[#F0E5DB] rounded-full overflow-hidden mt-1 ml-auto md:ml-0"><span className={`block h-full ${isPending ? 'bg-[#C68952]' : 'bg-[#7B3F22]'}`} style={{ width: `${percentage}%` }} /></div></div>
                  <span className={`hidden md:inline-flex justify-center px-2 py-1 rounded text-[12px] font-bold uppercase tracking-[0.06em] border ${isArchived ? 'bg-[#F0E5DB] text-[#8B6B5E] border-[#DDBFA4]' : isPending ? 'bg-[#FBF1EC] text-[#A85D3B] border-[#E8CABB]' : 'bg-[#F5F1E9] text-[#7B3F22] border-[#D8CDBE]'}`}>{isArchived ? 'Archivado' : isNonMembershipCategory(cat) ? studentCategoryLabel(cat) : isExpired ? 'Vencida' : needsStudentReview(s) ? 'Por verificar' : isPending ? 'Pendiente' : 'Activo'}</span>
              </button>;
            })}
            {hasMoreStudents && <div className="flex justify-center border-t border-[#EDE2D8] px-4 py-4"><button type="button" onClick={() => setVisibleLimit(limit => limit + 50)} className="min-h-10 rounded-lg border border-[#C68952] bg-white px-4 py-2 text-[12px] font-bold text-[#7B3F22] hover:bg-[#F7F1EB]">Cargar más alumnos ({filteredStudents.length - visibleStudents.length} restantes)</button></div>}
          </div>
        </div>
      </div>

      {showModal && <div className="fixed inset-0 bg-[#4B2A1D]/45 backdrop-blur-[2px] z-[100] flex items-end md:items-center justify-center overflow-hidden">
        <div className={`bg-[#FDFBF9] w-full ${editingStudent ? 'md:max-w-5xl' : 'md:max-w-2xl'} h-[100dvh] md:h-auto md:max-h-[92dvh] md:rounded-xl shadow-[0_20px_60px_rgba(75,42,29,0.2)] relative flex flex-col overflow-hidden animate-fade-in`}>
          <div className="px-4 sm:px-7 py-4 border-b border-[#E6D8CB] flex items-center justify-between shrink-0 bg-[#FDFBF9]"><div className="flex items-center gap-3 min-w-0"><span className="hidden sm:flex w-10 h-10 rounded-full bg-[#F0E2D6] text-[#7B3F22] items-center justify-center text-[12px] font-bold">{editingStudent ? `${editingStudent.name.charAt(0)}${editingStudent.surname?.charAt(0) || ''}` : '+'}</span><div className="min-w-0"><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8B6B5E]">{editingStudent ? 'Perfil del alumno' : 'Nuevo alumno'}</p><h3 className="text-[20px] text-[#7B3F22] truncate" style={{ fontFamily: "'Outfit', sans-serif" }}>{editingStudent ? `${editingStudent.name} ${editingStudent.surname || ''}`.trim() : 'Crear ficha'}</h3></div></div><button onClick={() => setShowModal(false)} className="w-9 h-9 rounded-md border border-[#DDBFA4] text-[#8B6B5E] flex items-center justify-center hover:bg-[#F0E2D6] hover:text-[#7B3F22] transition-colors" aria-label="Cerrar ficha"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 6l12 12M18 6 6 18" /></svg></button></div>
          {editingStudent && liveEditingStudent && <div className="px-4 sm:px-7 py-3 border-b border-[#E6D8CB] bg-[#FDFBF9] shrink-0" data-testid="student-payment-action">{studentHasPendingPayment(liveEditingStudent) ? <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-[13px] font-semibold text-[#A85D3B]">Pago pendiente</p><button type="button" onClick={() => void confirmVisiblePayment()} disabled={isSubmitting} className="h-11 px-5 bg-[#7B3F22] text-white rounded-md text-[14px] font-bold hover:bg-[#63321C] disabled:opacity-60">Confirmar pago</button></div> : <p data-testid="payment-state" className="inline-flex min-h-10 items-center rounded-md bg-[#F5F1E9] px-3 text-[13px] font-bold text-[#7B3F22]">{getStudentPaymentStatus(liveEditingStudent) === 'paid' ? 'Pago al día' : 'Pago desconocido'}</p>}</div>}

            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 pb-28 sm:px-7 md:pb-28"><form onSubmit={handleSubmit} className={`grid grid-cols-1 gap-6 py-5 md:py-6 ${editingStudent ? 'lg:grid-cols-[1.2fr_1fr] lg:gap-8' : ''}`}>
              <div className="space-y-5">
               <section>
                <div className="mb-3"><h4 className="text-[14px] font-bold text-[#7B3F22]">Información personal</h4><p className="text-[11px] text-[#8B6B5E]">Los campos con * son obligatorios.</p></div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block text-[12px] font-medium text-[#7B3F22]">Nombre <abbr title="obligatorio" className="text-[#9C4235] no-underline">*</abbr><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre" aria-label="Nombre" className="mt-1 h-11 w-full px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></label>
                  <label className="block text-[12px] font-medium text-[#7B3F22]">Apellidos<input value={form.surname} onChange={(e) => setForm({ ...form, surname: e.target.value })} placeholder="Apellidos" aria-label="Apellidos" className="mt-1 h-11 w-full px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></label>
                  <label className="block text-[12px] font-medium text-[#7B3F22] sm:col-span-2">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" aria-label="Email" className="mt-1 h-11 w-full px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></label>
                  <label className="block text-[12px] font-medium text-[#7B3F22] sm:col-span-2">Teléfono<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Teléfono" aria-label="Teléfono" className="mt-1 h-11 w-full px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></label>
                </div>
              </section>
               <section className="border-t border-[#E6D8CB] pt-3"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-2">Actividad y categoría</h4><div className="grid grid-cols-2 gap-1.5"><select value={form.classType} onChange={(e) => setForm({ ...form, classType: e.target.value })} aria-label="Tipo de clase" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option>Modelado</option><option>Torno</option><option>Coworking</option><option>Iniciación</option></select><select disabled={!!editingStudent} value={form.studentCategory} onChange={(e) => requestCategoryChange(e.target.value as StudentCategoryValue)} aria-label="Categoría del alumno" className="col-span-2 h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option value="membresia">Membresía</option><option value="temporal">Bonos de clases</option><option value="grupal">Grupal</option><option value="grupo_temporal">Grupo temporal</option></select><select disabled={managedEdit || !editingStudent} value={form.paymentStatus} onChange={(e) => setForm({ ...form, paymentStatus: e.target.value as 'paid' | 'pending' })} aria-label="Estado del pago" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option value="unknown">Pago desconocido</option><option value="paid">Pago al día</option><option value="pending">Pago pendiente</option></select><input disabled={managedEdit || form.studentCategory === 'membresia'} type="number" value={form.price} onChange={(e) => setForm({ ...form, price: parseInt(e.target.value) })} placeholder="Cuota" aria-label="Cuota" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952]" /></div></section>
                {form.studentCategory === 'membresia' && (!editingStudent || hasVerifiedMembership(editingStudent)) && <div className="grid grid-cols-3 gap-1.5 mt-2">
                    {(['plata', 'gold', 'platinum'] as MembershipTier[]).map(tier => <button key={tier} type="button" disabled={managedEdit} onClick={() => requestMembershipTierChange(tier)} className={`min-h-11 rounded-lg border px-2 text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${form.membershipTier === tier ? 'border-brand bg-brand text-white shadow-sm' : 'border-neutral-border bg-white text-neutral-textMain hover:border-brand hover:text-brand'}`}><span>{MEMBERSHIP_PLANS[tier].label}</span><span className={`block text-[11px] font-medium normal-case tracking-normal ${form.membershipTier === tier ? 'text-white/90' : 'text-neutral-textSec'}`}>{MEMBERSHIP_PLANS[tier].price}€ · {MEMBERSHIP_PLANS[tier].bonuses} clases</span></button>)}
               </div>}

               
               {editingStudent && studentGiftCardBalance(editingStudent.id, giftCards).allCards.length > 0 && (() => {
                 const balance = studentGiftCardBalance(editingStudent.id, giftCards);
                 return (
                   <section className="border-t border-[#E6D8CB] pt-3" aria-label="Bonos regalo vinculados">
                     <h4 className="text-[14px] font-bold text-[#7B3F22] mb-2">Bonos regalo vinculados</h4>
                     <div className="grid grid-cols-2 gap-1.5 mb-3">
                       <div>
                         <label className="block text-[16px] font-medium text-[#7B3F22] mb-1">Clases contratadas</label>
                         <div className="flex h-10 items-center justify-center rounded-md border border-[#E7B899] bg-white">
                           <input type="number" readOnly value={balance.contracted} aria-label="Clases contratadas" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                         </div>
                       </div>
                       <div>
                         <div className="flex items-center justify-between mb-1"><label className="block text-[16px] font-medium text-[#7B3F22]">Clases restantes</label><span className="text-[11px] font-bold text-[#A85D3B]">{balance.remaining}/{balance.contracted}</span></div>
                         <div className="flex h-10 items-center justify-center rounded-md border border-[#E7B899] bg-white">
                           <input type="number" readOnly value={balance.remaining} aria-label="Clases restantes" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                         </div>
                       </div>
                     </div>
                     <div className="h-1 bg-[#F0E5DB] rounded-full overflow-hidden mb-3"><div className={`h-full ${balance.remaining <= 0 ? 'bg-[#A85D3B]' : 'bg-[#7B3F22]'}`} style={{ width: `${Math.min(100, balance.contracted ? (balance.remaining / balance.contracted) * 100 : 0)}%` }} /></div>
                     <ul className="space-y-2">
                       {balance.allCards.map(card => (
                         <li key={card.id} className="rounded-md border border-[#E6D8CB] bg-white px-3 py-2.5">
                           <p className="text-[13px] font-bold text-[#7B3F22]">{card.code || 'Sin código'} · {giftCardTypeLabel(card.type)}</p>
                           <p className="text-[12px] text-[#8B6B5E]">{giftCardSessionsRemaining(card)} / {card.numClasses} clases · {card.price != null ? `${card.price} €` : 'Sin importe'} · {giftCardPaymentLabel(card.paymentStatus)}</p>
                           <p className="text-[12px] text-[#8B6B5E]">Comprador: {card.buyer || 'Sin comprador'}{card.buyerEmail ? ` · ${card.buyerEmail}` : ''}{card.buyerPhone ? ` · ${card.buyerPhone}` : ''}</p>
                           {card.recipientEmail && <p className="text-[12px] text-[#8B6B5E]">Email del destinatario: {card.recipientEmail}</p>}
                           {card.dedication && <p className="text-[12px] text-[#7B3F22]">«{card.dedication}»</p>}
                           {card.status === 'cancelled' && <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#9C4235]">Anulado (no cuenta en el saldo)</p>}
                         </li>
                       ))}
                     </ul>
                   </section>
                 );
               })()}

               {editingStudent && (editingStudent.studentCategory ?? 'membresia') === 'membresia' && !hasVerifiedMembership(editingStudent) ? <p className="rounded-lg border border-neutral-border p-3 text-sm">{studentBalanceLabel(editingStudent, giftCards)}. Plan por confirmar. Este dato de origen no acredita un período ni un pago.</p> : <>
               {!(editingStudent && form.studentCategory !== 'membresia' && studentGiftCardBalance(editingStudent.id, giftCards).allCards.length > 0) && <fieldset disabled={managedEdit || form.studentCategory === 'membresia'} className="border-t border-[#E6D8CB] pt-3">
                 <div className="flex items-baseline justify-between mb-2">
                  <h4 className="text-[14px] font-bold text-[#7B3F22]">Bono de clases</h4>
                </div>
                 <div className="grid grid-cols-2 gap-1.5">
                  <div>
                      <label className="block text-[16px] font-medium text-[#7B3F22] mb-1">Clases contratadas</label>
                     <div className="flex items-center bg-white border border-[#E7B899] rounded-md overflow-hidden h-10">
                       <button type="button" onClick={() => setForm(f => ({ ...f, bonosAsignados: Math.max(1, f.bonosAsignados - 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Reducir clases">-</button>
                      <input type="number" readOnly value={form.bonosAsignados} aria-label="Clases contratadas" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                       <button type="button" onClick={() => setForm(f => ({ ...f, bonosAsignados: Math.min(isNonMembershipCategory(f.studentCategory) ? TEMPORAL_MAX_BONOS : MEMBERSHIP_PLANS[f.membershipTier].bonuses, f.bonosAsignados + 1), classesRemaining: isNonMembershipCategory(f.studentCategory) ? Math.min(TEMPORAL_MAX_BONOS, Math.max(f.classesRemaining, f.bonosAsignados + 1)) : f.classesRemaining }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Aumentar clases">+</button>
                    </div>
                  </div>
                  <div>
                     <div className="flex items-center justify-between mb-1"><label className="block text-[16px] font-medium text-[#7B3F22]">Clases restantes</label><span className="text-[11px] font-bold text-[#A85D3B]">{form.classesRemaining}/{form.bonosAsignados}</span></div>
                     <div className="flex items-center bg-white border border-[#E7B899] rounded-md overflow-hidden h-10">
                       <button type="button" onClick={() => requestRemainingClassChange(-1)} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Reducir clases restantes">-</button>
                      <input type="number" readOnly value={form.classesRemaining} aria-label="Clases restantes" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                        <button type="button" onClick={() => requestRemainingClassChange(1)} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Aumentar clases restantes">+</button>
                    </div>
                  </div>
                </div>
                 <div className="h-1 bg-[#F0E5DB] rounded-full overflow-hidden mt-2"><div className={`h-full ${form.classesRemaining <= 0 ? 'bg-[#A85D3B]' : 'bg-[#7B3F22]'}`} style={{ width: `${Math.min(100, (form.classesRemaining / form.bonosAsignados) * 100)}%` }} /></div>
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2">
                    {form.studentCategory === 'membresia' && <p className="text-[12px] text-[#8B6B5E]">Membresía pendiente durante los cinco días posteriores al vencimiento y vencida desde el sexto. Renovar no confirma el pago ni reactiva una ficha archivada.</p>}
                </div>
              </fieldset>}
               </>}
              <label className="block text-[12px] font-medium text-[#7B3F22]">Fecha de vencimiento<DateField disabled={managedEdit} value={form.expiryDate} onChange={expiryDate => setForm({ ...form, expiryDate })} aria-label="Fecha de vencimiento de membresía" className="mt-1 h-10 w-full max-w-xs px-2.5 bg-white border border-[#E7B899] rounded-md text-[13px] text-[#7B3F22] outline-none focus:border-[#C68952] disabled:cursor-not-allowed disabled:opacity-60" /></label>
              {!editingStudent && <section className="border-t border-[#E6D8CB] pt-3"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-3">Observaciones internas</h4><textarea value={form.observations} onChange={(e) => setForm({ ...form, observations: e.target.value })} placeholder="Preferencias, nivel o avisos relevantes" aria-label="Observaciones internas" className="w-full min-h-[120px] p-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none resize-y focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></section>}
              {managedEdit && <p className="text-sm">El perfil no modifica categoría, plan, fechas, precio, clases ni pagos. Usa las acciones de período. No se puede revertir un pago confirmado ni eliminar el historial; el archivo manual sigue disponible.</p>}
            </div>

             {editingStudent && <div id="student-attendance-panel" className="space-y-7">
               <style>{`#student-attendance-panel > section:first-of-type { display: none; }`}</style>
              <section><div className="flex items-baseline justify-between mb-3"><h4 className="text-[14px] font-bold text-[#7B3F22]">Asistencia</h4><span className="text-[11px] text-[#8B6B5E]">Registro de sesiones</span></div><div className="space-y-2 max-h-52 overflow-y-auto custom-scrollbar">{form.assignedClasses.length === 0 ? <p className="py-6 border border-dashed border-[#DDBFA4] rounded-md text-center text-[12px] text-[#8B6B5E]">No hay asistencias registradas aún.</p> : form.assignedClasses.map((ac, idx) => <div key={idx} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-white border border-[#E6D8CB] rounded-md"><div><p className="text-[13px] font-bold text-[#7B3F22]">{formatDate(ac.date)}</p><p className="text-[11px] text-[#8B6B5E]">{formatTime(ac.startTime)} - {formatTime(ac.endTime)}</p></div><div className="flex gap-1"><button type="button" onClick={() => { const updated = [...form.assignedClasses]; updated[idx].status = updated[idx].status === 'present' ? 'pending' : 'present'; setForm({ ...form, assignedClasses: updated }); }} className={`w-8 h-8 rounded-md flex items-center justify-center border ${ac.status === 'present' ? 'bg-[#7B3F22] text-white border-[#7B3F22]' : 'bg-white text-[#8B6B5E] border-[#DDBFA4]'}`} aria-label="Marcar presente">✓</button><button type="button" onClick={() => { const updated = [...form.assignedClasses]; updated[idx].status = updated[idx].status === 'absent' ? 'pending' : 'absent'; setForm({ ...form, assignedClasses: updated }); }} className={`w-8 h-8 rounded-md flex items-center justify-center border ${ac.status === 'absent' ? 'bg-[#A85D3B] text-white border-[#A85D3B]' : 'bg-white text-[#8B6B5E] border-[#DDBFA4]'}`} aria-label="Marcar ausente">×</button></div></div>)}</div><div className="grid grid-cols-[1fr_1fr_44px] gap-2 mt-3"><DateField value={newSessionDate} onChange={setNewSessionDate} aria-label="Fecha de asistencia" className="h-10 px-2 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22]" /><TimeField value={newSessionTime} onChange={setNewSessionTime} aria-label="Hora de asistencia" className="h-10 px-2 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22]" /><button type="button" onClick={handleAddSession} className="h-10 rounded-md bg-[#F0E2D6] text-[#7B3F22] text-lg hover:bg-[#DDBFA4]" aria-label="Añadir asistencia">+</button></div></section>
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
                    return <div key={monthKey} className="rounded-md border border-[#E6D8CB] bg-white overflow-hidden"><button type="button" onClick={() => setExpandedAttendanceMonth(isExpanded ? currentMonthKey : monthKey)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[#FCF8F4]"><span className="text-[12px] font-bold capitalize text-[#7B3F22]">{formatMonthLabel(monthKey)}</span><span className="text-[11px] text-[#8B6B5E]">{presentCount} presentes · {absentCount} faltas <span className="ml-1">{isExpanded ? '−' : '+'}</span></span></button>{isExpanded && <div className="border-t border-[#E6D8CB] px-3 py-2 space-y-1.5">{records.map((record, index) => <div key={`${record.date}-${record.startTime}-${index}`} className="flex items-center justify-between text-[11px]"><span className="text-[#7B3F22]">{formatDate(record.date)} · {formatTime(record.startTime)} - {formatTime(record.endTime)}</span><span className={`font-bold ${record.status === 'present' ? 'text-[#47704D]' : 'text-[#9C4235]'}`}>{record.status === 'present' ? 'Presente' : 'Falta'}</span></div>)}</div>}</div>;
                  })}</div>}
                </section>
               <section className="border-t border-[#E6D8CB] pt-6"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-3">Observaciones internas</h4><textarea value={form.observations} onChange={(e) => setForm({ ...form, observations: e.target.value })} placeholder="Preferencias, nivel o avisos relevantes" aria-label="Observaciones internas" className="w-full min-h-[120px] p-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none resize-y focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></section>
               <div className="text-[11px] text-[#8B6B5E] border-t border-[#E6D8CB] pt-4">{editingStudent?.createdAt ? `Ficha creada el ${formatDate(editingStudent.createdAt)}` : 'La ficha se registrará al guardar.'}</div>
               {managedEdit && liveEditingStudent && <section className="space-y-3 border-t pt-4">
                 <h4 className="font-bold">Períodos y pagos</h4>
                 {(liveEditingStudent.membershipPeriods || []).map(period => <div key={period.id} className="border rounded p-3 text-sm">
                   <p>{period.startsOn ? formatDate(period.startsOn) : 'Sin inicio'} — {period.endsOn ? formatDate(period.endsOn) : 'Sin vencimiento'} · {period.membershipTier || 'Plan desconocido'}</p>
                   <p>{period.id === liveEditingStudent.effectivePeriodId ? 'Período actual' : period.startsOn && period.startsOn > today ? 'Renovación programada' : 'Historial'} · {period.paymentStatus === 'paid' ? 'Pagado' : period.paymentStatus === 'pending' ? 'Pago pendiente' : 'Pago desconocido'}</p>
                   {period.paymentStatus !== 'paid' && <button type="button" disabled={isSubmitting} onClick={() => void runMembershipAction(() => onConfirmPayment(liveEditingStudent.id, period.id))}>Confirmar pago de este período</button>}
                 </div>)}
                 {!liveEditingStudent.effectivePeriodId && <div className="space-y-2">
                   <p>Registro legado: confirma el plan y las fechas antes de inicializar un período. El precio y el saldo no determinan el plan.</p>
                   <button type="button" disabled={isSubmitting || !liveEditingStudent.membershipTier || !liveEditingStudent.expiryDate} onClick={() => void runMembershipAction(() => onActivateMembership(liveEditingStudent.id))}>Inicializar período</button>
                 </div>}
                 <label>Plan del próximo período <select value={renewalTier} disabled={isSubmitting || !!renewalIntentRef.current} onChange={event => setRenewalTier(event.target.value as MembershipTier)}><option value="">Selecciona un plan confirmado</option>{Object.entries(MEMBERSHIP_PLANS).map(([tier, plan]) => <option key={tier} value={tier}>{plan.label} · {plan.price}€ · {plan.bonuses} clases</option>)}</select></label>
                 <p>Renovar programa un único sucesor pendiente; conserva las clases y el pago actuales hasta su inicio.</p>
                 <button type="button" disabled={isSubmitting || !renewalTier || !hasVerifiedMembership(liveEditingStudent)} onClick={handleRenewMembership}>Programar renovación / reintentar</button>
                 <p>{studentBalanceLabel(liveEditingStudent)}</p>
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
            </div>}
          </form>
          {editingStudent && students.find(student => student.id === editingStudent.id) && <StudentCreditPanel key={editingStudent.id}
            student={students.find(student => student.id === editingStudent.id)!} today={today}
            onApproveManualCredit={onApproveManualCredit} onSettlePendingPenalty={onSettlePendingPenalty}
            onWaivePendingPenalty={onWaivePendingPenalty} canManageStudentCredits={canManageStudentCredits}
            getPendingStudentCreditOperation={getPendingStudentCreditOperation} onRetryPendingStudentCreditOperation={onRetryPendingStudentCreditOperation} />}
          {editingStudent && !managedEdit && <section aria-label="Zona de peligro"><DangerZone description={`Eliminar a ${`${editingStudent.name} ${editingStudent.surname || ''}`.trim()} borra la ficha para siempre. No se puede deshacer. Si solo quieres ocultarla, usa Archivar.`} actionLabel="Eliminar alumno" disabled={isSubmitting} onAction={() => setStudentToDelete(editingStudent.id)} /></section>}
          </div>

          <div className="absolute bottom-0 left-0 right-0 px-4 sm:px-7 py-3 bg-[#FDFBF9]/95 backdrop-blur border-t border-[#E6D8CB] flex items-center justify-end gap-3 shrink-0 z-10"><button type="button" onClick={() => setShowModal(false)} className="h-10 px-3 text-[11px] font-bold uppercase tracking-[0.1em] text-[#8B6B5E] hover:text-[#7B3F22]">Cancelar</button><button onClick={handleSubmit} disabled={isSubmitting} className="h-10 px-4 sm:px-5 bg-[#7B3F22] text-white rounded-md text-[11px] font-bold uppercase tracking-[0.1em] hover:bg-[#63321C] transition-colors disabled:opacity-60 disabled:cursor-not-allowed">{isSubmitting ? 'Guardando...' : (editingStudent ? 'Guardar cambios' : 'Guardar alumno')}</button></div>
        </div>
      </div>}
        <ConfirmModal isOpen={!!pendingCategory} title="¿Cambiar categoría?" message={`Vas a cambiar este alumno a ${pendingCategory ? studentCategoryLabel(pendingCategory) : ''}. Se ajustarán sus clases y la renovación automática.`} confirmText="Cambiar categoría" isDestructive={false} onConfirm={() => { if (pendingCategory) applyCategoryChange(pendingCategory); }} onCancel={() => setPendingCategory(null)} />
        <ConfirmModal isOpen={!!pendingMembershipTier} title="¿Cambiar nivel?" message={`Vas a cambiar la membresía a ${pendingMembershipTier ? MEMBERSHIP_PLANS[pendingMembershipTier].label : ''}. Se actualizarán el precio y las clases contratadas.`} confirmText="Cambiar nivel" isDestructive={false} onConfirm={() => { if (pendingMembershipTier) applyMembershipTierChange(pendingMembershipTier); }} onCancel={() => setPendingMembershipTier(null)} />
        <ConfirmModal isOpen={!!studentToArchive} title="¿Archivar alumno?" message="El alumno dejará de aparecer entre los activos. Podrás reactivarlo con la acción Reactivar alumno manualmente, sin renovar ni confirmar un pago." confirmText="Archivar" isDestructive={false} onConfirm={async () => { if (studentToArchive && !isSubmitting) { setIsSubmitting(true); try { await onUpdate(studentToArchive, { archivedAt: getWorkshopDate() }); setStudentToArchive(null); setShowModal(false); setEditingStudent(null); } catch (error: any) { showError(error.message || 'No se pudo archivar.'); } finally { setIsSubmitting(false); } } }} onCancel={() => setStudentToArchive(null)} />
       <ConfirmModal isOpen={!!studentToDelete} title="¿Eliminar alumno?" message={deleteStudentMessage(students.find(student => student.id === studentToDelete))} isDestructive={true} onConfirm={async () => { if (studentToDelete && !isSubmitting) { setIsSubmitting(true); try { await onDeleteStudent(studentToDelete); setStudentToDelete(null); setShowModal(false); setEditingStudent(null); } catch (error: any) { showError(error.message || 'No se pudo eliminar.'); } finally { setIsSubmitting(false); } } }} onCancel={() => setStudentToDelete(null)} />
       {pendingClassAdjustment && <ClassAdjustmentDialog current={pendingClassAdjustment.current} next={pendingClassAdjustment.next} loading={isSubmitting} onCancel={() => { if (!isSubmitting) setPendingClassAdjustment(null); }} onConfirm={reason => void confirmRemainingClassChange(reason)} />}
    </div>
  );
};

export default StudentList;
