import { showError } from '../context/toast';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ClassSession, GiftCard, Student, ClassAdjustmentIntent, SessionActivityBlock, SessionBusinessIntent, PendingSessionOperation, Teacher, WorkshopScheduleDay, WorkshopScheduleException, WorkshopCapacityDefault, getDefaultSessionCapacity } from '../types';
import { getStudentLifecycle, isStudentArchived } from '../utils/studentLifecycle';
import { useWorkshopDate } from '../utils/useWorkshopDate';
import { capacityDefaultsToMap, getSessionOccupancy } from '../utils/sessionCapacity';
import { getScheduleConflictReason, madridDateKey } from '../utils/workshopSchedule';
interface CalendarViewProps {
  readOnly?: boolean;
  sessions: ClassSession[];
  onAddSession: (session: Omit<ClassSession, 'id'>) => Promise<void>;
  onUpdateSession: (id: string, updates: Partial<ClassSession>) => Promise<boolean | void>;
  onDeleteSession?: (id: string) => Promise<void>;
  onAdjustClasses?: (intent: ClassAdjustmentIntent) => Promise<void>;
  onUpdateStudent?: (id: string, updates: Partial<Student>) => Promise<void>;
  onRedeemGiftCardSession?: (giftCardId: string, sessionId: string, studentId?: string) => Promise<void>;
  onReverseGiftCardSession?: (giftCardId: string | undefined, sessionId: string, studentId?: string) => Promise<boolean | void>;
  onApproveSessionException?: (intent: SessionBusinessIntent) => Promise<void>;
  onCancelSessionReservation?: (intent: SessionBusinessIntent) => Promise<void>;
  onWaiveSessionPenalty?: (intent: SessionBusinessIntent) => Promise<void>;
  getPendingSessionOperation?: (id?: string) => PendingSessionOperation | null;
  onRetryPendingSessionOperation?: (id?: string) => Promise<void>;
  canWaiveSessionPenalty?: boolean | ((session: ClassSession) => boolean);
  giftCards: GiftCard[];
  students: Student[];
  teachers: Teacher[];
  workshopSchedule: WorkshopScheduleDay[];
  workshopScheduleExceptions: WorkshopScheduleException[];
  capacityDefaults: WorkshopCapacityDefault[];
}

type CalendarMode = 'day' | 'month';
type AttendanceStatus = 'present' | 'absent' | 'pending';

type SaveAttempt =
  | { kind: 'attendance'; id: string; updates: Partial<ClassSession> }
  | { kind: 'reservation'; id: string | null; updates: Omit<ClassSession, 'id'> }
  | { kind: 'business'; id: string; intent: SessionBusinessIntent }
  | { kind: 'recovery'; id: string | null; descriptor: PendingSessionOperation };

const pendingOperationLabels: Record<PendingSessionOperation['operation'], string> = {
  attendance: 'Guardar asistencia', reservation: 'Guardar reserva', approve_exception: 'Aprobar excepción',
  cancel_reservation: 'Cancelar reserva', waive_penalty: 'Eximir penalización'
};

const hasPersistedRoster = (session: ClassSession) => Array.isArray(session.studentIds)
  && session.studentIds.length === session.students.length
  && session.studentIds.every(id => !!id)
  && new Set(session.studentIds).size === session.studentIds.length;
const getAttendanceStatus = (session: ClassSession, studentId?: string): AttendanceStatus =>
  studentId ? session.attendanceByStudentId?.[studentId] || 'pending' : 'pending';
const isCancelled = (session: ClassSession, studentId: string) => session.attendancePolicyVersion === 2
  && session.businessStateByStudentId?.[studentId]?.reservationState === 'cancelled';
const shortId = (id: string) => id.slice(-8);

