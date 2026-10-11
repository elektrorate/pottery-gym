import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import CalendarView from '../../components/CalendarView';
import type { ClassSession, SessionBusinessIntent, SessionBusinessState, Student } from '../../types';

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

// This is an interaction fixture, NOT the production API or evidence of SQL rules.
// Its synthetic server owns timestamps, permissions, receipts and financial effects.
const Harness = () => {
  const [sessions, setSessions] = useState<ClassSession[]>([initialSession]);
  const [students, setStudents] = useState(initialStudents);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [rpcCalls, setRpcCalls] = useState<unknown[]>([]);
  const [ledger, setLedger] = useState<unknown[]>([]);
  const [forbiddenCalls, setForbiddenCalls] = useState<string[]>([]);
  const [refreshes, setRefreshes] = useState(0);
  const [ownerHint, setOwnerHint] = useState(false);
  const [callbacksAvailable, setCallbacksAvailable] = useState(true);
  const persisted = useRef([initialSession]);
  const people = useRef(initialStudents);
  const mode = useRef('success');
  const role = useRef('staff');
  const expired = useRef(false);
  const serverNow = useRef('2026-10-11T08:00:00Z');
  const receipts = useRef(new Set<string>());
  const previousInput = useRef<unknown>(null);
  const attendanceKeys = useRef(new WeakMap<object, string>());
  const refresh = async () => {
    setRefreshes(value => value + 1);
    if (mode.current === 'refresh-failure') throw new Error('Recarga sintetica perdida tras commit.');
    if (mode.current === 'deferred-refresh') await new Promise<void>(resolve => window.addEventListener('policy-test-refresh', () => resolve(), { once: true }));
    setSessions([...persisted.current]);
    setStudents([...people.current]);
  };
  const record = (operation: string, input: unknown) => {
    setCalls(current => [...current, { operation, input, sameObjectAsPrevious: previousInput.current === input, frozen: Object.isFrozen(input) }]);
    previousInput.current = input;
  };
  const execute = async (name: string, args: Record<string, any>, apply: (current: ClassSession) => ClassSession) => {
    setRpcCalls(current => [...current, { name, args }]);
    if (mode.current === 'waiting') await new Promise<void>(resolve => window.addEventListener('policy-test-release', () => resolve(), { once: true }));
    if (mode.current === 'transport') throw new Error('Conexion sintetica sin confirmar.');
    if (!receipts.current.has(args.p_request_key)) {
      const current = persisted.current.find(session => session.id === args.p_session_id)!;
      if (mode.current === 'rollback') throw rejection('Rechazo SQL sintetico.');
      if (mode.current === 'stale') {
        persisted.current = [{ ...current, revision: current.revision! + 1, teacherSubstituteId: 'substitute',
          attendanceByStudentId: { [memberId]: 'absent', [otherId]: 'present' } }];
        await refresh();
        throw rejection('Revision obsoleta.', '40001');
      }
      if (current.revision !== args.p_expected_revision) {
        await refresh();
        throw rejection('Revision obsoleta.', '40001');
      }
      const next = apply(current);
      persisted.current = persisted.current.map(session => session.id === current.id ? { ...next, revision: current.revision! + 1 } : session);
      receipts.current.add(args.p_request_key);
      if (mode.current === 'lost-response') throw new Error('Respuesta sintetica perdida tras commit.');
    }
    await refresh();
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
      if (intent.operation === 'approve_exception') state = { ...existing, exceptionId: intent.requestKey,
        exceptionKind: intent.kind, exceptionReason: intent.reason, approvedBy: role.current };
      else if (intent.operation === 'cancel_reservation') {
        // The synthetic server's clock is intentionally independent of browser time.
        const timely = Date.parse('2026-10-11T16:00:00Z') - Date.parse(serverNow.current) >= 8 * 60 * 60 * 1000;
        state = { ...existing, reservationState: 'cancelled', cancelledAt: serverNow.current, cancellationKind: timely ? 'timely' : 'late' };
      } else {
        state = { ...existing, penaltyState: 'waived', billingState: 'waived', penaltyReason: intent.reason };
        if (existing.penaltyState === 'charged') {
          people.current = people.current.map(student => student.id === intent.studentId ? { ...student, classesRemaining: student.classesRemaining + 1 } : student);
          setLedger(items => [...items, { studentId: intent.studentId, kind: 'waiver', delta: 1 }]);
        }
      }
      return { ...current, businessStateByStudentId: { ...current.businessStateByStudentId, [intent.studentId]: state } };
    });
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
        p_attendance: Object.entries(updates.attendanceByStudentId).map(([student_id, status]) => ({ student_id, status }))
      } : { p_student_ids: updates.studentIds })
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
    });
    return true;
  };
  useEffect(() => {
    const configure = (event: Event) => {
      const { fixture, behavior, now } = (event as CustomEvent<{ fixture?: string; behavior?: string; now?: string }>).detail;
      if (behavior) mode.current = behavior;
      if (now) serverNow.current = now;
      if (!fixture) return;
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
      if (fixture === 'owner') { role.current = 'owner'; setOwnerHint(true); return; }
      if (fixture === 'other-owner') { role.current = 'other-owner'; setOwnerHint(true); return; }
      if (fixture === 'unauthorized') { role.current = 'unauthorized'; return; }
      if (fixture === 'no-callbacks') { setCallbacksAvailable(false); return; }
      persisted.current = [session]; people.current = roster;
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
    <output hidden data-testid="refreshes">{refreshes}</output>
    <output hidden data-testid="forbidden-calls">{JSON.stringify(forbiddenCalls)}</output>
    <main style={{ height: '100dvh' }}>
      <CalendarView sessions={sessions} students={students} giftCards={[]}
        teachers={[{ id: 'teacher', name: 'Profesor local' }, { id: 'substitute', name: 'Reemplazo local' }]}
        workshopSchedule={[]} workshopScheduleExceptions={[]} capacityDefaults={[]}
        onAddSession={async input => { record('add', input); setSessions(items => [...items, { ...input, id: 'new-session', revision: 1 }]); }}
        onUpdateSession={updateAttendance}
        onApproveSessionException={callbacksAvailable ? businessOperation : undefined}
        onCancelSessionReservation={callbacksAvailable ? businessOperation : undefined}
        onWaiveSessionPenalty={callbacksAvailable ? businessOperation : undefined}
        canWaiveSessionPenalty={ownerHint}
        onUpdateStudent={() => forbidden('student')} onAdjustClasses={() => forbidden('adjust')}
        onRedeemGiftCardSession={() => forbidden('redeem')} onReverseGiftCardSession={() => forbidden('reverse')}
        onDeleteSession={() => forbidden('delete')} />
    </main>
  </MemoryRouter>;
};
createRoot(document.getElementById('root')!).render(<Harness />);
