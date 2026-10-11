import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import CalendarView from '../../components/CalendarView';
import type { ClassSession, GiftCard, Student } from '../../types';
import {
  SessionIntentStore, attendanceInput, createSessionAttendanceIntent, createSessionOperations,
  createSessionReservationIntent, reservationInput, type AttendanceStatus
} from '../../context/data/sessionAttendanceOps';

const memberId = '20000000-0000-0000-0000-000000000001';
const temporaryId = '20000000-0000-0000-0000-000000000002';
const oldCardId = '40000000-0000-0000-0000-000000000001';
const newCardId = '40000000-0000-0000-0000-000000000002';
const authorizedStudents: Student[] = [
  { id: memberId, name: 'Alex', surname: 'Perez', email: 'member@example.test', phone: '111', studentCategory: 'membresia', status: 'membresia', classesRemaining: 2, bonosAsignados: 4 },
  { id: temporaryId, name: 'Alex', surname: 'Perez', email: 'temporary@example.test', phone: '222', studentCategory: 'temporal', status: 'new', classesRemaining: 0, bonosAsignados: 3 }
];
const cards: GiftCard[] = [
  { id: newCardId, recipient: 'Otra etiqueta', recipientStudentId: temporaryId, buyer: 'Comprador', numClasses: 3, type: 'modelado', status: 'active', sessionsRemaining: 3, createdAt: '2026-10-11', expiryDate: '2027-10-11' },
  { id: oldCardId, recipient: 'Etiqueta antigua', recipientStudentId: temporaryId, buyer: 'Comprador', numClasses: 3, type: 'modelado', status: 'active', sessionsRemaining: 2, createdAt: '2026-01-01', expiryDate: '2027-01-01' },
  { id: '40000000-0000-0000-0000-000000000003', recipient: 'Alex Perez', recipientStudentId: memberId, buyer: 'Comprador', numClasses: 3, type: 'modelado', status: 'active', sessionsRemaining: 3, createdAt: '2026-10-11' },
  { id: 'unlinked', recipient: 'Alex Perez', buyer: 'Comprador', numClasses: 3, type: 'modelado', status: 'active', sessionsRemaining: 3, createdAt: '2026-10-11' }
];
const initialSession: ClassSession = {
  id: '30000000-0000-0000-0000-000000000001', revision: 7,
  date: '2026-10-11', startTime: '10:00', endTime: '12:00', classType: 'mesa', capacity: 4,
  students: ['ALEX PEREZ', 'ALEX PEREZ'], studentIds: [temporaryId, memberId],
  attendanceByStudentId: { [memberId]: 'pending', [temporaryId]: 'pending' },
  giftCardIdByStudentId: { [temporaryId]: oldCardId }, teacherId: 'teacher', sessionAudience: 'ambos'
};

