import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Plugin } from 'vite';
import CalendarView from '../../components/CalendarView';
import type { ClassSession, GiftCard, ManualCreditEntitlement, Student } from '../../types';
import type { OpsContext } from '../../context/data/shared';

export const manualCreditIds = {
  sede: '10000000-0000-0000-0000-000000000001',
  member: '20000000-0000-0000-0000-000000000001',
  other: '20000000-0000-0000-0000-000000000002',
  archived: '20000000-0000-0000-0000-000000000003',
  session: '30000000-0000-0000-0000-000000000001',
  gift: '40000000-0000-0000-0000-000000000001',
  original: '50000000-0000-0000-0000-000000000001',
  replacement: '50000000-0000-0000-0000-000000000002',
  boundary: '50000000-0000-0000-0000-000000000003'
};
const ids = manualCreditIds;
const entitlement = (id: string, changes: Partial<ManualCreditEntitlement> = {}): ManualCreditEntitlement => ({
  id, studentId: ids.member, sedeId: ids.sede, mode: 'new_manual', activity: 'mesa',
  allocatedClasses: 3, remainingClasses: 2, startsOn: '2026-10-01', endsOn: '2026-10-31',
  reason: 'Credito documentado', evidence: `documento:${id}`, approvedBy: 'server-recorded-actor',
  approvedAt: '2026-10-01T10:00:00Z', ...changes
});
const initialStudents: Student[] = [
  { id: ids.member, sedeId: ids.sede, name: 'Alex', surname: 'Perez', phone: '', status: 'membresia', studentCategory: 'membresia',
    classesRemaining: 91, legacyManualBalance: 87, paymentStatus: 'paid', expiryDate: '2026-10-31', manualCredits: [
      entitlement(ids.replacement, { allocatedClasses: 5, remainingClasses: 4, endsOn: '2026-12-31' }),
      entitlement(ids.original), entitlement(ids.boundary, { startsOn: '2026-10-11', endsOn: '2026-10-11' }),
      entitlement('wrong-student', { studentId: ids.other }), entitlement('wrong-sede', { sedeId: 'foreign-sede' }),
      entitlement('wrong-activity', { activity: 'torno' }), entitlement('exhausted', { remainingClasses: 0 }),
      entitlement('expired', { endsOn: '2026-10-10' }), entitlement('not-started', { startsOn: '2026-10-12' })
    ] },
  { id: ids.other, sedeId: ids.sede, name: 'Alex', surname: 'Perez', phone: '', status: 'new', studentCategory: 'temporal',
    classesRemaining: 0, manualCredits: [entitlement('other-manual', { studentId: ids.other })] },
  { id: ids.archived, sedeId: ids.sede, name: 'Archived', phone: '', status: 'new', studentCategory: 'temporal',
    classesRemaining: 0, archivedAt: '2026-10-01', manualCredits: [entitlement('archived-manual', { studentId: ids.archived })] }
];
const initialSession: ClassSession = {
  id: ids.session, sedeId: ids.sede, revision: 7, attendancePolicyVersion: 2, date: '2026-10-11',
  startTime: '10:00', endTime: '12:00', classType: 'mesa', teacherId: 'teacher', capacity: 4, sessionAudience: 'ambos',
  studentIds: [ids.other, ids.member], students: ['ALEX PEREZ', 'ALEX PEREZ'],
  giftCardIdByStudentId: { [ids.other]: ids.gift }, manualCreditIdByStudentId: { [ids.member]: ids.original },
  attendanceByStudentId: { [ids.member]: 'pending', [ids.other]: 'pending' },
  businessStateByStudentId: Object.fromEntries([ids.member, ids.other].map(id => [id, { reservationState: 'reserved', billingState: 'unfinalized' }]))
};
const giftCards: GiftCard[] = [
  { id: ids.gift, recipientStudentId: ids.other, recipient: 'Same display name', buyer: 'Local fixture', type: 'modelado',
    numClasses: 3, sessionsRemaining: 2, status: 'active', expiryDate: '2026-12-31', createdAt: '2026-10-01' },
  { id: 'member-gift', recipientStudentId: ids.member, recipient: 'Alex Perez', buyer: 'Local fixture', type: 'modelado',
    numClasses: 3, sessionsRemaining: 2, status: 'active', expiryDate: '2026-12-31', createdAt: '2026-10-01' }
];

