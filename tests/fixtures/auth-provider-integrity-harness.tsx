import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { mockAuth, supabase } from './auth-provider-integrity-mocks';

type Auth = ReturnType<typeof useAuth>;
let auth: Auth | null = null;
let mounted = true;
let setMounted: (value: boolean) => void;
const history: any[] = [];
const results: Record<string, any> = {};
const describe = (value: Auth | null) => value ? {
    sessionActor: value.session?.user.id ?? null, user: value.user?.id ?? null,
    token: value.session?.access_token ?? null, profile: value.profile?.id ?? null,
    role: value.profile?.role ?? null, sede: value.sedeId, loading: value.loading, error: value.error,
    superAdmin: value.isSuperAdmin, owner: value.isTallerista, staff: value.isStaff
} : null;

const Consumer = () => {
    const value = useAuth();
    useEffect(() => {
        auth = value;
        history.push(describe(value));
    }, [value]);
    useEffect(() => () => { auth = null; }, []);
    return <pre data-testid="auth-state">{JSON.stringify(describe(value))}</pre>;
};
const Harness = () => {
    const [active, update] = useState(true);
    setMounted = update;
    useEffect(() => { mounted = active; }, [active]);
    const provider = active ? <AuthProvider><Consumer /></AuthProvider> : <p>Unmounted</p>;
    return provider;
};

(window as any).__authIntegrity = {
    snapshot: () => ({ ...mockAuth.snapshot(), auth: describe(auth), mounted, history, results }),
    run(name: string, args: any[] = [], key = name) {
        let operation: unknown;
        if (name === 'login') operation = auth!.login(args[0], 'synthetic-password');
        else if (name === 'logout') operation = auth!.logout();
        else if (name === 'emit') operation = mockAuth.emit(args[0], args[1], args[2], args[3]);
        else if (name === 'sdk-session') operation = supabase.auth.getSession();
        else if (name === 'own-profile') operation = supabase.from('profiles').select('*').eq('id', args[0] ?? auth!.profile!.id).single();
        else if (name === 'lock') operation = mockAuth.holdLock();
        else if (name === 'unmount') { setMounted(false); operation = true; }
        else if (name === 'mount') { setMounted(true); operation = true; }
        else throw new Error(`Unknown harness command ${name}`);
        Promise.resolve(operation).then(result => { results[key] = result ?? 'done'; }, error => {
            results[key] = { thrown: String(error) };
        });
    }
};
createRoot(document.getElementById('root')!).render((window as any).__authInitial?.strict
    ? <StrictMode><Harness /></StrictMode> : <Harness />);
