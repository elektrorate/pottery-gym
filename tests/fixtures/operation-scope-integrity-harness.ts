import type { Plugin } from 'vite';
import type { OpsContext } from '../../context/data/shared';
import type { ClassSession, SessionActivityBlock, Student } from '../../types';

export const operationScopeIsolationPlugin = (): Plugin => ({
  name: 'operation-scope-isolated-transport',
  enforce: 'pre',
  resolveId(source) {
    if (/supabaseClient(?:\.ts)?$/.test(source)) return '\0operation-scope-mock-client';
    if (/(?:^|\/)toast(?:\.ts)?$/.test(source)) return '\0operation-scope-mock-toast';
    if (/supabase-js|AuthContext|DataContext/.test(source)) throw new Error(`Forbidden harness import: ${source}`);
  },
  load(id) {
    if (id === '\0operation-scope-mock-client') return 'export { supabase } from "/tests/fixtures/operation-scope-integrity-harness.ts";';
    if (id === '\0operation-scope-mock-toast') return `
      export const showError = message => window.__operationScope.recordError(message);
      export const showWarning = showError;
    `;
  }
});

export const operationScopeHarnessHtml = `<!doctype html><html><body><script type="module">
  await import('/tests/fixtures/operation-scope-integrity-harness.ts');
</script></body></html>`;

export const scopeBlocks: SessionActivityBlock[] = [
  { id: 'block-mesa', activityType: 'mesa', teacherId: 'teacher', capacity: 4, studentIds: ['student-mesa'] },
  { id: 'block-torno', activityType: 'torno', teacherId: 'substitute', capacity: 2, studentIds: ['student-torno'] },
  { id: 'block-empty', activityType: 'mesa', capacity: 1, studentIds: [] }
];
export const scopeSession: ClassSession = {
  id: 'session', sedeId: 'sede-a', revision: 7, attendancePolicyVersion: 2,
  date: '2026-10-12', startTime: '10:00', endTime: '12:00', classType: 'mixto', capacity: 7,
  studentIds: ['student-mesa', 'student-torno'], students: ['Mesa', 'Torno'],
  giftCardIdByStudentId: { 'student-torno': 'gift' }, manualCreditIdByStudentId: { 'student-mesa': 'manual' },
  activityBlocks: scopeBlocks
};
type Scope = { actor: string; sede: string; lifetime: number; ready: boolean };
let scope: Scope = { actor: 'actor-a', sede: 'sede-a', lifetime: 1, ready: true };
const sdkCalls: any[] = [];
const errors: string[] = [];
const setters: any[] = [];
const reloads: any[] = [];
const results: Record<string, any> = {};
const captured = new Map<string, OpsContext>();
let assertions = 0;
let sequence = 0;
let state: Record<string, any[]> = {
  inventory: [{ id: 'item', current_quantity: 2 }], teachers: [{ id: 'teacher', name: 'Original' }], gifts: [{ id: 'gift' }]
};
const transport = async (request: any, signal?: AbortSignal) => {
  const response = await fetch('/__operation-scope-integrity', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ...request, scope: { ...scope } })
  });
  if (!response.ok) throw new Error(`Synthetic transport error ${response.status}`);
  return response.json();
};

// Supabase builders are lazy thenables: filters and returning columns are part
// of the dispatched request, and each builder executes at most once.
export const supabase = {
  from(table: string) {
    const request: any = { kind: 'table', table, action: 'select', columns: '*', filters: [] };
    let signal: AbortSignal | undefined;
    let response: Promise<any> | undefined;
    const action = (name: string, payload?: any) => {
      request.action = name;
      if (payload !== undefined) request.payload = payload;
      sdkCalls.push({ table, action: name, scope: { ...scope } });
      return query;
    };
    const query = {
      select(columns = '*') {
        request.columns = columns;
        if (request.action === 'select') sdkCalls.push({ table, action: 'select', scope: { ...scope } });
        else request.returning = true;
        return query;
      },
      insert: (payload: any) => action('insert', payload),
      update: (payload: any) => action('update', payload),
      delete: () => action('delete'),
      eq(column: string, value: any) { request.filters.push(['eq', column, value]); return query; },
      in(column: string, value: any[]) { request.filters.push(['in', column, value]); return query; },
      maybeSingle() { request.single = true; return query; },
      single() { request.single = true; return query; },
      abortSignal(value: AbortSignal) { signal = value; return query; },
      then(resolve: (value: any) => any, reject: (reason: any) => any) {
        response ??= transport(request, signal);
        return response.then(resolve, reject);
      }
    };
    return query;
  },
  rpc(name: string, args: Record<string, any>) {
    sdkCalls.push({ name, args: structuredClone(args), scope: { ...scope } });
    return transport({ kind: 'rpc', name, args });
  }
};