// The real operation/receipt store drives a synthetic RPC. No application entry,
// Supabase client, credentials, environment files or external services are loaded.
const Harness = () => {
  const [sessions, setSessions] = useState<ClassSession[]>([initialSession]);
  const [students, setStudents] = useState(authorizedStudents);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [rpcCalls, setRpcCalls] = useState<unknown[]>([]);
  const [forbiddenCalls, setForbiddenCalls] = useState<string[]>([]);
  const [refreshes, setRefreshes] = useState(0);
  const loaded = useRef(sessions);
  const persisted = useRef(sessions);
  const mode = useRef('success');
  const previousUpdates = useRef<unknown>(null);
  const receipts = useRef(new Map<string, { session_id: string; request_key: string; revision: number }>());
  const operations = useRef<ReturnType<typeof createSessionOperations> | null>(null);
  if (!operations.current) operations.current = createSessionOperations({
    store: new SessionIntentStore(),
    refresh: async () => {
      setRefreshes(value => value + 1);
      if (mode.current === 'reload-failure') throw new Error('Fallo sintetico de recarga tras guardar.');
      loaded.current = [...persisted.current];
      setSessions(loaded.current);
    },
    rpc: async (name, args) => {
      setRpcCalls(current => [...current, { name, args }]);
      if (mode.current === 'waiting') await new Promise<void>(resolve => window.addEventListener('calendar-test-release', () => resolve(), { once: true }));
      if (mode.current === 'transport') throw new Error('Fallo sintetico de conexion.');
      if (mode.current === 'rollback') return { data: null, error: { code: 'P0001', message: 'Saldo insuficiente. Operacion revertida.' } };
      const current = persisted.current.find(session => session.id === args.p_session_id);
      if (mode.current === 'stale' && current) {
        persisted.current = persisted.current.map(session => session.id === current.id ? {
          ...session, revision: current.revision! + 1, startTime: '10:30', capacity: 5,
          attendanceByStudentId: { [memberId]: 'absent', [temporaryId]: 'present' }, teacherSubstituteId: 'substitute'
        } : session);
        return { data: null, error: { code: '40001', message: 'Revision obsoleta. Operacion revertida.' } };
      }
      const replay = receipts.current.get(args.p_request_key);
      if (replay) return { data: replay, error: null };
      const revision = (current?.revision ?? 0) + 1;
      const next: ClassSession = name === 'save_session_attendance' ? {
        ...current!, revision,
        attendanceByStudentId: Object.fromEntries(args.p_attendance.map((item: { student_id: string; status: AttendanceStatus }) => [item.student_id, item.status])),
        completedAt: args.p_finalize ? current?.completedAt || '2026-10-11T12:00:00Z' : undefined,
        teacherSubstituteId: args.p_teacher_substitute_id || undefined
      } : {
        ...args.p_metadata, id: args.p_session_id, revision,
        studentIds: args.p_student_ids,
        students: args.p_student_ids.map((id: string) => {
          const student = authorizedStudents.find(item => item.id === id)!;
          return `${student.name} ${student.surname}`;
        }),
        giftCardIdByStudentId: args.p_gift_card_ids
      };
      persisted.current = current ? persisted.current.map(session => session.id === next.id ? next : session) : [...persisted.current, next];
      const receipt = { session_id: args.p_session_id, request_key: args.p_request_key, revision };
      receipts.current.set(args.p_request_key, receipt);
      if (mode.current === 'lost-response') throw new Error('Fallo sintetico: respuesta perdida tras commit.');
      return { data: receipt, error: null };
    }
  });
  useEffect(() => {
    const configureMode = (event: Event) => { mode.current = (event as CustomEvent<string>).detail; };
    const configureFixture = (event: Event) => {
      const fixture = (event as CustomEvent<string>).detail;
      let session = { ...initialSession };
      if (fixture === 'completed') session = { ...session, revision: 12, completedAt: '2026-10-11T08:00:00Z', attendanceByStudentId: { [memberId]: 'present', [temporaryId]: 'present' } };
      if (fixture === 'legacy') session.studentIds = undefined;
      if (fixture === 'misaligned') session.students = ['ALEX PEREZ'];
      if (fixture === 'missing-revision') session.revision = undefined;
      if (fixture === 'roll-forward') session = { ...session, revision: 20, attendanceByStudentId: { [memberId]: 'absent', [temporaryId]: 'present' } };
      if (fixture === 'remove-students') setStudents([]);
      if (fixture === 'zero-balance') setStudents(authorizedStudents.map(student => ({ ...student, classesRemaining: 0 })));
      persisted.current = loaded.current = [session];
      setSessions(loaded.current);
    };
    window.addEventListener('calendar-test-mode', configureMode);
    window.addEventListener('calendar-test-fixture', configureFixture);
    return () => {
      window.removeEventListener('calendar-test-mode', configureMode);
      window.removeEventListener('calendar-test-fixture', configureFixture);
    };
  }, []);
  const record = (action: string, data: unknown, id?: string) => {
    const sameObjectAsPrevious = previousUpdates.current === data;
    setCalls(current => [...current, { action, id, data, sameObjectAsPrevious }]);
    previousUpdates.current = data;
  };
  const forbidden = async (action: string) => {
    setForbiddenCalls(current => [...current, action]);
    throw new Error(`Forbidden standalone write: ${action}`);
  };
  return <MemoryRouter initialEntries={['/?date=2026-10-11']}>
    <output hidden data-testid="calls">{JSON.stringify(calls)}</output>
    <output hidden data-testid="rpc-calls">{JSON.stringify(rpcCalls)}</output>
    <output hidden data-testid="forbidden-calls">{JSON.stringify(forbiddenCalls)}</output>
    <output hidden data-testid="sessions">{JSON.stringify(sessions)}</output>
    <output hidden data-testid="refreshes">{refreshes}</output>
    <main style={{ height: '100dvh' }}>
      <CalendarView sessions={sessions} students={students} giftCards={cards}
        teachers={[{ id: 'teacher', name: 'Profesor local' }, { id: 'substitute', name: 'Reemplazo local' }]}
        workshopSchedule={[]} workshopScheduleExceptions={[]} capacityDefaults={[]}
        onAddSession={async data => {
          record('add', data);
          await operations.current!.save('local:new-session', reservationInput(data), () => createSessionReservationIntent(
            '30000000-0000-0000-0000-000000000002', 0, 'local', data, data.studentIds!, data.giftCardIdByStudentId || {}, reservationInput(data)));
        }}
        onUpdateSession={async (id, data) => {
          record('update', data, id);
          if (mode.current === 'false') return false;
          const current = loaded.current.find(session => session.id === id)!;
          if (data.attendanceByStudentId) {
            await operations.current!.save(`local:${id}`, attendanceInput(data), () => createSessionAttendanceIntent(current, students, data));
          } else {
            await operations.current!.save(`local:${id}`, reservationInput(data), () => createSessionReservationIntent(
              id, data.revision!, 'local', { ...current, ...data }, data.studentIds!, data.giftCardIdByStudentId || {}, reservationInput(data)));
          }
          return true;
        }}
        onDeleteSession={() => forbidden('delete')}
        onAdjustClasses={() => forbidden('adjust')}
        onUpdateStudent={() => forbidden('student')}
        onRedeemGiftCardSession={() => forbidden('redeem')}
        onReverseGiftCardSession={() => forbidden('reverse')} />
    </main>
  </MemoryRouter>;
};
createRoot(document.getElementById('root')!).render(<Harness />);