// Only the transport is replaced: shared payload building, sessionOps, receipt
// storage and CalendarView are production modules. No credentials/client are loaded.
export const manualCreditIsolationPlugin = (): Plugin => ({
  name: 'manual-credit-isolated-transport',
  enforce: 'pre',
  resolveId(source) {
    if (/supabaseClient(?:\.ts)?$/.test(source)) return '\0manual-credit-mock-client';
    if (/supabase-js|DataContext/.test(source)) throw new Error(`Forbidden harness import: ${source}`);
  },
  load(id) {
    if (id === '\0manual-credit-mock-client') return `export const supabase = {
      rpc: (name, args) => window.__manualCreditTestRpc(name, args),
      from: () => { throw new Error('Standalone database writes are forbidden'); }
    };`;
  }
});

export const manualCreditHarnessHtml = `<!doctype html><html lang="es"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1"><style>
    * { box-sizing: border-box; } body { margin: 0; font: 14px system-ui; } svg { width: 1em; height: 1em; }
    button, input, select { font: inherit; max-width: 100%; } input, select { width: 100%; }
    p { overflow-wrap: anywhere; } label { display: block; min-width: 0; } button { cursor: pointer; }
    fieldset { min-width: 0; margin: 0; border: 0; padding: 12px; } .flex { display: flex; }
    .flex-col { flex-direction: column; } .flex-wrap { flex-wrap: wrap; } .flex-1 { flex: 1; }
    .shrink-0 { flex-shrink: 0; } .min-h-0 { min-height: 0; } .min-w-0 { min-width: 0; }
    .grid { display: grid; gap: 12px; } .grid-cols-2 { grid-template-columns: 1fr 1fr; }
    .grid-cols-3 { grid-template-columns: repeat(3, 1fr); } .h-full { height: 100%; } .w-full { width: 100%; }
    .overflow-hidden { overflow: hidden; } .overflow-y-auto { overflow-y: auto; } .overflow-x-auto { overflow-x: auto; }
    .fixed { position: fixed; inset: 0; z-index: 100; background: #eee; justify-content: center; }
    [role="dialog"] { width: 100%; max-width: 768px; height: 100dvh; min-height: 0; background: white; }
    [role="dialog"] > header, [role="dialog"] > footer { padding: 12px; gap: 12px; align-items: center; }
    [role="dialog"] > header { justify-content: space-between; } [role="dialog"] > footer { justify-content: flex-end; }
    [role="dialog"] > [role="alert"] { padding: 12px; flex-shrink: 0; }
    [data-session-id] { position: relative; width: 100% !important; min-height: 0 !important; padding: 12px; }
    [data-student-id] { gap: 8px; padding: 6px; } [class~="max-h-[230px]"] { max-height: 230px; }
    [class~="max-h-40"] { max-height: 280px; } [class~="truncate"] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media(min-width:768px) { [class~="md:grid-cols-[0.9fr_1.1fr]"] { grid-template-columns: 0.9fr 1.1fr; } }
  </style></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/tests/fixtures/calendar-manual-credit-ui-harness.tsx');
  </script></body></html>`;

