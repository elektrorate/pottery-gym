import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import CalendarView from '../../components/CalendarView';
import type { ClassSession, SessionBusinessIntent, SessionBusinessState, PendingSessionOperation, Student } from '../../types';

const memberId = '20000000-0000-0000-0000-000000000001';
const otherId = '20000000-0000-0000-0000-000000000002';
const sessionId = '30000000-0000-0000-0000-000000000001';
const initialStudents: Student[] = [memberId, otherId].map(id => ({
  id, name: 'Alex', surname: 'Perez', phone: '111', studentCategory: 'membresia',
  status: 'membresia', paymentStatus: 'paid', classesRemaining: 4, bonosAsignados: 4
}));
const initialSession: ClassSession = {
  id: sessionId, revision: 7, attendancePolicyVersion: 2, date: '2026-10-11',
  startTime: '18:00', endTime: '20:00', classType: 'mesa', capacity: 2,
  students: ['ALEX PEREZ', 'ALEX PEREZ'], studentIds: [otherId, memberId], teacherId: 'teacher',
  attendanceByStudentId: { [memberId]: 'pending', [otherId]: 'pending' },
  businessStateByStudentId: Object.fromEntries([memberId, otherId].map(id => [id, { reservationState: 'reserved', billingState: 'unfinalized' }]))
};
const rejection = (message: string, code = 'P0001') => Object.assign(new Error(message), { code });
interface StoredOperation {
  descriptor: PendingSessionOperation;
  name: string;
  args: Record<string, any>;
  input: unknown;
  apply: (current: ClassSession) => ClassSession;
  callOperation: string;
}