const CalendarView: React.FC<CalendarViewProps> = ({ readOnly = false, sessions, onAddSession, onUpdateSession, onApproveSessionException, onCancelSessionReservation, onWaiveSessionPenalty, getPendingSessionOperation, onRetryPendingSessionOperation, canWaiveSessionPenalty, giftCards, students, teachers, workshopSchedule, workshopScheduleExceptions, capacityDefaults }) => {
  const capacityMap = useMemo(() => capacityDefaultsToMap(capacityDefaults), [capacityDefaults]);
  const getSessionCapacity = (classType: ClassSession['classType']) => classType === 'mixto'
    ? getDefaultSessionCapacity('mesa', capacityMap) + getDefaultSessionCapacity('torno', capacityMap)
    : getDefaultSessionCapacity(classType, capacityMap);
  const location = useLocation();
  const deepLinkHandledRef = useRef('');
  const submittingRef = useRef(false);
  const [viewMode, setViewMode] = useState<CalendarMode>('day');
  const today = useWorkshopDate();
  const [selectedDate, setSelectedDate] = useState(new Date());

  // Modales separados
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [attendanceSession, setAttendanceSession] = useState<ClassSession | null>(null);
  const [isEditingAttendance, setIsEditingAttendance] = useState(false);
  const [attendanceEditBaseline, setAttendanceEditBaseline] = useState<{ attendance: ClassSession['attendanceByStudentId']; substituteId: string } | null>(null);
  const [substituteId, setSubstituteId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingSave, setPendingSave] = useState<SaveAttempt | null>(null);
  const [saveError, setSaveError] = useState('');
  const [refreshConflict, setRefreshConflict] = useState<{ kind: Exclude<SaveAttempt['kind'], 'recovery'>; id: string; revision?: number } | null>(null);
  const formLocked = readOnly || isSubmitting || !!pendingSave || !!refreshConflict;
  const [studentSearchQuery, setStudentSearchQuery] = useState('');
  const [businessForms, setBusinessForms] = useState<Record<string, { reason: string; kind: 'membership_override' | 'no_credit'; cancellationReason: string; waiverReason: string }>>({});
  const policy2 = attendanceSession?.attendancePolicyVersion === 2;
  const mayWaivePenalty = !!attendanceSession && (typeof canWaiveSessionPenalty === 'function'
    ? canWaiveSessionPenalty(attendanceSession) : !!canWaiveSessionPenalty);
  const storedAttendanceSession = sessions.find(session => session.id === attendanceSession?.id);
  const attendanceDirty = !!attendanceSession && (!storedAttendanceSession
    || substituteId !== (storedAttendanceSession.teacherSubstituteId || '')
    || attendanceSession.studentIds?.some(id => getAttendanceStatus(attendanceSession, id) !== getAttendanceStatus(storedAttendanceSession, id)));
  const editingReservation = sessions.find(session => session.id === editingSessionId);

  const HOUR_HEIGHT = 140;

  const [sessionForm, setSessionForm] = useState({
    date: '',
    startTime: '10:00',
    endTime: '12:00',
    classType: 'mesa' as ClassSession['classType'],
    capacity: getSessionCapacity('mesa'),
    selectedStudents: [] as string[],
    giftCardIdByStudentId: {} as Record<string, string>,
    manualCreditIdByStudentId: {} as Record<string, string>,
    revision: undefined as number | undefined,
    teacherId: '',
    workshopName: '',
    privateReason: '',
    sessionAudience: 'membresia' as 'membresia' | 'temporal' | 'ambos',
    activityBlocks: [] as SessionActivityBlock[]
  });
  const activeSelectedCount = sessionForm.selectedStudents.filter(id => !editingReservation || !isCancelled(editingReservation, id)).length;

  const getStudentName = (studentId: string, session?: ClassSession) => {
    const student = students.find(item => item.id === studentId);
    if (student) return `${student.name} ${student.surname || ''}`.trim();
    const index = session && hasPersistedRoster(session) ? session.studentIds!.indexOf(studentId) : -1;
    return index >= 0 ? session!.students[index] : `Alumno (${shortId(studentId)})`;
  };
  const getSessionRoster = (session: ClassSession) => hasPersistedRoster(session)
    ? session.studentIds!.map(id => ({ id, name: getStudentName(id, session) }))
    : session.students.map(name => ({ id: undefined, name }));
  const getActiveRosterCount = (session: ClassSession) => session.attendancePolicyVersion === 2 && hasPersistedRoster(session)
    ? session.studentIds!.filter(id => !isCancelled(session, id)).length
    : getSessionOccupancy(session, capacityMap).enrolled;
  const getFundingCards = (studentId: string) => giftCards.filter(card => card.recipientStudentId === studentId
    && card.status === 'active' && !card.consumedAt && (card.sessionsRemaining || 0) > 0
    && (!card.expiryDate || card.expiryDate.slice(0, 10) >= madridDateKey()));
  const getFundingManualCredits = (student: Student | undefined) => {
    if (!student?.sedeId || isStudentArchived(student, today) || (editingReservation && editingReservation.attendancePolicyVersion !== 2)) return [];
    const sedeId = editingReservation ? editingReservation.sedeId : student.sedeId;
    const earliest = sessionForm.date < today ? sessionForm.date : today;
    const latest = sessionForm.date > today ? sessionForm.date : today;
    return (student.manualCredits || []).filter(credit => credit.studentId === student.id && credit.sedeId === sedeId
      && credit.sedeId === student.sedeId && credit.activity === sessionForm.classType && credit.remainingClasses > 0
      && credit.startsOn <= earliest && credit.endsOn >= latest);
  };

  const sessionToForm = (session: ClassSession) => ({
    date: session.date, startTime: session.startTime, endTime: session.endTime, classType: session.classType,
    capacity: session.capacity ?? getSessionCapacity(session.classType),
    selectedStudents: [...session.studentIds!], giftCardIdByStudentId: { ...(session.giftCardIdByStudentId || {}) },
    manualCreditIdByStudentId: { ...(session.manualCreditIdByStudentId || {}) }, revision: session.revision,
    teacherId: session.teacherId || '', workshopName: session.workshopName || '', privateReason: session.privateReason || '',
    sessionAudience: session.sessionAudience || 'membresia',
    activityBlocks: session.activityBlocks?.map(block => ({ ...block, studentIds: [...block.studentIds] })) || []
  });

  const formatDateKey = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const formatSessionDate = (dateValue: string) => {
    const parts = dateValue.split('-').map(Number);
    if (parts.length === 3 && parts.every(n => Number.isFinite(n))) {
      const [year, month, day] = parts;
      return new Date(year, month - 1, day).toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      });
    }
    return new Date(dateValue).toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
  };

  const getTeacherName = (teacherId?: string) => {
    if (!teacherId) return 'Sin profesor';
    const teacher = teachers.find(t => t.id === teacherId);
    if (!teacher) return 'Sin profesor';
    return `${teacher.name} ${teacher.surname || ''}`.trim();
  };

  const getTeacherSpecialty = (teacherId?: string) => {
    if (!teacherId) return '';
    const teacher = teachers.find(t => t.id === teacherId);
    return teacher?.specialty || '';
  };

  const getSessionLabel = (session: ClassSession) => {
    const map: Record<ClassSession['classType'], string> = {
      mesa: 'Mesa',
      torno: 'Torno',
      mixto: 'Mixto',
      coworking: 'Coworking',
      workshop: 'Workshop',
      privada: 'Privadas',
      feriado: 'Feriados'
    };
    return map[session.classType];
  };

  const requiresTeacher = (type: ClassSession['classType']) => type === 'mesa';
  const requiresWorkshopName = (type: ClassSession['classType']) => type === 'workshop';
  const requiresPrivateReason = (type: ClassSession['classType']) => type === 'privada';

  const getSessionBadgeClasses = (type: ClassSession['classType']) => {
    switch (type) {
      case 'torno':
        return 'bg-[#20663B]';
      case 'coworking':
        return 'bg-green-500';
      case 'workshop':
        return 'bg-brand';
      case 'privada':
        return 'bg-orange-500';
      case 'feriado':
        return 'bg-neutral-textHelper';
      default:
        return 'bg-brand';
    }
  };

  const restorePendingOperation = (session?: ClassSession) => {
    if (!getPendingSessionOperation) return false;
    try {
      let descriptor = getPendingSessionOperation(session?.id);
      if (!descriptor && session) descriptor = getPendingSessionOperation();
      for (const candidate of sessions) {
        if (descriptor) break;
        descriptor = getPendingSessionOperation(candidate.id);
      }
      if (!descriptor) return false;
      if (!onRetryPendingSessionOperation) {
        showError('Hay una operación pendiente, pero su recuperación no está disponible. No se creará otro intento.');
        return true;
      }
      const latest = sessions.find(item => item.id === descriptor.sessionId);
      if (!descriptor.isNewSession && (!latest || !hasPersistedRoster(latest))) {
        showError('Recarga el roster de la sesión pendiente antes de recuperar su intento.');
        return true;
      }
      setSaveError('');
      setPendingSave({ kind: 'recovery', id: descriptor.isNewSession ? null : descriptor.sessionId, descriptor });
      if (descriptor.operation === 'reservation') {
        setEditingSessionId(descriptor.isNewSession ? null : descriptor.sessionId);
        if (!descriptor.isNewSession) setSessionForm(sessionToForm(latest!));
        else setSessionForm(prev => ({ ...prev, date: formatDateKey(selectedDate) }));
        setShowAttendanceModal(false);
        setShowSessionModal(true);
      } else {
        setAttendanceSession(latest!);
        setSubstituteId(latest!.teacherSubstituteId || '');
        setBusinessForms({});
        setIsEditingAttendance(false);
        setAttendanceEditBaseline(null);
        setShowSessionModal(false);
        setShowAttendanceModal(true);
      }
      return true;
    } catch (error: any) {
      showError(error?.message || 'No se pudo leer el intento pendiente. No se creará otro intento.');
      return true;
    }
  };

  const recoveryAlert = pendingSave?.kind === 'recovery' && (
    <p role="alert" data-testid="pending-session-operation" data-operation={pendingSave.descriptor.operation} className="mx-5 mt-3 rounded-[10px] bg-[#F8EEE5] px-4 py-3 text-[12px] text-[#7B3F22] sm:mx-8">
      Operación pendiente: {pendingOperationLabels[pendingSave.descriptor.operation]}.
      {pendingSave.descriptor.studentId && ` Alumno: ${getStudentName(pendingSave.descriptor.studentId, attendanceSession || undefined)} (${shortId(pendingSave.descriptor.studentId)}).`}
      {pendingSave.descriptor.reason && ` Motivo: ${pendingSave.descriptor.reason}.`}
      {' Reintenta el intento guardado antes de editar, cerrar o iniciar otra operación. Se conservarán sus datos originales.'}
    </p>
  );

  // Abrir modal de Edición/Creación de Sesión
  const handleOpenSessionModal = (session?: ClassSession) => {
    if (formLocked) return;
    if (restorePendingOperation(session)) return;
    if (session && !hasPersistedRoster(session)) {
      showError('La reserva requiere IDs persistidos y alineados. Recarga la sesión; no se identificarán alumnos por nombre.');
      return;
    }
    setSaveError('');
    setStudentSearchQuery(''); // Limpiar búsqueda al abrir modal
    if (session) {
      setEditingSessionId(session.id);
      setSessionForm(sessionToForm(session));
    } else {
      setEditingSessionId(null);
      setSessionForm({
        date: formatDateKey(selectedDate),
        startTime: '10:00',
        endTime: '12:00',
        classType: 'mesa',
        capacity: getSessionCapacity('mesa'),
        selectedStudents: [],
        giftCardIdByStudentId: {},
        manualCreditIdByStudentId: {},
        revision: undefined,
        teacherId: '',
        workshopName: '',
        privateReason: '',
        sessionAudience: 'membresia',
        activityBlocks: []
      });
    }
    setShowSessionModal(true);
  };

  useEffect(() => {
    if (readOnly) return;
    const params = new URLSearchParams(location.search);
    const requestedDate = params.get('date');
    const requestedSessionId = params.get('sessionId');
    if (!requestedDate && !requestedSessionId) return;
    const openAttendance = params.get('attendance') === '1';
    const deepLinkKey = `${requestedDate || ''}:${requestedSessionId || ''}:${openAttendance}`;
    if (deepLinkHandledRef.current === deepLinkKey) return;
    if (requestedDate) setSelectedDate(new Date(`${requestedDate}T12:00:00`));
    if (requestedSessionId) {
      const requestedSession = sessions.find(session => session.id === requestedSessionId);
      if (!requestedSession) return;
      if (openAttendance) handleOpenAttendanceModal(requestedSession);
      else handleOpenSessionModal(requestedSession);
    }
    deepLinkHandledRef.current = deepLinkKey;
  }, [location.search, sessions, readOnly]);

  // Abrir modal de Control de Asistencia (Nueva funcionalidad separada)
  const handleOpenAttendanceModal = (session: ClassSession) => {
    if (formLocked) return;
    if (restorePendingOperation(session)) return;
    if (!hasPersistedRoster(session)) {
      showError('La asistencia requiere IDs persistidos y alineados. Recarga la sesión; no se identificarán alumnos por nombre.');
      return;
    }
    setSaveError('');
    setAttendanceSession(session);
    setBusinessForms({});
    setIsEditingAttendance(false);
    setAttendanceEditBaseline(null);
    setSubstituteId(session.teacherSubstituteId || '');
    setShowAttendanceModal(true);
  };

  const beginAttendanceEdit = () => {
    if (!attendanceSession || formLocked) return;
    setAttendanceEditBaseline({
      attendance: { ...(attendanceSession.attendanceByStudentId || {}) },
      substituteId: substituteId
    });
    setIsEditingAttendance(true);
  };

  const cancelAttendanceEdit = () => {
    if (formLocked) return;
    if (attendanceEditBaseline) {
      setAttendanceSession(prev => prev ? {
        ...prev,
        attendanceByStudentId: attendanceEditBaseline.attendance,
        teacherSubstituteId: attendanceEditBaseline.substituteId || undefined
      } : prev);
      setSubstituteId(attendanceEditBaseline.substituteId);
    }
    setIsEditingAttendance(false);
    setAttendanceEditBaseline(null);
  };

  const persistSave = async (attempt: SaveAttempt) => {
    if (readOnly || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setSaveError('');
    setPendingSave(attempt);
    const kind = attempt.kind === 'recovery'
      ? attempt.descriptor.operation === 'reservation' ? 'reservation' : attempt.descriptor.operation === 'attendance' ? 'attendance' : 'business'
      : attempt.kind;
    const revision = attempt.kind === 'recovery' ? attempt.descriptor.expectedRevision
      : attempt.kind === 'business' ? attempt.intent.expectedRevision : attempt.updates.revision;
    try {
      let result: boolean | void;
      if (attempt.kind === 'recovery') {
        if (!onRetryPendingSessionOperation) throw new Error('La recuperación del intento no está disponible.');
        result = await onRetryPendingSessionOperation(attempt.descriptor.isNewSession ? undefined : attempt.descriptor.sessionId);
      } else if (attempt.kind === 'business') {
        const callback = attempt.intent.operation === 'approve_exception' ? onApproveSessionException
          : attempt.intent.operation === 'cancel_reservation' ? onCancelSessionReservation : onWaiveSessionPenalty;
        if (!callback) throw new Error('La operación no está disponible. Conserva el intento para reintentar.');
        result = await callback(attempt.intent);
      } else {
        result = attempt.kind === 'reservation' && attempt.id === null
          ? await onAddSession(attempt.updates)
          : await onUpdateSession(attempt.id!, attempt.updates);
      }
      if (result === false) throw new Error('No se confirmó el guardado. Reintenta los mismos datos.');
      setPendingSave(null);
      if (kind === 'business') {
        setRefreshConflict({ kind: 'business', id: attempt.id!, revision });
      } else if (kind === 'attendance') {
        setShowAttendanceModal(false);
        setIsEditingAttendance(false);
        setAttendanceEditBaseline(null);
      } else {
        setShowSessionModal(false);
      }
    } catch (error: any) {
      // Only a SQL rejection proves rollback. Otherwise retry the same object,
      // including its timestamp/revision, to resolve the stored atomic receipt.
      const rolledBack = /^[0-9A-Z]{5}$/.test(error?.code || '')
        && !['08000', '08003', '08006', '57014'].includes(error.code)
        && !getPendingSessionOperation?.(attempt.id ?? undefined);
      if (rolledBack) setPendingSave(null);
      if (rolledBack && error?.code === '40001' && attempt.id) {
        setRefreshConflict({ kind, id: attempt.id, revision });
      }
      setSaveError(`${error?.message || 'No se pudo guardar la sesión.'}${rolledBack
        ? error.code === '40001' ? ' La sesión cambió. Revisa los datos recargados antes de guardar.' : ''
        : ' Resultado sin confirmar. Reintenta los mismos datos antes de editar o cerrar.'}`);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!refreshConflict) return;
    const latest = sessions.find(session => session.id === refreshConflict.id);
    if (!latest || latest.revision === refreshConflict.revision || !hasPersistedRoster(latest)) return;
    if (refreshConflict.kind === 'business' && (!Number.isSafeInteger(latest.revision)
      || latest.revision! <= refreshConflict.revision!)) return;
    if (refreshConflict.kind !== 'reservation') {
      setAttendanceSession(latest);
      setSubstituteId(latest.teacherSubstituteId || '');
      setIsEditingAttendance(false);
      setAttendanceEditBaseline(null);
    } else {
      setSessionForm(sessionToForm(latest));
    }
    setRefreshConflict(null);
  }, [sessions, refreshConflict]);

  const saveAttendance = async (finalize: boolean) => {
    if (readOnly || submittingRef.current || refreshConflict || !attendanceSession) return;
    if (pendingSave) {
      if (pendingSave.kind === 'attendance' || pendingSave.kind === 'recovery') await persistSave(pendingSave);
      return;
    }
    if (!hasPersistedRoster(attendanceSession) || !Number.isSafeInteger(attendanceSession.revision) || attendanceSession.revision! < 0) {
      setSaveError('Recarga la sesión para obtener su roster por ID y revisión antes de guardar.');
      return;
    }
    const attendanceByStudentId = Object.fromEntries(attendanceSession.studentIds!.map(id => [id, getAttendanceStatus(attendanceSession, id)]));
    if ((!policy2 || finalize || attendanceSession.completedAt)
      && attendanceSession.studentIds!.some(id => !isCancelled(attendanceSession, id) && attendanceByStudentId[id] === 'pending')) {
      setSaveError('Completa la asistencia de todos los alumnos antes de guardar.');
      return;
    }
    await persistSave({ kind: 'attendance', id: attendanceSession.id, updates: {
      attendanceByStudentId,
      revision: attendanceSession.revision,
      ...(finalize ? { completedAt: new Date().toISOString() } : {}),
      teacherSubstituteId: substituteId
    } });
  };

  const handleMarkAttendance = (studentId: string, status: AttendanceStatus) => {
    if (!attendanceSession || formLocked || !attendanceSession.studentIds?.includes(studentId) || isCancelled(attendanceSession, studentId)) return;
    setAttendanceSession({ ...attendanceSession, attendanceByStudentId: {
      ...(attendanceSession.attendanceByStudentId || {}), [studentId]: status
    } });
  };

  const handleBusinessOperation = async (studentId: string, operation: SessionBusinessIntent['operation']) => {
    if (submittingRef.current || formLocked || !attendanceSession || !policy2 || !attendanceSession.studentIds?.includes(studentId)) return;
    if (attendanceDirty) {
      setSaveError('Guarda primero la asistencia provisional o los cambios antes de realizar esta operación.');
      return;
    }
    if (!Number.isSafeInteger(attendanceSession.revision) || attendanceSession.revision! < 0) {
      setSaveError('Recarga la sesión para obtener su revisión antes de realizar esta operación.');
      return;
    }
    const form = businessForms[studentId];
    const reason = (operation === 'approve_exception' ? form?.reason
      : operation === 'cancel_reservation' ? form?.cancellationReason : form?.waiverReason)?.trim();
    if (!reason) {
      setSaveError('Indica un motivo para este alumno y esta operación.');
      return;
    }
    const business = attendanceSession.businessStateByStudentId?.[studentId];
    if (operation === 'waive_penalty') {
      if (!mayWaivePenalty || !onWaiveSessionPenalty || !business?.penaltyId
        || !['charged', 'pending'].includes(business.penaltyState || '')) return;
    } else if (attendanceSession.completedAt || isCancelled(attendanceSession, studentId)
      || (operation === 'approve_exception' && !onApproveSessionException)
      || (operation === 'cancel_reservation' && !onCancelSessionReservation)) return;
    // Freeze the identity before invoking the callback; uncertain failures retry it unchanged.
    const intent: SessionBusinessIntent = Object.freeze({ operation, sessionId: attendanceSession.id, studentId,
      requestKey: crypto.randomUUID(), expectedRevision: attendanceSession.revision!, reason,
      ...(operation === 'approve_exception' ? { kind: form?.kind || 'membership_override' } : {}) });
    await persistSave({ kind: 'business', id: attendanceSession.id, intent });
  };

  const handleSessionSubmit = async () => {
    if (readOnly || submittingRef.current || refreshConflict) return;
    if (pendingSave) {
      if (pendingSave.kind === 'reservation' || pendingSave.kind === 'recovery') await persistSave(pendingSave);
      return;
    }
    if (!sessionForm.date) {
      showError("Selecciona un día en el calendario antes de guardar.");
      return;
    }
    if (requiresTeacher(sessionForm.classType) && !sessionForm.teacherId) {
      showError("Debes asignar un profesor.");
      return;
    }
    if (sessionForm.classType === 'mixto') {
      const blocks = sessionForm.activityBlocks;
      const assigned = blocks.flatMap(block => block.studentIds);
      if (!blocks.some(block => block.activityType === 'mesa') || !blocks.some(block => block.activityType === 'torno')) {
        showError('Una sesión mixta debe incluir un bloque de Mesa y otro de Torno.');
        return;
      }
      if (new Set(assigned).size !== assigned.length || assigned.length === 0) {
        showError('Asigna cada alumno a un único bloque de actividad.');
        return;
      }
      if (blocks.some(block => block.studentIds.length > block.capacity)) {
        showError('Uno de los bloques supera su capacidad configurada.');
        return;
      }
    }
    if (requiresWorkshopName(sessionForm.classType) && !sessionForm.workshopName.trim()) {
      showError("Debes indicar el nombre del workshop.");
      return;
    }
    if (requiresPrivateReason(sessionForm.classType) && !sessionForm.privateReason.trim()) {
      showError("Debes indicar el motivo de la sesion privada.");
      return;
    }
    if (sessionForm.startTime >= sessionForm.endTime) {
      showError("La hora de inicio debe ser anterior a la hora de fin.");
      return;
    }
    const capacity = Math.max(1, Math.min(100, Number(sessionForm.capacity) || 0));
    if (!capacity) {
      showError("Indica una capacidad válida para la sesión.");
      return;
    }
    if (activeSelectedCount > capacity) {
      showError(`La sesión admite como máximo ${capacity} alumnos.`);
      return;
    }
    if ((workshopSchedule.length > 0 || workshopScheduleExceptions.length > 0) && sessionForm.classType !== 'feriado') {
      const conflictReason = getScheduleConflictReason(
        { date: sessionForm.date, startTime: sessionForm.startTime, endTime: sessionForm.endTime, classType: sessionForm.classType },
        workshopSchedule,
        workshopScheduleExceptions
      );
      if (conflictReason) {
        showError(`${conflictReason}. Ajusta la sesión o cambia la disponibilidad desde Administración del taller.`);
        return;
      }
    }
    const duplicate = sessions.some(s => {
      if (editingSessionId && s.id === editingSessionId) return false;
      return s.date === sessionForm.date
        && s.startTime === sessionForm.startTime
        && s.endTime === sessionForm.endTime
        && s.classType === sessionForm.classType;
    });
    if (duplicate) {
      showError("Ya existe una sesión con el mismo horario y tipo.");
      return;
    }
    const current = editingSessionId ? sessions.find(session => session.id === editingSessionId) : undefined;
    if (editingSessionId && (!current || !hasPersistedRoster(current) || !Number.isSafeInteger(sessionForm.revision) || sessionForm.revision! < 0)) {
      setSaveError('Recarga la sesión para obtener su roster por ID y revisión antes de guardar.');
      return;
    }
    const studentIds: string[] = sessionForm.classType === 'feriado' ? [] : sessionForm.classType === 'mixto'
      ? [...new Set(sessionForm.activityBlocks.flatMap(block => block.studentIds))]
      : [...sessionForm.selectedStudents];
    if (current?.studentIds?.some(id => isCancelled(current, id) && !studentIds.includes(id))) {
      setSaveError('Las reservas canceladas se conservan por ID en el historial. No se pueden quitar ni reactivar.');
      return;
    }
    const giftCardIdByStudentId = Object.fromEntries(studentIds
      .filter(id => !!sessionForm.giftCardIdByStudentId[id])
      .map(id => [id, sessionForm.giftCardIdByStudentId[id] as string]));
    const manualCreditIdByStudentId = Object.fromEntries(studentIds
      .filter(id => !!sessionForm.manualCreditIdByStudentId[id])
      .map(id => [id, sessionForm.manualCreditIdByStudentId[id]]));
    if (Object.keys(manualCreditIdByStudentId).some(id => !!giftCardIdByStudentId[id])) {
      setSaveError('Selecciona una sola fuente de financiacion para cada ID.');
      return;
    }
    if (current && current.attendancePolicyVersion !== 2 && Object.keys(manualCreditIdByStudentId).length) {
      setSaveError('El credito manual requiere una sesion con politica 2.');
      return;
    }
    const payload: Omit<ClassSession, 'id'> = {
      date: sessionForm.date,
      startTime: sessionForm.startTime,
      endTime: sessionForm.endTime,
      classType: sessionForm.classType,
      capacity,
      studentIds,
      students: studentIds.map(id => getStudentName(id, current)),
      giftCardIdByStudentId,
      manualCreditIdByStudentId,
      ...(current ? { revision: sessionForm.revision } : { attendancePolicyVersion: 2 }),
      teacherId: sessionForm.teacherId || undefined,
      workshopName: sessionForm.workshopName.trim() || undefined,
      privateReason: sessionForm.privateReason.trim() || undefined,
      sessionAudience: sessionForm.sessionAudience,
      activityBlocks: sessionForm.classType === 'mixto' ? sessionForm.activityBlocks : undefined
    };
    await persistSave({ kind: 'reservation', id: editingSessionId, updates: payload });
  };

  const weekDays = useMemo(() => {
    const start = new Date(selectedDate);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [selectedDate]);

  const monthDays = useMemo(() => {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1;
    const days = [];
    for (let i = startOffset - 1; i >= 0; i--) days.push({ date: new Date(year, month, 1 - i - 1), currentMonth: false });
    for (let i = 1; i <= daysInMonth; i++) days.push({ date: new Date(year, month, i), currentMonth: true });
    while (days.length < 42) days.push({ date: new Date(year, month, daysInMonth + days.length - (daysInMonth + startOffset) + 1), currentMonth: false });
    return days;
  }, [selectedDate]);

  const sessionsByDate = useMemo(() => {
    const map: Record<string, ClassSession[]> = {};
    sessions.forEach(session => {
      if (!map[session.date]) map[session.date] = [];
      map[session.date].push(session);
    });
    return map;
  }, [sessions]);

  const getMonthlyDensity = (daySessions: ClassSession[]) => {
    if (daySessions.length === 0) return 'low' as const;
    if (daySessions.some(session => session.classType === 'feriado')) return 'full' as const;

    const capacity = daySessions.reduce((total, session) => total + getSessionCapacity(session.classType), 0);
    const occupied = daySessions.reduce((total, session) => total + getActiveRosterCount(session), 0);
    const occupancy = capacity > 0 ? occupied / capacity : 0;

    if (occupancy >= 0.9 || daySessions.length >= 4) return 'full' as const;
    if (occupancy >= 0.55 || daySessions.length >= 3) return 'high' as const;
    return 'medium' as const;
  };

  const getMonthlyCalendarClass = (daySessions: ClassSession[]) => {
    if (daySessions.some(session => session.classType === 'feriado')) return 'full' as const;

    const hasTorno = daySessions.some(session => session.classType === 'torno');
    const hasOtherSession = daySessions.some(session => session.classType !== 'torno');

    if (hasTorno && hasOtherSession) return 'mixed' as const;
    if (hasTorno) return 'torno' as const;
    return getMonthlyDensity(daySessions);
  };

  const renderDayView = () => {
    const dateKey = formatDateKey(selectedDate);
    const daySessions = sessions.filter(s => s.date === dateKey);
    const dayLabel = selectedDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const dayTitle = `${dayLabel.charAt(0).toUpperCase()}${dayLabel.slice(1)}`;

    let startHour = 8;
    let endHour = 22;
    if (daySessions.length > 0) {
      const hoursInDay = daySessions.map(s => parseInt(s.startTime.split(':')[0]));
      const endHoursInDay = daySessions.map(s => {
        const parts = s.endTime.split(':');
        const h = parseInt(parts[0]);
        return parseInt(parts[1]) > 0 ? h + 1 : h;
      });
      startHour = Math.min(...hoursInDay);
      endHour = Math.max(...endHoursInDay, startHour + 6);
      if (endHour > 24) endHour = 24;
    }

    const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => i + startHour);
    const sortedSessions = [...daySessions].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const sessionsByTime: Record<string, ClassSession[]> = {};
    sortedSessions.forEach(s => {
      if (!sessionsByTime[s.startTime]) sessionsByTime[s.startTime] = [];
      sessionsByTime[s.startTime].push(s);
    });

    return (
      <div className="flex-1 flex flex-col h-full overflow-hidden animate-fade-in bg-neutral-base">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 px-4 md:px-10 pt-4 pb-3">
          <div>
            <p className="eyebrow text-brand">Agenda diaria</p>
            <h3 className="ui-page-title mt-1 text-neutral-textMain">{dayTitle}</h3>
          </div>
          <div className="flex items-center gap-3 md:gap-6">
            <div className="flex w-full rounded-[13px] border border-neutral-border bg-neutral-sec p-1 md:w-auto">
              <button onClick={() => setViewMode('day')} className={`flex-1 rounded-[10px] px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest transition-all md:flex-none ${viewMode === 'day' ? 'bg-brand text-white shadow-sm' : 'text-neutral-textHelper hover:text-brand'}`}>Día</button>
              <button onClick={() => setViewMode('month')} className={`flex-1 rounded-[10px] px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest transition-all md:flex-none ${viewMode === 'month' ? 'bg-brand text-white shadow-sm' : 'text-neutral-textHelper hover:text-brand'}`}>Mes</button>
            </div>
            <button disabled={readOnly} onClick={() => handleOpenSessionModal()} className="whitespace-nowrap rounded-[12px] bg-brand px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest text-white shadow-sm transition-all hover:bg-brand-hover active:scale-95 md:px-6">Nueva sesión</button>
          </div>
        </div>

        <div className="flex items-center gap-2.5 px-4 md:px-10 mb-4 overflow-x-auto pb-2 no-scrollbar shrink-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-neutral-border bg-white text-neutral-textHelper">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          </div>
          {weekDays.map((date, i) => {
            const isSelected = date.toDateString() === selectedDate.toDateString();
            const dName = date.toLocaleDateString('es-ES', { weekday: 'long' });
            return (
              <button
                key={i}
                onClick={() => setSelectedDate(new Date(date))}
                className={`flex min-w-[70px] flex-col items-center rounded-[13px] border px-3 py-2.5 transition-all md:min-w-[82px] ${isSelected ? 'border-brand bg-brand text-white shadow-md' : 'border-neutral-border bg-white text-neutral-textMain hover:border-brand/50'}`}
              >
                <span className={`text-[12px] font-semibold capitalize mb-1 ${isSelected ? 'text-white/80' : 'text-neutral-textHelper'}`}>{dName}</span>
                <span className={`text-[14px] font-semibold leading-none ${isSelected ? 'text-white' : 'text-neutral-textMain'}`}>{date.getDate()}</span>
              </button>
            );
          })}
        </div>

        <div className="relative flex-1 overflow-hidden border-t border-neutral-border bg-neutral-sec">
          <div className="h-full overflow-y-auto custom-scrollbar px-6 md:px-10 pt-4 pb-32">
            <div className="relative pl-20" style={{ minHeight: `${hours.length * HOUR_HEIGHT}px` }}>
              {hours.map((hour) => (
                <div key={hour} className="relative flex h-[140px] items-start border-t border-neutral-border/60">
                  <span className="-ml-20 w-20 text-left text-[12px] font-medium text-neutral-textHelper -mt-2 uppercase tracking-wider">{hour === 24 ? '00' : hour}:00</span>
                </div>
              ))}

              {Object.keys(sessionsByTime).map(startTime => {
                const concurrentSessions = sessionsByTime[startTime];
                const widthPercent = 100 / concurrentSessions.length;
                return concurrentSessions.map((session, index) => {
                  const occupancy = getSessionOccupancy(session, capacityMap);
                  const [startH, startM] = session.startTime.split(':').map(Number);
                  const topOffset = ((startH * 60 + startM - startHour * 60) / 60) * HOUR_HEIGHT;
                  const leftOffset = index * widthPercent;
                  return (
                    <div
                      key={session.id}
                      data-session-id={session.id}
                      aria-disabled={readOnly}
                      className="group absolute z-10 flex cursor-pointer flex-col items-start overflow-hidden rounded-[16px] border border-neutral-border bg-white p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:border-brand/40 md:p-5"
                      style={{ top: `${topOffset}px`, left: `calc(${leftOffset}% + 80px)`, width: `calc(${widthPercent}% - 92px)`, minHeight: '152px' }}
                      onClick={() => handleOpenSessionModal(session)}
                    >
                         <div className="flex w-full flex-col items-start gap-2 pr-14 mb-4">
                           <span className="text-[14px] font-semibold text-neutral-textMain leading-none">{session.startTime} - {session.endTime}</span>
                           <span className={`px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-[0.14em] text-white ${getSessionBadgeClasses(session.classType)}`}>{getSessionLabel(session).toUpperCase()}</span>
                          {session.classType !== 'feriado' && <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-textHelper">{getActiveRosterCount(session)}/{occupancy.capacity} cupos</span>}
                         </div>
                      <div className="text-[13.75px] font-medium text-neutral-textHelper uppercase tracking-widest mb-4">
                        <span>Profesor/a: </span>
                        <span className="text-[#B07D4E] font-semibold">{getTeacherName(session.teacherId)}</span>
                        {getTeacherSpecialty(session.teacherId) && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            {getTeacherSpecialty(session.teacherId)}
                          </span>
                        )}
                        {session.classType === 'workshop' && session.workshopName && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            {session.workshopName}
                          </span>
                        )}
                        {session.classType === 'privada' && session.privateReason && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            {session.privateReason}
                          </span>
                        )}
                        {session.classType === 'feriado' && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            Vacaciones
                          </span>
                        )}
                        {session.classType === 'mixto' && session.activityBlocks?.map(block => (
                          <span key={block.id || block.activityType} className="mt-1 block text-[12px] font-medium uppercase tracking-widest text-neutral-textSec">
                            {block.activityType === 'mesa' ? 'Mesa' : 'Torno'} · {getTeacherName(block.teacherId)} · {block.studentIds.length}/{block.capacity}
                          </span>
                        ))}
                      </div>
                      <div className="w-full flex-1 space-y-2 overflow-hidden">
                        {getSessionRoster(session).map(({ id: studentId, name: studentName }, idx) => {
                          const att = getAttendanceStatus(session, studentId);
                          const cancelled = !!studentId && isCancelled(session, studentId);
                          const studentObj = students.find(st => st.id === studentId);
                          const cat = studentObj?.studentCategory || 'membresia';
                          const isTemporary = cat === 'temporal';
                          // Color de bolita: presente=verde, ausente=rojo, pendiente=según categoría
                          const dotColor = cancelled ? 'bg-neutral-textHelper' : att === 'absent'
                            ? 'bg-red-500'
                            : att === 'present'
                              ? 'bg-green-500'
                              : isTemporary
                                ? 'bg-amber-500'
                                : 'bg-[#C88B6A]';
                          return (
                            <div key={studentId || idx} data-student-id={studentId} data-attendance-status={att} data-reservation-state={cancelled ? 'cancelled' : 'reserved'} className="flex items-center gap-2.5">
                              <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`}></div>
                              <span className={`text-[15px] md:text-[16.25px] font-medium truncate ${cancelled ? 'text-neutral-textHelper line-through' : att === 'absent' ? 'text-red-400 line-through opacity-60' : (att === 'present' ? 'text-green-600' : 'text-neutral-textMain')}`}>{studentName.toLowerCase()}</span>
                              {studentId && <span className="shrink-0 text-[11px] text-neutral-textHelper">ID {shortId(studentId)}</span>}
                              {cancelled && <span className="shrink-0 text-[11px] text-neutral-textHelper">Cancelada</span>}
                            </div>
                          );
                        })}
                      </div>
                      {/* Control de asistencia */}
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={(e) => { e.stopPropagation(); handleOpenAttendanceModal(session); }}
                        className="absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-[13px] border-2 border-white/80 bg-brand text-white shadow-md transition-all hover:-translate-y-0.5 hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 active:translate-y-0"
                        title="Control de Asistencia"
                        aria-label="Abrir control de asistencia"
                      >
                        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.25" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4" /></svg>
                      </button>
                    </div>
                  );
                });
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-base">
      {viewMode === 'day' ? renderDayView() : (
        <div className="flex-1 overflow-y-auto px-3 pb-16 pt-3 custom-scrollbar md:px-6 md:pb-10 md:pt-5">
          <div className="calendar-month-stage mx-auto w-full max-w-5xl p-2 md:p-4">
            <div className="calendar-month-surface p-3 md:p-5 lg:p-7">
              <header className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3 md:gap-4">
                  <div className="calendar-black-icon shrink-0" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="3" /><path d="M8 2v4M16 2v4M3 9h18" /></svg>
                  </div>
                  <div>
                    <p className="eyebrow text-brand">Agenda del estudio</p>
                    <h3 className="ui-page-title mt-1 text-neutral-textMain">Calendario mensual</h3>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end md:self-auto">
                  <button type="button" disabled={readOnly} onClick={() => handleOpenSessionModal()} className="inline-flex h-[38px] min-h-0 items-center justify-center whitespace-nowrap rounded-full bg-brand px-4 text-[11px] font-semibold leading-none text-white transition hover:bg-brand-hover sm:px-5">Nueva sesión</button>
                  <button type="button" onClick={() => setViewMode('day')} className="inline-flex h-[38px] min-h-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-neutral-sec px-4 text-[12px] font-semibold leading-none text-neutral-textMain transition hover:bg-brand-soft hover:text-brand" aria-label="Volver a la vista diaria">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 12H5m6-6-6 6 6 6" /></svg>
                    <span className="hidden sm:inline">Vista diaria</span><span className="sm:hidden">Día</span>
                  </button>
                  <button type="button" onClick={() => setSelectedDate(new Date())} className="inline-flex h-[38px] min-h-0 items-center justify-center whitespace-nowrap rounded-full bg-neutral-sec px-5 text-[12px] font-semibold leading-none text-neutral-textMain transition hover:bg-brand-soft hover:text-brand">Ver todo</button>
                  <button type="button" onClick={() => setSelectedDate(new Date())} aria-label="Volver a hoy" title="Volver a hoy" className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-neutral-sec leading-none text-neutral-textMain transition hover:bg-brand-soft hover:text-brand">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68M4 4v4.68h4.68" /></svg>
                  </button>
                </div>
              </header>

              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-border pb-4 md:gap-x-7">
                {[
                  ['low', 'Baja'],
                  ['medium', 'Media'],
                  ['high', 'Alta'],
                  ['full', 'Completa'],
                  ['torno', 'Torno'],
                  ['mixed', 'Mixto']
                ].map(([density, label]) => (
                  <div key={density} className="flex items-center gap-2 text-[13px] font-medium text-neutral-textSec">
                    <span className={`calendar-legend-dot calendar-legend-${density}`} />
                    {label}
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-3">
                <button type="button" aria-label="Mes anterior" onClick={() => setSelectedDate(current => { const next = new Date(current); next.setMonth(next.getMonth() - 1); return next; })} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-textSec transition hover:bg-brand-soft hover:text-brand"><svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m15 19-7-7 7-7" /></svg></button>
                  <h4 className="text-center text-[20px] font-semibold capitalize tracking-tight text-neutral-textMain">{selectedDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</h4>
                <button type="button" aria-label="Mes siguiente" onClick={() => setSelectedDate(current => { const next = new Date(current); next.setMonth(next.getMonth() + 1); return next; })} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-textSec transition hover:bg-brand-soft hover:text-brand"><svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m9 5 7 7-7 7" /></svg></button>
              </div>

              <div className="mt-3 grid grid-cols-7 gap-1 md:gap-2.5">
                {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <div key={day} className="pb-1 text-center text-[12px] font-semibold text-neutral-textSec">{day}</div>)}
                {monthDays.map((item, index) => {
                  const isSelected = item.date.toDateString() === selectedDate.toDateString();
                  const dayKey = formatDateKey(item.date);
                  const daySessions = sessionsByDate[dayKey] || [];
                   const density = getMonthlyCalendarClass(daySessions);
                  const densityClass = `calendar-density-${density}`;
                  const countLabel = daySessions.length === 1 ? '1 sesión' : `${daySessions.length} sesiones`;
                  return (
                    <button
                      type="button"
                      key={`${dayKey}-${index}`}
                      onClick={() => { setSelectedDate(new Date(item.date)); setViewMode('day'); }}
                      aria-label={`${item.date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}${daySessions.length ? `, ${countLabel}` : ', sin sesiones'}`}
                      className={`calendar-density-cell ${densityClass} ${!item.currentMonth ? 'calendar-density-muted' : ''} ${isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-brand' : ''}`}
                    >
                      <span className="text-[14px] font-semibold leading-none">{item.date.getDate()}</span>
                      {item.currentMonth && daySessions.length > 0 && <span className="calendar-density-count">{countLabel}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE CONTROL DE ASISTENCIA (EXCLUSIVO) */}
      {showAttendanceModal && attendanceSession && (
        <div
          className="fixed inset-0 z-[110] flex items-end bg-[#2F1E17]/45 font-['Inter'] backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-5"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !formLocked) setShowAttendanceModal(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="attendance-modal-title"
            data-revision={attendanceSession.revision}
            className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#FFFCF8] text-[#2F211B] shadow-[0_24px_70px_rgba(59,35,24,0.2)] sm:h-auto sm:max-h-[92dvh] sm:max-w-2xl sm:rounded-[24px] sm:border sm:border-[#E8D9CC] animate-fade-in"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-[#E8D9CC] px-5 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:px-8 sm:py-4">
              <div className="min-w-0 pr-4 sm:flex sm:items-baseline sm:gap-4">
                <h3 id="attendance-modal-title" className="ui-section-title shrink-0 font-['Playfair_Display'] text-[#7B3F22]">Control de asistencia</h3>
                <p className="ui-meta mt-1.5 truncate first-letter:uppercase sm:mt-0">{formatSessionDate(attendanceSession.date)}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAttendanceModal(false)}
                disabled={formLocked}
                aria-label="Cerrar modal"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8B6B5E] transition-colors hover:bg-[#F3E7DC] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 18 18 6M6 6l12 12" /></svg>
              </button>
            </header>

            {saveError && <p role="alert" className="mx-5 mt-3 rounded-[10px] bg-[#F7E3DF] px-4 py-3 text-[12px] text-[#9C4235] sm:mx-8">{saveError}</p>}
            {recoveryAlert}
            {refreshConflict?.kind === 'business' && <p role="status" className="mx-5 mt-3 text-[12px] text-[#8B6B5E] sm:mx-8">Esperando la revisión actualizada del servidor. No cierres ni repitas otra operación.</p>}
            <div className="custom-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8 sm:py-5">
              <fieldset disabled={formLocked} className="m-0 min-w-0 border-0 p-0">
              <div className="mb-5 rounded-[12px] border border-[#E8D9CC] bg-[#F8EEE5] px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-semibold text-[#7B3F22]">{attendanceSession.startTime}–{attendanceSession.endTime}</span>
                  <span className="h-3 w-px bg-[#DDBFA4]" aria-hidden="true" />
                  <span className="text-[11px] font-semibold text-[#6E5145]">{getSessionLabel(attendanceSession)}</span>
                  <span className="text-[11px] text-[#8B6B5E]">{getTeacherName(attendanceSession.teacherId)}</span>
                  {attendanceSession.completedAt && (
                    <span className="ml-auto inline-flex items-center gap-1.5 rounded-[7px] bg-[#E7F0E8] px-2 py-1 text-[12px] font-semibold text-[#47704D]">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m5 13 4 4L19 7" /></svg>
                      Finalizada
                    </span>
                  )}
                </div>
                {(attendanceSession.workshopName || attendanceSession.privateReason || attendanceSession.classType === 'feriado') && (
                  <p className="ui-meta mt-1.5">
                    {attendanceSession.workshopName || attendanceSession.privateReason || 'Vacaciones'}
                  </p>
                )}
                {attendanceSession.completedAt && (
                  <p className="ui-meta mt-1.5 text-[#47704D]">Completada el {new Date(attendanceSession.completedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                )}
              </div>

              <div data-testid="attendance-policy" className="mb-5 rounded-[12px] border border-[#E8D9CC] bg-[#F8EEE5] px-4 py-3 text-[12px] leading-relaxed text-[#6E5145]">
                {policy2 ? <>
                  <p>Guardar provisional no consume clases y permite alumnos pendientes. Al finalizar, completa todos los alumnos no cancelados: la asistencia consume una clase salvo excepción sin descuento. La falta consume una clase; sin crédito válido, queda una incidencia pendiente.</p>
                  <p className="mt-2">Cancelación con al menos 8 horas: sin consumo. Con menos de 8 horas: una clase al finalizar. El servidor registra la hora y decide el plazo; este aviso no confirma la clasificación.</p>
                  <p className="mt-2">Los saldos son informativos. El servidor valida crédito, pago y permisos. Corregir una asistencia finalizada no devuelve una penalización por falta o cancelación tardía; solo el propietario puede eximirla expresamente.</p>
                  {attendanceDirty && <p className="mt-2 font-semibold">Guarda primero la asistencia provisional o los cambios para habilitar las operaciones por alumno.</p>}
                </> : <p>Sesión con política anterior (versión 1). Se conserva el comportamiento original de asistencia; no se aplican nuevas penalizaciones ni recobros históricos.</p>}
              </div>

              <div className="mb-5">
                <label htmlFor="attendance-substitute" className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">Reemplazo</label>
                <div className="relative">
                <select
                  id="attendance-substitute"
                  value={substituteId}
                  onChange={(e) => setSubstituteId(e.target.value)}
                   disabled={!!attendanceSession.completedAt && !isEditingAttendance}
                  className="h-11 w-full appearance-none rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 pr-10 text-[13px] text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <option value="">Sin reemplazo</option>
                  {teachers.map(t => (
                    <option key={t.id} value={t.id}>{`${t.name} ${t.surname || ''}`.trim()}</option>
                  ))}
                </select>
                  <svg className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m7 10 5 5 5-5" /></svg>
                </div>
              </div>

              <div className="mb-2 flex items-center justify-between gap-3">
                <h4 className="ui-label uppercase tracking-[0.14em] text-[#7B3F22]">Alumnos</h4>
                <span data-testid="attendance-roster-count" className="ui-meta">{policy2 ? `${getActiveRosterCount(attendanceSession)} activos / ${attendanceSession.students.length} en historial` : `${attendanceSession.students.length} asignados`}</span>
              </div>

              <div className="overflow-hidden rounded-[12px] border border-[#E8D9CC] bg-white">
              {attendanceSession.students.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-[12px] text-[#8B6B5E]">No hay alumnos asignados</p>
                </div>
              ) : (
                attendanceSession.studentIds!.map(studentId => {
                  const studentName = getStudentName(studentId, attendanceSession);
                  const status = getAttendanceStatus(attendanceSession, studentId);
                  const studentObj = students.find(s => s.id === studentId);
                  const isBonusStudent = studentObj?.studentCategory === 'membresia' || studentObj?.studentCategory === 'temporal';
                  const bonos = studentObj?.classesRemaining ?? 0;
                  const bonosTotal = studentObj?.bonosAsignados ?? 4;
                  const business = policy2 ? attendanceSession.businessStateByStudentId?.[studentId] : undefined;
                  const cancelled = isCancelled(attendanceSession, studentId);
                  const businessForm = businessForms[studentId] || { reason: '', kind: 'membership_override' as const, cancellationReason: '', waiverReason: '' };
                  const canWaive = mayWaivePenalty && !!onWaiveSessionPenalty && !!business?.penaltyId
                    && ['charged', 'pending'].includes(business.penaltyState || '');
                  return (
                    <div key={studentId} data-student-id={studentId} data-attendance-status={status} data-reservation-state={cancelled ? 'cancelled' : 'reserved'} data-billing-state={business?.billingState} className="border-b border-[#EFE3D8] px-3 py-2.5 last:border-b-0 sm:px-4">
                      <div className="flex min-h-[62px] items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[14px] font-medium capitalize text-[#3F2E27]">{studentName.toLowerCase()}</p>
                          {isBonusStudent && (
                            <span className={`shrink-0 rounded-[6px] px-1.5 py-0.5 text-[12px] font-semibold ${bonos <= 0 ? 'bg-[#F7E3DF] text-[#9C4235]'
                              : bonos <= Math.ceil(bonosTotal * 0.25) ? 'bg-[#F5E8D4] text-[#916438]'
                                : 'bg-[#E7F0E8] text-[#47704D]'
                              }`}>
                              Bonos {bonos}/{bonosTotal}
                            </span>
                          )}
                        </div>
                        <span className="ui-meta mt-1 block">ID {shortId(studentId)}</span>
                        {attendanceSession.giftCardIdByStudentId?.[studentId] && <span className="ui-meta mt-1 block">Bono vinculado ({shortId(attendanceSession.giftCardIdByStudentId[studentId])})</span>}
                        <span className={`ui-meta mt-1 block font-medium ${status === 'present' ? 'text-[#47704D]' : status === 'absent' ? 'text-[#9C4235]' : 'text-[#9B8175]'}`}>
                          {cancelled ? 'Reserva cancelada (solo lectura)' : status === 'present' ? 'Asiste' : status === 'absent' ? 'No asiste' : 'Pendiente'}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleMarkAttendance(studentId, 'present')}
                           disabled={cancelled || (!!attendanceSession.completedAt && !isEditingAttendance)}
                           className={`flex h-10 w-10 items-center justify-center rounded-[9px] border transition focus:outline-none focus:ring-2 focus:ring-[#6B876F] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${status === 'present' ? 'border-[#5F8065] bg-[#5F8065] text-white' : 'border-[#D8E4D9] bg-[#F4F8F4] text-[#5F8065] hover:bg-[#E7F0E8]'}`}
                           title={attendanceSession.completedAt && !isEditingAttendance ? "Sesión ya finalizada" : "Marcar Asistencia"}
                          aria-label={`Marcar asistencia de ${studentName} (${shortId(studentId)})`}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m5 13 4 4L19 7" /></svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMarkAttendance(studentId, 'absent')}
                           disabled={cancelled || (!!attendanceSession.completedAt && !isEditingAttendance)}
                           className={`flex h-10 w-10 items-center justify-center rounded-[9px] border transition focus:outline-none focus:ring-2 focus:ring-[#9C4235] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${status === 'absent' ? 'border-[#9C4235] bg-[#9C4235] text-white' : 'border-[#EBCFC9] bg-[#FCF4F2] text-[#9C4235] hover:bg-[#F7E3DF]'}`}
                           title={attendanceSession.completedAt && !isEditingAttendance ? "Sesión ya finalizada" : "Marcar Falta"}
                          aria-label={`Marcar falta de ${studentName} (${shortId(studentId)})`}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18 18 6M6 6l12 12" /></svg>
                        </button>
                        {!cancelled && status !== 'pending' && (!attendanceSession.completedAt || isEditingAttendance) && (
                          <button
                            type="button"
                            onClick={() => handleMarkAttendance(studentId, 'pending')}
                            className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[#E8D9CC] bg-white text-[#8B6B5E] transition hover:bg-[#F8EEE5] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2"
                            title="Resetear Estado"
                            aria-label={`Dejar pendiente a ${studentName} (${shortId(studentId)})`}
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15" /></svg>
                          </button>
                        )}
                      </div>
                      </div>
                      {policy2 && <div className="mt-2 space-y-3 border-t border-[#EFE3D8] pt-3 text-[12px] text-[#6E5145]">
                        {studentObj?.studentCategory === 'membresia' && <p>Pago: {studentObj.paymentStatus === 'paid' ? 'pagado' : studentObj.paymentStatus === 'pending' ? 'pendiente' : 'desconocido'}. La aprobación no confirma ni modifica el pago.</p>}
                        {cancelled && <p data-testid="cancellation-state">{business?.cancellationKind === 'timely' ? 'Cancelación a tiempo: sin consumo' : business?.cancellationKind === 'late' ? 'Cancelación tardía: una clase al finalizar' : 'Cancelación registrada; clasificación pendiente del servidor'}. Motivo: {business?.cancellationReason || 'Registrado en el servidor'}. Cancelada por: {business?.cancelledBy || 'Actor registrado'}.{business?.cancelledAt && ` · Hora registrada: ${business.cancelledAt}`}</p>}
                        {business?.exceptionId && <p data-testid="exception-state">Excepción aprobada: {business.exceptionKind === 'no_credit' ? 'asistencia sin descuento' : 'uso excepcional de membresía'}. Motivo: {business.exceptionReason || 'Registrado en el servidor'}. Aprobada por: {business.approvedBy || 'Actor registrado'}.{business.approvedAt && ` · Hora registrada: ${business.approvedAt}`}</p>}
                        {business?.billingState && <p data-testid="billing-state">{({ unfinalized: 'Consumo sin finalizar', charged: 'Una clase consumida', no_charge: 'Sin consumo', incident: 'Incidencia pendiente de resolución administrativa', waived: 'Penalización eximida' })[business.billingState]}{business.billingKind && ` · ${({ attendance: 'Asistencia', no_show: 'Falta', late_cancellation: 'Cancelación tardía', timely_cancellation: 'Cancelación a tiempo', courtesy: 'Asistencia sin descuento' })[business.billingKind]}`}</p>}
                        {business?.penaltyId && <p data-testid="penalty-state">Penalización: {business.penaltyState === 'charged' ? 'una clase consumida' : business.penaltyState === 'waived' ? 'eximida' : 'pendiente de resolución'}. {business.penaltyReason}</p>}
                        {business?.penaltyState === 'waived' && <p data-testid="waiver-state">Motivo de exención: {business.waiverReason || 'Registrado en el servidor'}. Eximida por: {business.waivedBy || 'Actor registrado'}.{business.waivedAt && ` · Hora registrada: ${business.waivedAt}`}</p>}
                        {!cancelled && !attendanceSession.completedAt && onApproveSessionException && <div className="space-y-2">
                          <label htmlFor={`exception-kind-${studentId}`} className="block">Tipo de excepción para {studentName} ({shortId(studentId)})</label>
                          <select id={`exception-kind-${studentId}`} value={businessForm.kind} onChange={event => setBusinessForms(prev => ({ ...prev, [studentId]: { ...businessForm, kind: event.target.value as 'membership_override' | 'no_credit' } }))} className="h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[12px]">
                            <option value="membership_override">Usar membresía con pago pendiente/desconocido o vencida</option>
                            <option value="no_credit">Autorizar asistencia sin crédito y sin descuento</option>
                          </select>
                          <label htmlFor={`exception-reason-${studentId}`} className="block">Motivo de excepción para {studentName} ({shortId(studentId)})</label>
                          <input id={`exception-reason-${studentId}`} value={businessForm.reason} onChange={event => setBusinessForms(prev => ({ ...prev, [studentId]: { ...businessForm, reason: event.target.value } }))} className="h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[12px]" />
                          <button type="button" onClick={() => handleBusinessOperation(studentId, 'approve_exception')} disabled={attendanceDirty || !businessForm.reason.trim()} className="min-h-10 rounded-[9px] border border-[#DDBFA4] bg-[#F8EEE5] px-3 py-2 text-[12px] font-semibold text-[#7B3F22] disabled:opacity-50">{business?.exceptionId ? 'Reaprobar excepción' : 'Aprobar excepción'}</button>
                        </div>}
                        {!cancelled && !attendanceSession.completedAt && onCancelSessionReservation && <div className="space-y-2">
                          <label htmlFor={`cancellation-reason-${studentId}`} className="block">Motivo de cancelación para {studentName} ({shortId(studentId)})</label>
                          <input id={`cancellation-reason-${studentId}`} value={businessForm.cancellationReason} onChange={event => setBusinessForms(prev => ({ ...prev, [studentId]: { ...businessForm, cancellationReason: event.target.value } }))} className="h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[12px]" />
                          <button type="button" onClick={() => handleBusinessOperation(studentId, 'cancel_reservation')} disabled={attendanceDirty || !businessForm.cancellationReason.trim()} className="min-h-10 rounded-[9px] border border-[#DDBFA4] bg-white px-3 py-2 text-[12px] font-semibold text-[#7B3F22] disabled:opacity-50">Cancelar reserva</button>
                        </div>}
                        {canWaive && <div className="space-y-2">
                          <label htmlFor={`waiver-reason-${studentId}`} className="block">Motivo de exención para {studentName} ({shortId(studentId)})</label>
                          <input id={`waiver-reason-${studentId}`} value={businessForm.waiverReason} onChange={event => setBusinessForms(prev => ({ ...prev, [studentId]: { ...businessForm, waiverReason: event.target.value } }))} className="h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[12px]" />
                          <button type="button" onClick={() => handleBusinessOperation(studentId, 'waive_penalty')} disabled={attendanceDirty || !businessForm.waiverReason.trim()} className="min-h-10 rounded-[9px] border border-[#DDBFA4] bg-white px-3 py-2 text-[12px] font-semibold text-[#7B3F22] disabled:opacity-50">Eximir penalización (propietario)</button>
                        </div>}
                      </div>}
                    </div>
                  );
                })
              )}
              </div>
              </fieldset>
            </div>

            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-[#E8D9CC] bg-white/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:py-4">
              {pendingSave?.kind === 'business' || pendingSave?.kind === 'recovery' ? (
                <button type="button" onClick={() => persistSave(pendingSave)} disabled={readOnly || isSubmitting || !!refreshConflict} className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white disabled:opacity-60">{pendingSave.kind === 'recovery' && ['attendance', 'reservation'].includes(pendingSave.descriptor.operation) ? isSubmitting ? 'Guardando...' : 'Reintentar guardado' : isSubmitting ? 'Procesando operación...' : 'Reintentar operación'}</button>
              ) : attendanceSession.completedAt ? (
                isEditingAttendance ? (
                  <>
                    <button type="button" onClick={cancelAttendanceEdit} disabled={formLocked} className="min-h-10 px-3 text-[12px] font-medium text-[#8B6B5E] transition hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50">Cancelar edición</button>
                    <button type="button" onClick={() => saveAttendance(false)} disabled={readOnly || isSubmitting || !!refreshConflict} className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:px-6">
                      {isSubmitting ? 'Guardando…' : pendingSave ? 'Reintentar guardado' : 'Guardar cambios'}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={beginAttendanceEdit} disabled={formLocked} className="h-11 rounded-[10px] border border-[#DDBFA4] bg-white px-5 text-[12px] font-semibold text-[#7B3F22] transition hover:bg-[#F8EEE5] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2">Editar asistencia</button>
                    <button type="button" onClick={() => setShowAttendanceModal(false)} disabled={formLocked} className="h-11 rounded-[10px] bg-[#C68952] px-6 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2">Cerrar</button>
                  </>
                )
              ) : (
                <>
                  <button type="button" onClick={() => setShowAttendanceModal(false)} disabled={formLocked} className="min-h-10 px-3 text-[12px] font-medium text-[#8B6B5E] transition hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50">Cancelar</button>
                  {policy2 && !pendingSave && <button type="button" onClick={() => saveAttendance(false)} disabled={formLocked} className="h-11 rounded-[10px] border border-[#DDBFA4] bg-white px-4 text-[12px] font-semibold text-[#7B3F22] transition hover:bg-[#F8EEE5] disabled:opacity-50">Guardar provisional</button>}
                  <button
                    type="button"
                    onClick={() => saveAttendance(true)}
                    disabled={readOnly || isSubmitting || !!refreshConflict}
                    className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 sm:px-6"
                  >
                    {isSubmitting ? 'Guardando…' : pendingSave ? 'Reintentar guardado' : 'Finalizar control'}
                  </button>
                </>
              )}
            </footer>
          </section>
        </div>
      )}

      {/* MODAL DE EDICIÓN DE SESIÓN (SOLO CONFIGURACIÓN) */}
      {showSessionModal && (
        <div
          className="fixed inset-0 z-[100] flex items-end bg-[#2F1E17]/45 font-['Inter'] backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-5"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !formLocked) setShowSessionModal(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-modal-title"
            className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#FFFCF8] text-[#2F211B] shadow-[0_24px_70px_rgba(59,35,24,0.2)] sm:h-auto sm:max-h-[92dvh] sm:max-w-3xl sm:rounded-[24px] sm:border sm:border-[#E8D9CC] animate-fade-in"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-[#E8D9CC] px-5 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:px-8 sm:py-4">
              <div className="min-w-0 pr-4 sm:flex sm:items-baseline sm:gap-4">
                <h3 id="session-modal-title" className="ui-section-title shrink-0 font-['Playfair_Display'] text-[#7B3F22]">
                  {editingSessionId ? 'Editar sesión' : 'Nueva sesión'}
                </h3>
                <p className="ui-meta mt-1.5 truncate first-letter:uppercase sm:mt-0">
                  {sessionForm.date ? formatSessionDate(sessionForm.date) : 'Fecha no seleccionada'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSessionModal(false)}
                disabled={formLocked}
                aria-label="Cerrar modal"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8B6B5E] transition-colors hover:bg-[#F3E7DC] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </header>

            {saveError && <p role="alert" className="mx-5 mt-3 rounded-[10px] bg-[#F7E3DF] px-4 py-3 text-[12px] text-[#9C4235] sm:mx-8">{saveError}</p>}
            {recoveryAlert}
            <div hidden={pendingSave?.kind === 'recovery' && pendingSave.descriptor.isNewSession} className="custom-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8 sm:py-5">
              <fieldset disabled={formLocked} className="m-0 min-w-0 border-0 p-0">
              <div className="grid gap-6 md:grid-cols-[0.9fr_1.1fr] md:gap-8">
                <div className="space-y-5">
                  <fieldset>
                    <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7B3F22]">Horario</legend>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="ui-label mb-1 block uppercase tracking-[0.12em] text-[#8B6B5E]">Inicio</span>
                        <input aria-label="Hora de inicio" type="time" value={sessionForm.startTime} onChange={(e) => setSessionForm({ ...sessionForm, startTime: e.target.value })} disabled={sessionForm.classType === 'feriado'} className={`h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 ${sessionForm.classType === 'feriado' ? 'cursor-not-allowed opacity-55' : ''}`} />
                      </label>
                      <label className="block">
                        <span className="ui-label mb-1 block uppercase tracking-[0.12em] text-[#8B6B5E]">Fin</span>
                        <input aria-label="Hora de fin" type="time" value={sessionForm.endTime} onChange={(e) => setSessionForm({ ...sessionForm, endTime: e.target.value })} disabled={sessionForm.classType === 'feriado'} className={`h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 ${sessionForm.classType === 'feriado' ? 'cursor-not-allowed opacity-55' : ''}`} />
                      </label>
                    </div>
                    {sessionForm.classType === 'feriado' && (
                      <p className="mt-2 text-[11px] leading-relaxed text-[#8B6B5E]">Día bloqueado por feriado (00:00–24:00).</p>
                    )}
                  </fieldset>

                  <div>
                    <label htmlFor="session-type" className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">Tipo de sesión</label>
                    <div className="relative">
                      <select
                        id="session-type"
                        value={sessionForm.classType}
                        onChange={(e) => {
                          const classType = e.target.value as ClassSession['classType'];
                          setSessionForm({
                             ...sessionForm,
                             classType,
                              capacity: getSessionCapacity(classType),
                             teacherId: (classType === 'mesa' || classType === 'torno') ? sessionForm.teacherId : '',
                            workshopName: classType === 'workshop' ? sessionForm.workshopName : '',
                            privateReason: classType === 'privada' ? sessionForm.privateReason : '',
                            selectedStudents: classType === 'feriado' ? [] : sessionForm.selectedStudents,
                             giftCardIdByStudentId: classType === 'feriado' ? {} : sessionForm.giftCardIdByStudentId,
                             manualCreditIdByStudentId: classType === 'feriado' ? {} : sessionForm.manualCreditIdByStudentId,
                            startTime: classType === 'feriado' ? '00:00' : sessionForm.startTime,
                            endTime: classType === 'feriado' ? '24:00' : sessionForm.endTime,
                            activityBlocks: classType === 'mixto' && sessionForm.activityBlocks.length === 0
                              ? [
                                { activityType: 'mesa', capacity: getSessionCapacity('mesa'), studentIds: [], teacherId: undefined },
                                { activityType: 'torno', capacity: getSessionCapacity('torno'), studentIds: [], teacherId: undefined }
                              ] : sessionForm.activityBlocks
                          });
                        }}
                        className="h-11 w-full appearance-none rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 pr-10 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                      >
                        <option value="mesa">Mesa</option>
                        <option value="torno">Torno</option>
                        <option value="mixto">Mixto (Mesa + Torno)</option>
                        <option value="coworking">Coworking</option>
                        <option value="workshop">Workshop</option>
                        <option value="privada">Privadas</option>
                        <option value="feriado" disabled={!!editingReservation?.completedAt || editingReservation?.studentIds?.some(id => isCancelled(editingReservation, id))}>Feriados</option>
                      </select>
                      <svg className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m7 10 5 5 5-5" /></svg>
                   </div>
                  </div>

                  {sessionForm.classType !== 'feriado' && (
                    <label className="block">
                      <span className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">Cupo máximo</span>
                      <input
                        aria-label="Cupo máximo"
                        type="number"
                        min="1"
                        max="100"
                        value={sessionForm.capacity}
                        onChange={(e) => setSessionForm({ ...sessionForm, capacity: Number(e.target.value) })}
                        className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                      />
                      <span className="mt-1 block text-[11px] text-[#8B6B5E]">{activeSelectedCount} de {sessionForm.capacity || 0} plazas ocupadas</span>
                    </label>
                  )}

                  {(sessionForm.classType === 'mesa' || sessionForm.classType === 'torno') && (
                    <div>
                      <label htmlFor="session-teacher" className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">
                        Profesor <span className="font-normal normal-case tracking-normal text-[#8B6B5E]">{sessionForm.classType === 'mesa' ? '(obligatorio)' : '(opcional)'}</span>
                      </label>
                  <select
                    id="session-teacher"
                    value={sessionForm.teacherId}
                    onChange={(e) => setSessionForm({ ...sessionForm, teacherId: e.target.value })}
                    className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                  >
                    <option value="">Sin asignar</option>
                    {teachers.map(t => (
                      <option key={t.id} value={t.id}>{`${t.name} ${t.surname || ''}`.trim()}</option>
                    ))}
                  </select>
                    </div>
                  )}
                  {sessionForm.classType === 'workshop' && (
                  <input
                    aria-label="Nombre del workshop"
                    value={sessionForm.workshopName}
                    onChange={(e) => setSessionForm({ ...sessionForm, workshopName: e.target.value })}
                    className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] text-[#2F211B] outline-none transition placeholder:text-[#8B6B5E] focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                    placeholder="Nombre del workshop"
                  />
                  )}
                  {sessionForm.classType === 'privada' && (
                  <input
                    aria-label="Motivo de la sesión privada"
                    value={sessionForm.privateReason}
                    onChange={(e) => setSessionForm({ ...sessionForm, privateReason: e.target.value })}
                    className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] text-[#2F211B] outline-none transition placeholder:text-[#8B6B5E] focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                    placeholder="Motivo de la sesión"
                  />
                  )}
                </div>

                {sessionForm.classType !== 'feriado' && (
                  <div className="space-y-6 border-t border-[#E8D9CC] pt-6 md:border-l md:border-t-0 md:pl-10 md:pt-0">
                    {sessionForm.classType === 'mixto' && <fieldset className="space-y-3 rounded-[12px] border border-[#E8D9CC] bg-[#FFF9F3] p-3">
                      <legend className="ui-label px-1 uppercase tracking-[0.14em] text-[#7B3F22]">Actividades y profesores</legend>
                      {sessionForm.activityBlocks.map((block, blockIndex) => <div key={block.activityType} className="rounded-[10px] border border-[#E1C9B5] bg-white p-3">
                        <div className="mb-2 flex items-center justify-between"><span className="text-[13px] font-bold uppercase tracking-[0.12em] text-[#7B3F22]">{block.activityType === 'mesa' ? 'Mesa' : 'Torno'}</span><input aria-label={`Cupo ${block.activityType}`} type="number" min="1" max="100" value={block.capacity} onChange={event => setSessionForm({ ...sessionForm, activityBlocks: sessionForm.activityBlocks.map((item, index) => index === blockIndex ? { ...item, capacity: Number(event.target.value) } : item) })} className="h-8 w-20 rounded border border-[#DDBFA4] px-2 text-[12px]" /></div>
                        <select aria-label={`Profesor de ${block.activityType}`} value={block.teacherId || ''} onChange={event => setSessionForm({ ...sessionForm, activityBlocks: sessionForm.activityBlocks.map((item, index) => index === blockIndex ? { ...item, teacherId: event.target.value || undefined } : item) })} className="mb-2 h-9 w-full rounded border border-[#DDBFA4] bg-white px-2 text-[12px]"><option value="">Sin profesor</option>{teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{`${teacher.name} ${teacher.surname || ''}`.trim()}</option>)}</select>
                        <div className="max-h-36 overflow-y-auto rounded border border-[#E8D9CC] p-1">{students.filter(student => !isStudentArchived(student, today) && (sessionForm.sessionAudience === 'ambos' || (student.studentCategory || 'membresia') === sessionForm.sessionAudience)).map(student => { const selected = block.studentIds.includes(student.id); const otherSelected = sessionForm.activityBlocks.some((item, index) => index !== blockIndex && item.studentIds.includes(student.id)); return <label key={student.id} className={`flex items-center gap-2 rounded px-2 py-1 text-[12px] ${otherSelected ? 'opacity-40' : 'hover:bg-[#F8EEE5]'}`}><input type="checkbox" checked={selected} disabled={otherSelected} onChange={() => setSessionForm({ ...sessionForm, activityBlocks: sessionForm.activityBlocks.map((item, index) => index === blockIndex ? { ...item, studentIds: selected ? item.studentIds.filter(id => id !== student.id) : [...item.studentIds, student.id] } : item) })} /><span className="truncate">{student.name} {student.surname || ''}</span><span className="ml-auto text-[10px] opacity-60">{student.studentCategory === 'temporal' ? 'Bonotemp' : 'Membresía'}</span></label>; })}</div>
                      </div>)}
                    </fieldset>}
                    <fieldset>
                      <legend className="ui-label mb-3 uppercase tracking-[0.14em] text-[#7B3F22]">Tipo de alumnos</legend>
                       <div className="grid grid-cols-3 gap-2 rounded-[12px] bg-brand-soft p-1">
                      <button
                        type="button"
                        onClick={() => { setSessionForm({ ...sessionForm, sessionAudience: 'membresia' }); setStudentSearchQuery(''); }}
                         className={`min-h-10 rounded-[9px] px-2 text-[12.5px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand ${sessionForm.sessionAudience === 'membresia' ? 'bg-white font-bold text-neutral-textMain shadow-sm' : 'text-brand opacity-70 hover:opacity-100'}`}
                      >
                        Membresía
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSessionForm({ ...sessionForm, sessionAudience: 'temporal' }); setStudentSearchQuery(''); }}
                         className={`min-h-10 rounded-[9px] px-2 text-[12.5px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand ${sessionForm.sessionAudience === 'temporal' ? 'bg-white font-bold text-neutral-textMain shadow-sm' : 'text-brand opacity-70 hover:opacity-100'}`}
                      >
                        Bonotemp
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSessionForm({ ...sessionForm, sessionAudience: 'ambos' }); setStudentSearchQuery(''); }}
                         className={`min-h-10 rounded-[9px] px-2 text-[12.5px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand ${sessionForm.sessionAudience === 'ambos' ? 'bg-white font-bold text-neutral-textMain shadow-sm' : 'text-brand opacity-70 hover:opacity-100'}`}
                      >
                        Ambos
                      </button>
                      </div>
                    </fieldset>

                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <label htmlFor="student-search" className="ui-label uppercase tracking-[0.14em] text-[#7B3F22]">Alumnos</label>
                        <span data-testid="reservation-roster-count" className="ui-meta">{activeSelectedCount} seleccionados{sessionForm.selectedStudents.length > activeSelectedCount && ` / ${sessionForm.selectedStudents.length - activeSelectedCount} cancelados`}</span>
                      </div>
                      <div className="relative mb-2.5">
                        <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg>
                    <input
                      id="student-search"
                      type="text"
                      placeholder="Buscar por nombre o grupo"
                      value={studentSearchQuery}
                      onChange={(e) => setStudentSearchQuery(e.target.value)}
                      className="h-9 w-full rounded-[9px] border border-[#E1C9B5] bg-white pl-[2.125rem] pr-3 text-[12px] text-[#2F211B] outline-none transition placeholder:text-[#9B8175] focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                    />
                      </div>
                    <div className="custom-scrollbar max-h-[230px] overflow-y-auto rounded-[10px] border border-[#E8D9CC] bg-white p-1.5">
                      {(() => {
                        const filtered = students
                          .filter(s => {
                            if (isStudentArchived(s, today)) return false;
                            const cat = s.studentCategory || 'membresia';
                            // Filtro por audiencia - 'ambos' muestra todos los tipos
                            const matchesAudience = sessionForm.sessionAudience === 'ambos'
                              ? true
                              : sessionForm.sessionAudience === 'membresia'
                                ? (cat === 'membresia')
                                : (cat === 'temporal');
                            // Filtro por búsqueda
                            const fullName = `${s.name} ${s.surname || ''}`.trim().toLowerCase();
                            const groupName = (s.groupName || '').toLowerCase();
                            const query = studentSearchQuery.trim().toLowerCase();
                            const matchesSearch = !query || fullName.includes(query) || groupName.includes(query);
                            return matchesAudience && matchesSearch;
                          });

                        if (filtered.length === 0) {
                          return <p className="w-full py-6 text-center text-[12px] text-[#8B6B5E]">
                            {studentSearchQuery ? 'No se encontraron alumnos con ese nombre' : 'No hay alumnos en esta categoría'}
                          </p>;
                        }

                        return filtered.map(s => {
                          const fullName = `${s.name} ${s.surname || ''}`.trim();
                          const studentKey = s.id;
                           const isSelected = sessionForm.selectedStudents.includes(studentKey);
                           const cat = s.studentCategory || 'membresia';
                           const isTemporary = cat === 'temporal';
                           const cancelled = !!editingReservation && isCancelled(editingReservation, studentKey);
                           const capacityReached = !isSelected && activeSelectedCount >= sessionForm.capacity;
                           return (
                             <button type="button" key={s.id} data-student-id={s.id} aria-pressed={isSelected} disabled={capacityReached || cancelled || !!editingReservation?.completedAt} onClick={() => {
                               const newList = isSelected
                                 ? sessionForm.selectedStudents.filter(n => n !== studentKey)
                                 : [...sessionForm.selectedStudents, studentKey];
                               setSessionForm({ ...sessionForm, selectedStudents: newList,
                                  giftCardIdByStudentId: Object.fromEntries(Object.entries(sessionForm.giftCardIdByStudentId).filter(([id]) => newList.includes(id))),
                                  manualCreditIdByStudentId: Object.fromEntries(Object.entries(sessionForm.manualCreditIdByStudentId).filter(([id]) => newList.includes(id))) });
                             }} className={`mb-0.5 flex min-h-11 w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left transition last:mb-0 focus:outline-none focus:ring-2 focus:ring-[#C68952] ${isSelected ? 'bg-[#C68952] text-white' : capacityReached ? 'cursor-not-allowed opacity-45' : 'text-[#4E3A31] hover:bg-[#F8EEE5]'}`}>
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                {fullName}
                                {s.groupName && <span className="ml-1.5 text-[11px] font-normal opacity-65">{s.groupName}</span>}
                              </span>
                              <span className="shrink-0 text-[11px] font-normal opacity-65">ID {shortId(s.id)}</span>
                              <span className={`shrink-0 rounded-[6px] px-2 py-1 text-[11px] font-semibold ${isSelected ? 'bg-white/18 text-white' : isTemporary ? 'bg-[#F4E2D2] text-[#8A5633]' : 'bg-[#EEE5DE] text-[#6E5145]'}`}>
                                {cancelled ? 'Cancelada' : isTemporary ? 'Bonotemp' : getStudentLifecycle(s, today) === 'active' ? 'Activa' : getStudentLifecycle(s, today) === 'expired' ? 'Vencida' : 'Pendiente'}
                              </span>
                            </button>
                          );
                        });
                      })()}
                    </div>
                    {sessionForm.selectedStudents.length > 0 && (
                      <div className="mt-3 border-t border-[#E8D9CC] pt-3">
                        <p className="mb-2 text-[12px] font-semibold text-[#6E5145]">Alumnos seleccionados</p>
                        <div className="custom-scrollbar max-h-40 space-y-1.5 overflow-y-auto">
                          {sessionForm.selectedStudents.map(studentId => {
                            const studentObj = students.find(st => st.id === studentId);
                            const cat = studentObj?.studentCategory || 'membresia';
                            const isTemporary = cat === 'temporal';
                            const persistedSession = sessions.find(session => session.id === editingSessionId);
                            const displayName = getStudentName(studentId, persistedSession);
                             const selectedCardId = sessionForm.giftCardIdByStudentId[studentId] || '';
                             const selectedManualId = sessionForm.manualCreditIdByStudentId[studentId] || '';
                             const fundingCards = getFundingCards(studentId);
                             const manualCredits = getFundingManualCredits(studentObj);
                             const linkedCard = giftCards.find(card => card.id === selectedCardId && card.recipientStudentId === studentId);
                             const linkedManual = studentObj?.manualCredits?.find(credit => credit.id === selectedManualId
                               && credit.studentId === studentId && !!studentObj.sedeId && credit.sedeId === studentObj.sedeId
                               && (!persistedSession || credit.sedeId === persistedSession.sedeId));
                            const cancelled = !!persistedSession && isCancelled(persistedSession, studentId);
                            const fundingLocked = !!persistedSession && (!!persistedSession.completedAt || cancelled
                              || (persistedSession.attendancePolicyVersion !== 2 && Object.values(persistedSession.attendanceByStudentId || {}).includes('present')));
                            return (
                              <div key={studentId} data-student-id={studentId} className="rounded-[9px] border border-[#E8D9CC] bg-white px-3 py-2">
                                <div className="flex min-h-10 items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#3F2E27]">{displayName}</span>
                                <span className="shrink-0 text-[11px] text-[#8B6B5E]">ID {shortId(studentId)}</span>
                                {cancelled && <span className="text-[11px] text-[#8B6B5E]">Cancelada (historial)</span>}
                                <span className={`shrink-0 rounded-[6px] px-2 py-1 text-[11px] font-semibold ${isTemporary ? 'bg-[#F4E2D2] text-[#8A5633]' : 'bg-[#EEE5DE] text-[#6E5145]'}`}>
                                  {isTemporary ? 'Bonotemp' : 'Membresía'}
                                </span>
                                <button
                                  type="button"
                                   disabled={cancelled || !!persistedSession?.completedAt}
                                  onClick={() => setSessionForm({ ...sessionForm,
                                    selectedStudents: sessionForm.selectedStudents.filter(id => id !== studentId),
                                    giftCardIdByStudentId: Object.fromEntries(Object.entries(sessionForm.giftCardIdByStudentId).filter(([id]) => id !== studentId)),
                                    manualCreditIdByStudentId: Object.fromEntries(Object.entries(sessionForm.manualCreditIdByStudentId).filter(([id]) => id !== studentId)) })}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#8B6B5E] transition hover:bg-[#F8EEE5] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952]"
                                  aria-label={`Quitar ${displayName} (${shortId(studentId)})`}
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 6l12 12M18 6 6 18" /></svg>
                                </button>
                                </div>
                                <label className="mt-2 block text-[11px] text-[#8B6B5E]">
                                  Financiación de {displayName} ({shortId(studentId)})
                                  <select
                                    aria-label={`Financiación de ${displayName} (${shortId(studentId)})`}
                                    value={selectedManualId ? `manual:${selectedManualId}` : selectedCardId}
                                    disabled={fundingLocked || (!!selectedCardId && !linkedCard) || (!!selectedManualId && !linkedManual)}
                                    onChange={event => {
                                      const giftMapping = { ...sessionForm.giftCardIdByStudentId };
                                      const manualMapping = { ...sessionForm.manualCreditIdByStudentId };
                                      delete giftMapping[studentId];
                                      delete manualMapping[studentId];
                                      const value = event.target.value;
                                      if (value.startsWith('manual:')) manualMapping[studentId] = value.slice(7);
                                      else if (value) giftMapping[studentId] = value;
                                      setSessionForm({ ...sessionForm, giftCardIdByStudentId: giftMapping, manualCreditIdByStudentId: manualMapping });
                                    }}
                                    className="mt-1 h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-2 text-[12px] text-[#2F211B] disabled:opacity-55"
                                  >
                                    <option value="">{cat === 'membresia' ? 'Saldo de membresía (sin bono regalo)' : 'Sin fuente de credito seleccionada'}</option>
                                    {selectedCardId && !fundingCards.some(card => card.id === selectedCardId) && (
                                      <option value={selectedCardId} disabled>{linkedCard ? `Bono de ${displayName} (${shortId(selectedCardId)})` : `Vínculo persistido (${shortId(selectedCardId)}): recarga para verificar`}</option>
                                    )}
                                    {fundingCards.map(card => <option key={card.id} value={card.id}>Bono de {displayName} ({shortId(card.id)})</option>)}
                                    {selectedManualId && !manualCredits.some(credit => credit.id === selectedManualId) && (
                                      <option value={`manual:${selectedManualId}`} disabled>Credito manual original ({shortId(selectedManualId)}): {linkedManual ? 'no disponible para nueva seleccion' : 'no accesible en los datos cargados'}</option>
                                    )}
                                    {manualCredits.map(credit => <option key={credit.id} value={`manual:${credit.id}`}>Credito manual ({shortId(credit.id)}): {credit.remainingClasses}/{credit.allocatedClasses} clases, {credit.startsOn} a {credit.endsOn}</option>)}
                                  </select>
                                </label>
                                {selectedManualId && <p data-testid="selected-manual-credit-info" className="mt-2 text-[11px] text-[#8B6B5E] [overflow-wrap:anywhere]">
                                  ID de credito manual: {selectedManualId}.
                                  {linkedManual ? ` Saldo cargado: ${linkedManual.remainingClasses}/${linkedManual.allocatedClasses} clases. Vigencia: ${linkedManual.startsOn} a ${linkedManual.endsOn}. Evidencia: ${linkedManual.evidence}.`
                                    : ' Fuente original no accesible en los datos cargados; no se sustituira automaticamente.'}
                                  {' La seleccion no autoriza el cargo; el servidor valida identidad, vigencia y saldo de la fuente original.'}
                                </p>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    </div>
                  </div>
                )}
              </div>
              </fieldset>
            </div>

            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-[#E8D9CC] bg-white/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:py-4">
              {editingSessionId && (
                <p className="w-full text-[11px] text-[#8B6B5E]">El historial se conserva. Las sesiones no se pueden eliminar.</p>
              )}
              <button type="button" onClick={() => setShowSessionModal(false)} disabled={formLocked} className={`${editingSessionId ? '' : 'ml-auto'} min-h-10 px-3 text-[12px] font-medium text-[#8B6B5E] transition hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50`}>Cancelar</button>
              <button type="button" onClick={handleSessionSubmit} disabled={readOnly || isSubmitting || !!refreshConflict} className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 sm:px-6">{isSubmitting ? 'Guardando…' : pendingSave ? 'Reintentar guardado' : editingSessionId ? 'Guardar cambios' : 'Crear sesión'}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
};

export default CalendarView;