type SessionOps = typeof import('../../context/data/sessionOps');
const Harness = ({ ops }: { ops: SessionOps }) => {
  const [sessions, setSessions] = useState<ClassSession[]>(structuredClone([initialSession]));
  const [students, setStudents] = useState<Student[]>(structuredClone(initialStudents));
  const [calls, setCalls] = useState<unknown[]>([]);
  const [rpcCalls, setRpcCalls] = useState<unknown[]>([]);
  const [retryCalls, setRetryCalls] = useState<unknown[]>([]);
  const [commits, setCommits] = useState<unknown[]>([]);
  const [refreshes, setRefreshes] = useState(0);
  const [mounted, setMounted] = useState(true);
  const persisted = useRef(structuredClone([initialSession]));
  const people = useRef(structuredClone(initialStudents));
  const mode = useRef('success');
  const receipts = useRef(new Map<string, { session_id: string; request_key: string; revision: number }>());
  const previous = useRef<unknown>(null);
  const context = useRef<OpsContext>(null!);
  const refresh = async () => {
    setRefreshes(count => count + 1);
    if (['refresh-failure', 'unmount-refresh-failure'].includes(mode.current)) {
      if (mode.current === 'unmount-refresh-failure') setMounted(false);
      throw new Error('Recarga sintetica perdida tras commit.');
    }
    context.current.sessions = structuredClone(persisted.current);
    context.current.students = structuredClone(people.current);
    setSessions(context.current.sessions);
    setStudents(context.current.students);
  };
  context.current = { sedeId: ids.sede, students, sessions, capacityDefaults: [], giftCards, safeReload: refresh } as unknown as OpsContext;
  const call = async (action: string, data: any = {}, id = ids.session) => {
    setCalls(items => [...items, { action, id, data, sameObjectAsPrevious: previous.current === data }]);
    previous.current = data;
    if (action === 'add') { await ops.addSession(context.current, data); return; }
    if (action === 'retry') {
      setRetryCalls(items => [...items, { id, descriptor: ops.getPendingSessionOperation(context.current, id || undefined) }]);
      await ops.retryPendingSessionOperation(context.current, id || undefined); return;
    }
    return ops.updateSession(context.current, id, data);
  };
  useEffect(() => {
    (window as any).__manualCreditTestRpc = async (name: string, args: Record<string, any>) => {
      setRpcCalls(items => [...items, { name, args }]);
      if (mode.current === 'waiting') await new Promise<void>(resolve => window.addEventListener('manual-credit-release', () => resolve(), { once: true }));
      if (mode.current === 'transport') throw new Error('Conexion sintetica perdida.');
      if (mode.current === 'rollback') return { data: null, error: { code: 'P0001', message: 'Fuente original rechazada por el servidor sintetico.' } };
      if (mode.current === 'invalid-receipt') return { data: { session_id: 'foreign', request_key: 'wrong', revision: 1 }, error: null };
      const replay = receipts.current.get(args.p_request_key);
      if (replay) return { data: { ...replay, replayed: true }, error: null };
      const current = persisted.current.find(session => session.id === args.p_session_id);
      if (mode.current === 'stale' && current) {
        persisted.current = persisted.current.map(session => session.id === current.id ? { ...session, revision: session.revision! + 1 } : session);
        return { data: null, error: { code: '40001', message: 'Revision obsoleta.' } };
      }
      if ((current?.revision ?? 0) !== args.p_expected_revision) return { data: null, error: { code: '40001', message: 'Revision obsoleta.' } };
      const revision = (current?.revision ?? 0) + 1;
      const metadata = args.p_metadata;
      const next: ClassSession = name === 'save_session_attendance' ? { ...current!, revision,
        attendanceByStudentId: Object.fromEntries(args.p_attendance.map((item: any) => [item.student_id, item.status])),
        completedAt: args.p_finalize ? current?.completedAt || '2026-10-11T12:00:00Z' : undefined,
        teacherSubstituteId: args.p_teacher_substitute_id || undefined
      } : { ...current, id: args.p_session_id, sedeId: args.p_sede_id, revision, attendancePolicyVersion: current?.attendancePolicyVersion || 2,
        date: metadata.date, startTime: metadata.start_time.slice(11, 16), endTime: metadata.end_time.slice(11, 16),
        classType: metadata.class_type, capacity: metadata.capacity, teacherId: metadata.teacher_id,
        sessionAudience: metadata.session_audience, studentIds: args.p_student_ids,
        students: args.p_student_ids.map((id: string) => {
          const person = initialStudents.find(student => student.id === id);
          return person ? `${person.name} ${person.surname || ''}`.trim() : `ID ${id}`;
        }), giftCardIdByStudentId: args.p_gift_card_ids, manualCreditIdByStudentId: args.p_manual_credit_ids || {}
      };
      persisted.current = current ? persisted.current.map(session => session.id === next.id ? next : session) : [...persisted.current, next];
      const receipt = { session_id: next.id, request_key: args.p_request_key, revision };
      receipts.current.set(args.p_request_key, receipt);
      setCommits(items => [...items, { name, requestKey: args.p_request_key }]);
      if (mode.current === 'lost-response') throw new Error('Respuesta sintetica perdida tras commit.');
      return { data: receipt, error: null };
    };
    const configure = (event: Event) => {
      const { behavior, fixture, date } = (event as CustomEvent<{ behavior?: string; fixture?: string; date?: string }>).detail;
      if (behavior) mode.current = behavior;
      if (fixture === 'unmount') { setMounted(false); return; }
      if (fixture === 'remount') { setMounted(true); return; }
      if (fixture === 'roll-forward') {
        persisted.current = persisted.current.map(session => ({ ...session, revision: session.revision! + 10 }));
        context.current.sessions = structuredClone(persisted.current);
        setSessions(context.current.sessions); return;
      }
      if (!fixture && !date) return;
      const session = structuredClone(initialSession);
      let roster = structuredClone(initialStudents);
      if (date) session.date = date;
      if (fixture === 'no-sources' || fixture === 'policy1') { session.manualCreditIdByStudentId = {}; session.giftCardIdByStudentId = {}; }
      if (fixture?.startsWith('policy1')) session.attendancePolicyVersion = 1;
      if (fixture === 'completed' || fixture === 'cancelled' || fixture === 'exhausted-original') {
        if (fixture === 'completed') {
          session.completedAt = '2026-10-11T12:00:00Z';
          session.attendanceByStudentId = { [ids.member]: 'present', [ids.other]: 'present' };
        } else if (fixture === 'cancelled') session.businessStateByStudentId![ids.member] = { reservationState: 'cancelled', billingState: 'unfinalized', cancellationKind: 'timely' };
        roster[0].manualCredits = roster[0].manualCredits!.map(credit => credit.id === ids.original ? { ...credit, remainingClasses: 0 } : credit);
      }
      if (fixture === 'unavailable') roster[0].manualCredits = roster[0].manualCredits!.filter(credit => credit.id !== ids.original);
      if (fixture === 'wrong-identity-original') roster[0].manualCredits![1].studentId = ids.other;
      if (fixture === 'no-sede') roster[0].sedeId = undefined;
      if (fixture === 'foreign-session-sede') session.sedeId = 'foreign-sede';
      if (fixture === 'archived') roster[0].archivedAt = '2026-10-01';
      if (fixture === 'long-evidence') roster[0].manualCredits![1].evidence = 'documento-sin-espacios-'.repeat(50);
      if (fixture === 'remove-students') roster = [];
      persisted.current = [session]; people.current = roster;
      context.current.sessions = structuredClone(persisted.current); context.current.students = structuredClone(people.current);
      setSessions(context.current.sessions); setStudents(context.current.students);
    };
    window.addEventListener('manual-credit-configure', configure);
    return () => window.removeEventListener('manual-credit-configure', configure);
  }, []);
  (window as any).__manualCreditHarness = { call, context: () => context.current, ops };
  const forbidden = async (name: string) => { throw new Error(`Forbidden standalone write: ${name}`); };
  return <MemoryRouter initialEntries={['/?date=2026-10-11']}>
    <output hidden data-testid="calls">{JSON.stringify(calls)}</output>
    <output hidden data-testid="rpc-calls">{JSON.stringify(rpcCalls)}</output>
    <output hidden data-testid="retry-calls">{JSON.stringify(retryCalls)}</output>
    <output hidden data-testid="commits">{JSON.stringify(commits)}</output>
    <output hidden data-testid="sessions">{JSON.stringify(sessions)}</output>
    <output hidden data-testid="students">{JSON.stringify(students)}</output>
    <output hidden data-testid="refreshes">{refreshes}</output>
    <main style={{ height: '100dvh' }}>
      {mounted ? <CalendarView sessions={sessions} students={students} giftCards={giftCards}
        teachers={[{ id: 'teacher', name: 'Profesor local' }]} workshopSchedule={[]} workshopScheduleExceptions={[]} capacityDefaults={[]}
        onAddSession={async data => { await call('add', data); }} onUpdateSession={(id, data) => call('update', data, id)}
        getPendingSessionOperation={id => ops.getPendingSessionOperation(context.current, id)}
        onRetryPendingSessionOperation={async id => { await call('retry', {}, id || ''); }}
        onDeleteSession={() => forbidden('delete')} onAdjustClasses={() => forbidden('adjust')}
        onUpdateStudent={() => forbidden('student')} onRedeemGiftCardSession={() => forbidden('redeem')}
        onReverseGiftCardSession={() => forbidden('reverse')} /> : <p data-testid="unmounted">Calendar unmounted</p>}
    </main>
  </MemoryRouter>;
};
if (typeof document !== 'undefined' && document.getElementById('root')) {
  void import('../../context/data/sessionOps').then(ops => createRoot(document.getElementById('root')!).render(<Harness ops={ops} />));
}