// This is an interaction fixture, NOT the production API or evidence of SQL rules.
// Its synthetic server owns timestamps, permissions, receipts and financial effects.
const Harness = () => {
  const [sessions, setSessions] = useState<ClassSession[]>([initialSession]);
  const [students, setStudents] = useState(initialStudents);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [rpcCalls, setRpcCalls] = useState<unknown[]>([]);
  const [ledger, setLedger] = useState<unknown[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<SessionBusinessIntent[]>([]);
  const [forbiddenCalls, setForbiddenCalls] = useState<string[]>([]);
  const [refreshes, setRefreshes] = useState(0);
  const [ownerHint, setOwnerHint] = useState(false);
  const [callbacksAvailable, setCallbacksAvailable] = useState(true);
  const [calendarMounted, setCalendarMounted] = useState(true);
  const [recoveryAvailable, setRecoveryAvailable] = useState(true);
  const [retryCalls, setRetryCalls] = useState<unknown[]>([]);
  const [pendingDescriptors, setPendingDescriptors] = useState<PendingSessionOperation[]>([]);
  // This synthetic store survives CalendarView unmounts, like the context's receipt store.
  const pendingOperations = useRef(new Map<string, StoredOperation>());
  const persisted = useRef([initialSession]);
  const people = useRef(initialStudents);
  const mode = useRef('success');
  const role = useRef('staff');
  const expired = useRef(false);
  const fundingChanged = useRef(false);
  const exceptionSnapshots = useRef(new Map<string, string>());
  const serverNow = useRef('2026-10-11T08:00:00Z');
  const receipts = useRef(new Set<string>());
  const previousInput = useRef<unknown>(null);
  const attendanceKeys = useRef(new WeakMap<object, string>());
  const fundingSnapshot = (studentId: string) => {
    const student = people.current.find(person => person.id === studentId)!;
    return JSON.stringify([student.classesRemaining, student.paymentStatus, student.expiryDate]);
  };
  const refresh = async () => {
    setRefreshes(value => value + 1);
    if (mode.current === 'unmount-refresh-failure') {
      setCalendarMounted(false);
      throw new Error('Recarga sintetica perdida tras commit.');
    }
    if (mode.current === 'refresh-failure') throw new Error('Recarga sintetica perdida tras commit.');
    if (mode.current === 'deferred-refresh') await new Promise<void>(resolve => window.addEventListener('policy-test-refresh', () => resolve(), { once: true }));
    setSessions([...persisted.current]);
    setStudents([...people.current]);
  };
  const record = (operation: string, input: unknown) => {
    setCalls(current => [...current, { operation, input, sameObjectAsPrevious: previousInput.current === input, frozen: Object.isFrozen(input) }]);
    previousInput.current = input;
  };
  const execute = async (name: string, args: Record<string, any>, apply: StoredOperation['apply'], input: unknown, isNewSession = false, callOperation = 'update') => {
    const key = isNewSession ? 'new-session' : args.p_session_id;
    let stored = pendingOperations.current.get(key);
    if (stored && JSON.stringify(stored.input) !== JSON.stringify(input)) throw new Error('Hay un intento pendiente. Reintenta los mismos datos.');
    if (!stored) {
      stored = { name, args: Object.freeze(args), input: Object.freeze(input), apply, callOperation,
        descriptor: Object.freeze({ operation: name === 'save_session_attendance' ? 'attendance' : name === 'save_session_reservation' ? 'reservation' : name as SessionBusinessIntent['operation'],
          sessionId: args.p_session_id, requestKey: args.p_request_key, expectedRevision: args.p_expected_revision, isNewSession,
          ...(args.p_student_id ? { studentId: args.p_student_id, reason: args.p_reason } : {}) }) };
      pendingOperations.current.set(key, stored);
      setPendingDescriptors([...pendingOperations.current.values()].map(item => item.descriptor));
    }
    args = stored.args;
    setRpcCalls(current => [...current, { name: stored!.name, args }]);
    try {
      if (mode.current === 'waiting') await new Promise<void>(resolve => window.addEventListener('policy-test-release', () => resolve(), { once: true }));
      if (mode.current === 'transport') throw new Error('Conexion sintetica sin confirmar.');
      if (!receipts.current.has(args.p_request_key)) {
        const current = persisted.current.find(session => session.id === args.p_session_id);
        if (mode.current === 'rollback') throw rejection('Rechazo SQL sintetico.');
        if (mode.current === 'stale' && current) {
          persisted.current = persisted.current.map(session => session.id === current.id ? { ...current, revision: current.revision! + 1, teacherSubstituteId: 'substitute',
            attendanceByStudentId: { [memberId]: 'absent', [otherId]: 'present' } } : session);
          await refresh();
          throw rejection('Revision obsoleta.', '40001');
        }
        if ((current?.revision ?? 0) !== args.p_expected_revision) {
          await refresh();
          throw rejection('Revision obsoleta.', '40001');
        }
        let next: ClassSession;
        try { next = stored.apply(current!); }
        catch (error) { await refresh(); throw error; }
        next = { ...next, revision: (current?.revision ?? 0) + 1 };
        persisted.current = current ? persisted.current.map(session => session.id === current.id ? next : session) : [...persisted.current, next];
        receipts.current.add(args.p_request_key);
        if (mode.current === 'lost-response') throw new Error('Respuesta sintetica perdida tras commit.');
      }
      await refresh();
      pendingOperations.current.delete(key);
      setPendingDescriptors([...pendingOperations.current.values()].map(item => item.descriptor));
    } catch (error: any) {
      if (/^[0-9A-Z]{5}$/.test(error?.code || '') && !['08000', '08003', '08006', '57014'].includes(error.code)
        && !receipts.current.has(args.p_request_key)) {
        pendingOperations.current.delete(key);
        setPendingDescriptors([...pendingOperations.current.values()].map(item => item.descriptor));
      }
      throw error;
    }
  };
  const getPendingOperation = (id?: string) => pendingOperations.current.get(id || 'new-session')?.descriptor || null;
  const retryPendingOperation = async (id?: string) => {
    const stored = pendingOperations.current.get(id || 'new-session');
    if (!stored) throw new Error('No hay un intento pendiente para recuperar.');
    setRetryCalls(items => [...items, { id: id ?? null, requestKey: stored.descriptor.requestKey }]);
    record(stored.callOperation, stored.input);
    await execute(stored.name, stored.args, stored.apply, stored.input, stored.descriptor.isNewSession, stored.callOperation);
  };
  const businessOperation = async (intent: SessionBusinessIntent) => {
    record(intent.operation, intent);
    await execute(intent.operation, {
      p_session_id: intent.sessionId, p_student_id: intent.studentId, p_request_key: intent.requestKey,
      p_expected_revision: intent.expectedRevision, p_reason: intent.reason, ...(intent.kind ? { p_kind: intent.kind } : {})
    }, current => {
      if (role.current === 'unauthorized') throw rejection('Personal no autorizado.', '42501');
      if (intent.operation === 'waive_penalty' && role.current !== 'owner') throw rejection('Solo el propietario de este taller puede eximir.', '42501');
      const existing = current.businessStateByStudentId?.[intent.studentId]!;
      let state: SessionBusinessState;
      if (intent.operation === 'approve_exception') {
        const person = people.current.find(student => student.id === intent.studentId)!;
        if (fundingChanged.current && intent.kind === 'no_credit' && person.classesRemaining > 0) {
          throw rejection('No-credit exception cannot bypass available credit.');
        }
        if (fundingChanged.current && intent.kind === 'membership_override'
          && (person.classesRemaining <= 0 || (person.paymentStatus === 'paid' && !expired.current))) {
          throw rejection('Membership override requires known original positive credit needing an exception.');
        }
        state = { ...existing, exceptionId: intent.requestKey,
          exceptionKind: intent.kind, exceptionReason: intent.reason, approvedBy: role.current, approvedAt: serverNow.current };
        exceptionSnapshots.current.set(intent.requestKey, fundingSnapshot(intent.studentId));
        setApprovalHistory(items => [...items, intent]);
      }
      else if (intent.operation === 'cancel_reservation') {
        // The synthetic server's clock is intentionally independent of browser time.
        const timely = Date.parse('2026-10-11T16:00:00Z') - Date.parse(serverNow.current) >= 8 * 60 * 60 * 1000;
        state = { ...existing, reservationState: 'cancelled', cancelledAt: serverNow.current, cancellationKind: timely ? 'timely' : 'late',
          cancellationReason: intent.reason, cancelledBy: role.current };
      } else {
        state = { ...existing, penaltyState: 'waived', billingState: 'waived', waiverReason: intent.reason,
          waivedBy: role.current, waivedAt: serverNow.current };
        if (existing.penaltyState === 'charged') {
          people.current = people.current.map(student => student.id === intent.studentId ? { ...student, classesRemaining: student.classesRemaining + 1 } : student);
          setLedger(items => [...items, { studentId: intent.studentId, kind: 'waiver', delta: 1 }]);
        }
      }
      return { ...current, businessStateByStudentId: { ...current.businessStateByStudentId, [intent.studentId]: state } };
    }, intent, false, intent.operation);
  };
  const updateAttendance = async (id: string, updates: Partial<ClassSession>) => {
    record('update', updates);
    let key = attendanceKeys.current.get(updates);
    if (!key) { key = crypto.randomUUID(); attendanceKeys.current.set(updates, key); }
    const current = persisted.current.find(session => session.id === id)!;
    const finalize = !!updates.completedAt || !!current.completedAt;
    await execute(updates.attendanceByStudentId ? 'save_session_attendance' : 'save_session_reservation', {
      p_session_id: id, p_request_key: key, p_expected_revision: updates.revision,
      ...(updates.attendanceByStudentId ? { p_finalize: finalize,
        p_attendance: Object.entries(updates.attendanceByStudentId).map(([student_id, status]) => ({ student_id, status })),
        p_teacher_substitute_id: updates.teacherSubstituteId || null
      } : { p_student_ids: updates.studentIds, p_metadata: updates })
    }, stored => {
      if (!updates.attendanceByStudentId) return { ...stored, ...updates };
      const next = { ...stored, ...updates, completedAt: stored.completedAt || (finalize ? serverNow.current : undefined) };
      if (!finalize || stored.completedAt) return next;
      const states = { ...stored.businessStateByStudentId };
      const effects: { studentId: string; kind: string; delta: number }[] = [];
      for (const studentId of stored.studentIds!) {
        const state = states[studentId] || { reservationState: 'reserved', billingState: 'unfinalized' };
        const status = updates.attendanceByStudentId[studentId];
        if (stored.attendancePolicyVersion === 2 && state.reservationState === 'cancelled' && state.cancellationKind === 'timely') {
          states[studentId] = { ...state, billingState: 'no_charge', billingKind: 'timely_cancellation' };
          continue;
        }
        if (status === 'pending' && state.reservationState !== 'cancelled') throw rejection('Asistencia incompleta.');
        const person = people.current.find(student => student.id === studentId)!;
        if (stored.attendancePolicyVersion !== 2 && status === 'absent') continue;
        const penalty = state.reservationState === 'cancelled' || status === 'absent';
        const kind = state.reservationState === 'cancelled' ? 'late_cancellation' : penalty ? 'no_show' : 'attendance';
        if (!penalty && stored.attendancePolicyVersion === 2 && state.exceptionId
          && exceptionSnapshots.current.get(state.exceptionId) !== fundingSnapshot(studentId)) {
          throw rejection('Session exception is stale; explicit reapproval required.');
        }
        const validCredit = person.classesRemaining > 0 && ((person.paymentStatus === 'paid' && (studentId !== memberId || !expired.current))
          || (stored.attendancePolicyVersion === 2 && state.exceptionKind === 'membership_override'));
        if (stored.attendancePolicyVersion === 2 && !penalty && state.exceptionKind === 'no_credit') {
          states[studentId] = { ...state, billingState: 'no_charge', billingKind: 'courtesy' };
        } else if (validCredit) {
          effects.push({ studentId, kind, delta: -1 });
          states[studentId] = { ...state, billingState: 'charged', billingKind: kind,
            ...(penalty ? { penaltyId: `${key}:${studentId}`, penaltyState: 'charged', penaltyReason: kind } : {}) };
        } else if (penalty && stored.attendancePolicyVersion === 2) {
          states[studentId] = { ...state, billingState: 'incident', billingKind: kind,
            penaltyId: `${key}:${studentId}`, penaltyState: 'pending', penaltyReason: 'Sin credito valido' };
        } else throw rejection('Financiacion desconocida, pendiente, vencida o sin credito. Requiere aprobacion explicita.');
      }
      people.current = people.current.map(student => ({ ...student, classesRemaining: student.classesRemaining + effects.filter(effect => effect.studentId === student.id).reduce((sum, effect) => sum + effect.delta, 0) }));
      setLedger(items => [...items, ...effects]);
      return { ...next, businessStateByStudentId: states };
    }, updates);
    return true;
  };
  const addReservation = async (input: Omit<ClassSession, 'id'>) => {
    record('add', input);
    let requestKey = attendanceKeys.current.get(input);
    if (!requestKey) { requestKey = crypto.randomUUID(); attendanceKeys.current.set(input, requestKey); }
    const id = getPendingOperation()?.sessionId || crypto.randomUUID();
    await execute('save_session_reservation', { p_session_id: id, p_request_key: requestKey, p_expected_revision: 0,
      p_student_ids: input.studentIds, p_metadata: input }, () => ({ ...input, id,
      attendanceByStudentId: Object.fromEntries((input.studentIds || []).map(studentId => [studentId, 'pending'])),
      businessStateByStudentId: Object.fromEntries((input.studentIds || []).map(studentId => [studentId, { reservationState: 'reserved', billingState: 'unfinalized' }]))
    }), input, true, 'add');
  };
  useEffect(() => {
    const configure = (event: Event) => {
      const { fixture, behavior, now } = (event as CustomEvent<{ fixture?: string; behavior?: string; now?: string }>).detail;
      if (behavior) mode.current = behavior;
      if (now) serverNow.current = now;
      if (!fixture) return;
      if (fixture === 'unmount-calendar') { setCalendarMounted(false); return; }
      if (fixture === 'no-recovery-callback') { setRecoveryAvailable(false); return; }
      if (fixture === 'recovery-callback') { setRecoveryAvailable(true); return; }
      if (fixture === 'roll-forward') {
        persisted.current = persisted.current.map(session => ({ ...session, revision: session.revision! + 4, teacherSubstituteId: 'substitute' }));
        return;
      }
      if (fixture === 'changed-payment' || fixture === 'paid-credit') {
        fundingChanged.current = true;
        people.current = people.current.map(student => student.id === memberId ? { ...student,
          paymentStatus: fixture === 'paid-credit' ? 'paid' : null, classesRemaining: 4 } : student);
        return;
      }
      let session = structuredClone(initialSession);
      let roster = structuredClone(initialStudents);
      if (['pending', 'unknown', 'expired', 'no-credit', 'legacy-unknown'].includes(fixture)) {
        roster[0] = { ...roster[0], paymentStatus: fixture === 'pending' ? 'pending' : ['unknown', 'legacy-unknown'].includes(fixture) ? null : 'paid', classesRemaining: fixture === 'no-credit' ? 0 : 4 };
      }
      expired.current = fixture === 'expired';
      if (expired.current) roster[0].expiryDate = '2026-10-10';
      if (fixture.startsWith('legacy')) session.attendancePolicyVersion = 1;
      if (fixture === 'missing-revision') session.revision = undefined;
      if (fixture === 'missing-ids') session.studentIds = undefined;
      if (fixture === 'completed' || fixture === 'incident') {
        session.completedAt = '2026-10-11T18:00:00Z';
        session.attendanceByStudentId = { [memberId]: 'absent', [otherId]: 'present' };
        session.businessStateByStudentId![memberId] = { reservationState: 'reserved', billingState: fixture === 'incident' ? 'incident' : 'charged',
          billingKind: 'no_show', penaltyId: 'penalty', penaltyState: fixture === 'incident' ? 'pending' : 'charged', penaltyReason: 'Falta' };
        roster[0].classesRemaining = fixture === 'incident' ? 0 : 3;
      }
      if (fixture === 'zero-balance') roster = roster.map(student => ({ ...student, classesRemaining: 0 }));
      if (fixture === 'long-business-reasons') {
        session.completedAt = '2026-10-11T18:00:00Z';
        session.attendanceByStudentId = { [memberId]: 'absent', [otherId]: 'absent' };
        for (const student of roster) session.businessStateByStudentId![student.id] = {
          reservationState: 'reserved', billingState: 'charged', billingKind: 'no_show',
          penaltyId: `penalty:${student.id}`, penaltyState: 'charged',
          penaltyReason: 'Incidencia de asistencia revisada con el historial del alumno y las condiciones originales de la reserva. '.repeat(12)
        };
        roster = roster.map(student => ({ ...student, classesRemaining: 3 }));
        role.current = 'owner'; setOwnerHint(true);
      }
      if (fixture === 'owner') { role.current = 'owner'; setOwnerHint(true); return; }
      if (fixture === 'other-owner') { role.current = 'other-owner'; setOwnerHint(true); return; }
      if (fixture === 'unauthorized') { role.current = 'unauthorized'; return; }
      if (fixture === 'no-callbacks') { setCallbacksAvailable(false); return; }
      persisted.current = [session]; people.current = roster;
      fundingChanged.current = false;
      setSessions([...persisted.current]); setStudents([...people.current]);
    };
    window.addEventListener('policy-test-configure', configure);
    return () => window.removeEventListener('policy-test-configure', configure);
  }, []);
  const forbidden = async (name: string) => { setForbiddenCalls(items => [...items, name]); throw new Error(`Forbidden standalone write: ${name}`); };
  return <MemoryRouter initialEntries={['/?date=2026-10-11']}>
    <output hidden data-testid="calls">{JSON.stringify(calls)}</output>
    <output hidden data-testid="rpc-calls">{JSON.stringify(rpcCalls)}</output>
    <output hidden data-testid="sessions">{JSON.stringify(sessions)}</output>
    <output hidden data-testid="students">{JSON.stringify(students)}</output>
    <output hidden data-testid="ledger">{JSON.stringify(ledger)}</output>
    <output hidden data-testid="approval-history">{JSON.stringify(approvalHistory)}</output>
    <output hidden data-testid="refreshes">{refreshes}</output>
    <output hidden data-testid="forbidden-calls">{JSON.stringify(forbiddenCalls)}</output>
    <output hidden data-testid="pending-operations">{JSON.stringify(pendingDescriptors)}</output>
    <output hidden data-testid="retry-calls">{JSON.stringify(retryCalls)}</output>
    <main style={{ height: '100dvh' }}>
      {calendarMounted ? <CalendarView sessions={sessions} students={students} giftCards={[]}
        teachers={[{ id: 'teacher', name: 'Profesor local' }, { id: 'substitute', name: 'Reemplazo local' }]}
        workshopSchedule={[]} workshopScheduleExceptions={[]} capacityDefaults={[]}
        onAddSession={addReservation}
        onUpdateSession={updateAttendance}
        onApproveSessionException={callbacksAvailable ? businessOperation : undefined}
        onCancelSessionReservation={callbacksAvailable ? businessOperation : undefined}
        onWaiveSessionPenalty={callbacksAvailable ? businessOperation : undefined}
        canWaiveSessionPenalty={ownerHint}
        getPendingSessionOperation={getPendingOperation}
        onRetryPendingSessionOperation={recoveryAvailable ? retryPendingOperation : undefined}
        onUpdateStudent={() => forbidden('student')} onAdjustClasses={() => forbidden('adjust')}
        onRedeemGiftCardSession={() => forbidden('redeem')} onReverseGiftCardSession={() => forbidden('reverse')}
        onDeleteSession={() => forbidden('delete')} /> : <div role="alert" data-testid="calendar-load-error">
          <p>No se pudo cargar el calendario.</p>
          <button type="button" onClick={() => { setSessions([...persisted.current]); setStudents([...people.current]); setCalendarMounted(true); }}>Recargar datos sin repetir escrituras</button>
        </div>}
    </main>
  </MemoryRouter>;
};
createRoot(document.getElementById('root')!).render(<Harness />);
