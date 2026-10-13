import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type Callback = (event: AuthChangeEvent, session: Session | null) => unknown;
type Reply = { data: any; error: { message: string; throws?: boolean } | null };
const copy = <T,>(value: T): T => structuredClone(value);
const initial = (window as any).__authInitial ?? {};
let stored: Session | null = initial.session ?? null;
let tail: Promise<unknown> = Promise.resolve();
let locked = false;
let nextSubscription = 0;
let sessionReads = 0;
const subscribers = new Map<number, Callback>();
const calls: any[] = [];
const responses: any[] = [];
const callbackReturns: any[] = [];

const http = async (body: any): Promise<Reply> => {
    const actor = body.filters?.find(([key]: any[]) => ['id', 'owner_id', 'user_id'].includes(key))?.[1];
    body.label = body.kind === 'read' ? `${body.table}:${actor}` : body.kind === 'session' ? `session:${body.index}`
        : body.kind.startsWith('password') ? `${body.kind}:${body.email.split('@')[0]}` : body.kind;
    calls.push(copy(body));
    const response = await fetch('/__auth-provider-integrity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json();
    responses.push({ ...copy(body), result: copy(result) });
    return result;
};

// Like the SDK, a subscriber awaited inside this lock cannot re-enter getSession.
const withLock = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
        locked = true;
        try { return await work(); } finally { locked = false; }
    });
    tail = result.catch(() => undefined);
    return result;
};
const notify = async (event: AuthChangeEvent, session: Session | null) => {
    await Promise.all([...subscribers.values()].map(async callback => {
        const result = callback(event, copy(session));
        callbackReturns.push({ event, locked, returnedPromise: Boolean(result && typeof (result as any).then === 'function') });
        await result;
    }));
};

class Query implements PromiseLike<Reply> {
    private filters: [string, any][] = [];
    private singleRow = false;
    private rowLimit?: number;
    constructor(private table: string) {}
    select(_columns: string) { return this; }
    eq(column: string, value: any) { this.filters.push([column, value]); return this; }
    limit(count: number) { this.rowLimit = count; return this; }
    single() { this.singleRow = true; return this; }
    then<T = Reply, U = never>(resolve?: ((value: Reply) => T | PromiseLike<T>) | null,
        reject?: ((reason: any) => U | PromiseLike<U>) | null): PromiseLike<T | U> {
        const execute = async () => {
            const startedUnderLock = locked;
            const { data: { session } } = await supabase.auth.getSession();
            return http({ kind: 'read', table: this.table, filters: this.filters, single: this.singleRow,
                limit: this.rowLimit, token: session?.access_token ?? null, startedUnderLock });
        };
        return execute().then(resolve, reject);
    }
}

export const supabase = {
    from: (table: string) => new Query(table),
    auth: {
        async getSession(): Promise<{ data: { session: Session | null }; error: any }> {
            const snapshot = await withLock(async () => copy(stored));
            // Delivery can lag behind later events, even though the snapshot is older.
            const response = await http({ kind: 'session', index: ++sessionReads, session: snapshot });
            if (response.error?.throws) throw new Error(response.error.message);
            return { data: { session: response.data }, error: response.error };
        },
        onAuthStateChange(callback: Callback) {
            const id = ++nextSubscription;
            subscribers.set(id, callback);
            return { data: { subscription: { unsubscribe: () => subscribers.delete(id) } } };
        },
        async signInWithPassword({ email }: { email: string; password: string }) {
            const response = await http({ kind: 'password', email });
            if (response.error) return { data: { user: null, session: null }, error: response.error };
            const passwordSession = copy(response.data);
            stored = copy(passwordSession);
            await notify('SIGNED_IN', passwordSession);
            await http({ kind: 'password-delivery', email });
            // The real SDK returns this request's response, not the current global session.
            return { data: { user: passwordSession?.user ?? null, session: passwordSession }, error: null };
        },
        signOut({ scope }: { scope: string }) {
            return withLock(async () => {
                const actor = stored?.user.id ?? null;
                const response = await http({ kind: 'logout', actor, scope });
                if (!response.error) {
                    stored = null;
                    await notify('SIGNED_OUT', null);
                }
                return { error: response.error };
            });
        }
    }
};

export const mockAuth = {
    async emit(event: AuthChangeEvent, session: Session | null, mode: 'locked' | 'broadcast' = 'locked', persist = true) {
        const work = async () => {
            if (persist) stored = copy(session);
            await notify(event, session);
        };
        if (mode === 'locked') await withLock(work); else await work();
    },
    holdLock: () => withLock(async () => { await http({ kind: 'lock' }); }),
    snapshot: () => copy({ stored, calls, responses, callbackReturns, locked, subscriptions: subscribers.size })
};
