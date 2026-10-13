import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DataProvider, useData } from '../../context/DataContext';
import CalendarPage from '../../pages/CalendarPage';
import StudentsPage from '../../pages/StudentsPage';
import { TestAuthContext, initialAuth, clientCalls, clientResponses, supabase } from './data-provider-integrity-mocks';

type Data = ReturnType<typeof useData>;
let latest: Data;
let configure: (value: any) => void;
const captured = new Map<string, Data>();
const call = async (data: Data, name: string, args: any[] = []) => {
  try { return { ok: true, value: await (data as any)[name](...args) }; }
  catch (error: any) { return { ok: false, error: error?.message || String(error), code: error?.code }; }
};
const storage = () => Object.fromEntries(Object.entries(sessionStorage)
  .filter(([key]) => key.startsWith('student-credit-intent:') || key.startsWith('atomic-session-intent:')));
declare global {
  interface Window {
    __integrity: {
      configure: (value: any) => void;
      capture: (key: string) => void;
      run: (name: string, args?: any[], key?: string) => Promise<any>;
      snapshot: () => any;
      probeRosterColumn: (column: string, operation: 'filter' | 'order') => Promise<any>;
    };
  }
}
window.__integrity = {
  probeRosterColumn: async (column, operation) => {
    const query = supabase.from('session_activity_block_students').select('*', { count: 'exact' });
    return await (operation === 'filter' ? query.eq(column, 'invalid') : query.order(column, { ascending: true })).range(0, 499);
  },
  configure: value => configure(value), capture: key => captured.set(key, latest),
  run: (name, args, key) => call(key ? captured.get(key)! : latest, name, args),
  snapshot: () => ({ students: latest.students, sessions: latest.sessions, giftCards: latest.giftCards,
    inventory: latest.inventoryItems, pieces: latest.pieces, schedule: latest.workshopSchedule,
    loading: latest.isLoadingData, ready: latest.businessDataReady, error: latest.loadError,
    owner: latest.isCurrentSedeOwner, creditOwner: latest.students.map(student => latest.canManageStudentCredits(student)),
    pendingCredit: latest.getPendingStudentCreditOperation('student-a'),
    pendingSession: latest.getPendingSessionOperation('recent'), storage: storage(), calls: clientCalls, responses: clientResponses })
};

function Probe() {
  latest = useData();
  return <>
    <section data-testid="calendar"><CalendarPage /></section>
    <section data-testid="students"><StudentsPage /></section>
  </>;
}
function Harness() {
  const [auth, setAuth] = useState(initialAuth);
  const [mount, setMount] = useState(0);
  const [visible, setVisible] = useState(true);
  configure = value => {
    if (value.actor !== undefined || value.sede !== undefined || value.admin !== undefined || value.token !== undefined) {
      setAuth(previous => ({
        session: { user: { id: value.actor ?? previous.session.user.id }, access_token: value.token ?? previous.session.access_token },
        sedeId: value.sede ?? previous.sedeId, isSuperAdmin: value.admin ?? previous.isSuperAdmin
      }));
    }
    if (value.visible !== undefined) setVisible(value.visible);
    if (value.remount) { setMount(previous => previous + 1); setVisible(true); }
  };
  return <TestAuthContext.Provider value={auth}><MemoryRouter>
    {visible && <DataProvider key={mount}><Probe /></DataProvider>}
  </MemoryRouter></TestAuthContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