const context = (): OpsContext => {
  const origin = { ...scope };
  const assertScope = () => {
    assertions++;
    if (scope.actor !== origin.actor || scope.sede !== origin.sede || scope.lifetime !== origin.lifetime) {
      throw new Error('Operation scope lifetime changed');
    }
    if (!scope.ready) throw new Error('Business data not ready');
  };
  const setter = (key: string) => (update: any) => {
    setters.push({ key, scope: { ...scope } });
    state[key] = typeof update === 'function' ? update(state[key] || []) : update;
  };
  return {
    sedeId: origin.sede, assertScope, isSuperAdmin: false, operationLockRef: { current: false },
    students: [
      { id: 'student-mesa', name: 'Mesa', phone: '', status: 'new', classesRemaining: 0 },
      { id: 'student-torno', name: 'Torno', phone: '', status: 'new', classesRemaining: 0 }
    ] as Student[],
    sessions: [structuredClone(scopeSession)], capacityDefaults: [], giftCards: [], pieces: [],
    setStudents: setter('students'), setSessions: setter('sessions'), setTeachers: setter('teachers'),
    setPieces: setter('pieces'), setGiftCards: setter('gifts'), setInventoryItems: setter('inventory'),
    setInventoryMovements: setter('movements'),
    safeReload: async () => {
      reloads.push({ phase: 'start', scope: { ...scope } });
      const response = await transport({ kind: 'refresh' });
      if (response.error) throw new Error(response.error.message);
      reloads.push({ phase: 'complete', scope: { ...scope } });
    }
  };
};

if (typeof window !== 'undefined') {
  void Promise.all([
    import('../../context/data/inventoryOps'), import('../../context/data/teacherOps'),
    import('../../context/data/sessionOps'), import('../../context/data/giftCardOps')
  ]).then(modules => {
    const helpers = Object.assign({}, ...modules) as Record<string, (...args: any[]) => any>;
    (window as any).__operationScope = {
      recordError: (message: string) => errors.push(message),
      capture: (key: string) => captured.set(key, context()),
      configure: (value: Partial<Scope> & { remount?: boolean }) => {
        if ((value.actor !== undefined && value.actor !== scope.actor)
          || (value.sede !== undefined && value.sede !== scope.sede) || value.remount) scope.lifetime++;
        scope = { ...scope, actor: value.actor ?? scope.actor, sede: value.sede ?? scope.sede, ready: value.ready ?? scope.ready };
        state = { inventory: [{ id: 'item', current_quantity: 91 }], teachers: [{ id: 'teacher', name: 'New scope' }], gifts: [{ id: 'gift', buyer: 'New scope' }] };
      },
      start: (name: string, args: any[] = [], key?: string) => {
        const id = String(++sequence);
        const ctx = key ? captured.get(key)! : context();
        results[id] = { pending: true };
        void Promise.resolve().then(() => helpers[name](ctx, ...args)).then(
          value => { results[id] = { ok: true, value }; },
          error => { results[id] = { ok: false, error: error?.message || String(error) }; }
        );
        return id;
      },
      snapshot: () => ({ scope, sdkCalls, errors, setters, reloads, results, state, assertions,
        storage: Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith('atomic-session-intent:'))) })
    };
    document.body.dataset.ready = 'true';
  });
}
