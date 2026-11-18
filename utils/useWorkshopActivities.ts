import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabaseClient';
import { readAllRows } from '../context/data/readAllRows';
import { withTimeout } from '../context/data/shared';
import { describeLoadError } from './sectionLoading';

export type WorkshopActivity = { id: string; title: string; date: string; time: string; endTime: string; description: string; revision: number; deletedAt?: string; sourceKey?: string };
export type ActivityInput = Pick<WorkshopActivity, 'title' | 'date' | 'time' | 'endTime' | 'description'> & { sourceKey?: string };
type Intent = { p_sede_id: string; p_activity_id: string; p_request_id: string; p_expected_revision: number; p_action: string; p_payload: Record<string, string> };
const mapRow = (row: any): WorkshopActivity => ({ id: row.id, title: row.title, date: row.activity_date, time: row.starts_at.slice(0, 5), endTime: row.ends_at.slice(0, 5), description: row.description, revision: Number(row.revision), deletedAt: row.deleted_at || undefined, sourceKey: row.source_key || undefined });

export function useWorkshopActivities() {
  const { session, sedeId } = useAuth();
  const scope = `${session?.user.id || ''}:${sedeId || ''}`;
  const scopeRef = useRef(scope);
  const lifetime = useRef({ scope, epoch: 0 });
  if (lifetime.current.scope !== scope) lifetime.current = { scope, epoch: lifetime.current.epoch + 1 };
  const epoch = lifetime.current.epoch;
  scopeRef.current = scope;
  const active = useRef(true);
  const [state, setState] = useState<{ scope: string; rows: WorkshopActivity[]; ready: boolean; loading: boolean; error?: string }>({ scope, rows: [], ready: false, loading: true });
  const [pending, setPending] = useState<Intent | null>(null);
  const lock = useRef<symbol | null>(null);
  const loadGeneration = useRef(0);
  const pendingRef = useRef<Intent | null>(null);
  const key = `workshop-agenda-pending:${scope}`;
  const assertScope = useCallback(() => { if (!active.current || !session || !sedeId || scopeRef.current !== scope || lifetime.current.epoch !== epoch) throw new Error('La sesión o sede ha cambiado.'); }, [session?.user.id, sedeId, scope, epoch]);
  const load = useCallback(async () => {
    assertScope(); const generation = ++loadGeneration.current;
    setState(previous => ({ scope, rows: previous.scope === scope ? previous.rows : [], ready: previous.scope === scope && previous.ready, loading: true }));
    try {
      const result = await readAllRows((offset, size) => withTimeout('agenda.select', supabase.from('workshop_activities').select('*', { count: 'exact' }).eq('sede_id', sedeId!).order('id').range(offset, offset + size - 1)));
      if (result.error) throw result.error;
      assertScope(); if (generation !== loadGeneration.current) throw new Error('La carga fue sustituida. Reintenta el mismo guardado.');
      setState({ scope, rows: (result.data || []).map(mapRow), ready: true, loading: false });
    } catch (error) {
      if (scopeRef.current === scope && generation === loadGeneration.current) setState(previous => ({ ...previous, scope, loading: false, error: describeLoadError(error) }));
      throw error;
    }
  }, [assertScope, scope, sedeId]);

  useEffect(() => {
    active.current = true;
    ++loadGeneration.current; pendingRef.current = null; setPending(null); lock.current = null;
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (saved?.p_sede_id === sedeId && typeof saved.p_request_id === 'string' && typeof saved.p_activity_id === 'string' && Number.isSafeInteger(saved.p_expected_revision)) { pendingRef.current = saved; setPending(saved); } } catch { /* An invalid local descriptor never grants access. */ }
    if (session && sedeId) void load().catch(() => undefined);
    return () => { active.current = false; ++loadGeneration.current; };
  }, [key, sedeId, session?.user.id, load]);

  const execute = useCallback(async (intent: Intent) => {
    assertScope(); if (lock.current) throw new Error('Ya se está guardando esta actividad.'); const attempt = Symbol(intent.p_request_id); lock.current = attempt;
    try {
      pendingRef.current = intent; setPending(intent); sessionStorage.setItem(key, JSON.stringify(intent));
      const { data, error } = await withTimeout('agenda.save', supabase.rpc('save_workshop_activity', intent));
      if (error) {
        // A definite SQL rejection cannot have committed. Refresh before releasing its descriptor.
        if (['40001', '22023', '23514', '23505'].includes(error.code)) {
          assertScope(); await load(); assertScope();
          sessionStorage.removeItem(key); pendingRef.current = null; setPending(null);
        }
        throw error;
      }
      if (!data || data.id !== intent.p_activity_id || data.sede_id !== sedeId || !Number.isSafeInteger(Number(data.revision))) throw new Error('No se recibió un comprobante válido. Reintenta la misma operación.');
      assertScope();
      // The receipt may be historical: render only the fresh authoritative read.
      await load(); assertScope();
      sessionStorage.removeItem(key); pendingRef.current = null; setPending(null);
    } finally { if (lock.current === attempt) lock.current = null; }
  }, [assertScope, key, load, sedeId]);

  const mutate = useCallback(async (action: string, input?: ActivityInput, current?: WorkshopActivity) => {
    assertScope(); if (pendingRef.current) throw new Error('Hay un guardado pendiente. Reintenta los mismos datos antes de cambiarlos.');
    if (input && (!input.title.trim() || !input.date || !/^\d{2}:\d{2}$/.test(input.time) || !/^\d{2}:\d{2}$/.test(input.endTime) || input.time >= input.endTime)) throw new Error('Indica título, fecha y una hora final posterior al inicio.');
    const payload: Record<string, string> = input ? { title: input.title.trim(), activity_date: input.date, starts_at: input.time, ends_at: input.endTime, description: input.description.trim(), ...(input.sourceKey && action === 'create' ? { source_key: input.sourceKey } : {}) } : {};
    await execute({ p_sede_id: sedeId!, p_activity_id: current?.id || crypto.randomUUID(), p_request_id: crypto.randomUUID(), p_expected_revision: current?.revision ?? 0, p_action: action, p_payload: payload });
  }, [assertScope, execute, sedeId]);
  return {
    activities: state.scope === scope ? state.rows : [], ready: state.scope === scope && state.ready,
    loading: state.scope !== scope || state.loading, error: state.scope === scope ? state.error : undefined,
    pending: pending?.p_sede_id === sedeId ? pending : null, load,
    save: (input: ActivityInput, current?: WorkshopActivity) => mutate(current ? 'update' : 'create', input, current),
    remove: (current: WorkshopActivity) => mutate('delete', undefined, current),
    restore: (current: WorkshopActivity) => mutate('restore', undefined, current),
    retry: () => pendingRef.current ? execute(pendingRef.current) : Promise.resolve()
  };
}
