import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient';
import { traceSupabaseQuery } from './data/shared';

export type UserRole = 'super_admin' | 'tallerista' | 'staff';

const VALID_USER_ROLES: UserRole[] = ['super_admin', 'tallerista', 'staff'];

const isUserRole = (role: unknown): role is UserRole =>
    typeof role === 'string' && VALID_USER_ROLES.includes(role as UserRole);

export interface Profile {
    id: string;
    email: string;
    full_name?: string;
    phone?: string;
    avatar_url?: string;
    role: UserRole;
    created_at?: string;
    updated_at?: string;
}

interface AuthContextType {
    session: Session | null;
    user: User | null;
    profile: Profile | null;
    loading: boolean;
    error: string | null;
    sedeId: string | null;
    isSuperAdmin: boolean;
    isTallerista: boolean;
    isStaff: boolean;
    login: (email: string, password: string) => Promise<{ success: boolean; role?: UserRole; error?: string }>;
    logout: () => Promise<void>;
    clearError: () => void;
}

type LoginResult = Awaited<ReturnType<AuthContextType['login']>>;
const CANCELLED_LOGIN: LoginResult = { success: false, error: 'El inicio de sesión fue cancelado.' };

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};

interface AuthProviderProps {
    children: ReactNode;
}

// Max time (ms) to wait for auth initialization before forcing loading=false
const AUTH_TIMEOUT_MS = 8000;

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
    const [session, setSession] = useState<Session | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [profile, setProfile] = useState<Profile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sedeId, setSedeId] = useState<string | null>(null);

    const mountedRef = useRef(false);
    const generationRef = useRef(0);
    const actorRef = useRef<string | null>(null);
    const sessionRef = useRef<Session | null>(null);
    const endedActorRef = useRef<{ id: string | null; email?: string } | null>(null);
    const authorizationRef = useRef<number | null>(null);
    const initializedRef = useRef(false);
    const profileRef = useRef<Profile | null>(null);
    const loginInProgressRef = useRef<number | null>(null);
    const passwordRequestRef = useRef<{
        generation: number;
        email: string;
        promise: ReturnType<typeof supabase.auth.signInWithPassword>;
    } | null>(null);
    const signOutInProgressRef = useRef<number | null>(null);
    const scheduledRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    const isCurrent = useCallback((generation: number, actor?: string) =>
        mountedRef.current && generationRef.current === generation
        && (actor === undefined || actorRef.current === actor), []);

    const invalidateIdentity = useCallback((nextSession: Session | null) => {
        const generation = ++generationRef.current;
        for (const timer of scheduledRef.current) clearTimeout(timer);
        scheduledRef.current.clear();
        actorRef.current = nextSession?.user.id ?? null;
        sessionRef.current = nextSession;
        profileRef.current = null;
        authorizationRef.current = null;
        loginInProgressRef.current = null;
        if (mountedRef.current) {
            setSession(nextSession);
            setUser(nextSession?.user ?? null);
            setProfile(null);
            setSedeId(null);
            setLoading(Boolean(nextSession));
        }
        return generation;
    }, []);

    const fetchProfile = useCallback(async (userId: string): Promise<Profile | null> => {
        try {
            const { data, error } = await traceSupabaseQuery('auth.profile.select', supabase
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .single());

            if (error) {
                console.error('Error fetching profile:', error.message);
                return null;
            }

            if (data?.id !== userId || !isUserRole(data?.role)) {
                console.error('Invalid authorized profile:', data?.id, data?.role);
                return null;
            }

            return data as Profile;
        } catch (err) {
            console.error('Error in fetchProfile:', err);
            return null;
        }
    }, []);

    const fetchSedeId = useCallback(async (userId: string, role: UserRole): Promise<string | null> => {
        if (role === 'super_admin') {
            return null;
        }

        try {
            // These lookups are independent. Running them together removes a
            // full round-trip from the initial auth gate for staff accounts.
            const [{ data: ownedSedes, error: ownedError }, { data: memberships, error: memberError }] = await traceSupabaseQuery('auth.sede.lookups', Promise.all([
                supabase.from('sedes').select('id').eq('owner_id', userId).eq('is_active', true).limit(1),
                supabase.from('sede_members').select('sede_id').eq('user_id', userId).limit(1)
            ]));

            if (!ownedError && ownedSedes && ownedSedes.length > 0) {
                return ownedSedes[0].id;
            }

            if (!memberError && memberships && memberships.length > 0) {
                return memberships[0].sede_id;
            }

            console.warn('No sede found for user', userId);
            return null;
        } catch (err) {
            console.error('Error fetching sede_id:', err);
            return null;
        }
    }, []);

    const signOutCurrent = useCallback(async (generation: number, expectedActor?: string) => {
        if (!isCurrent(generation)) return;
        signOutInProgressRef.current = generation;
        try {
            // Wait for the SDK lock BEFORE deciding whether this actor may be signed out.
            const { data: { session: storedSession } } = await supabase.auth.getSession();
            if (!isCurrent(generation)) return;
            if (expectedActor && storedSession?.user.id !== expectedActor) return;
            // The SDK has no actor-conditional signOut. Keep this provider's
            // password requests blocked until the SDK operation settles.
            const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
            if (!isCurrent(generation)) return;
            if (signOutError) throw signOutError;
        } catch (err) {
            if (!isCurrent(generation)) return;
            console.error('Error logging out:', err);
            try {
                Object.keys(localStorage)
                    .filter(k => k.startsWith('sb-') && k.endsWith('-auth-token'))
                    .forEach(k => localStorage.removeItem(k));
            } catch {}
        } finally {
            if (signOutInProgressRef.current === generation) signOutInProgressRef.current = null;
        }
    }, [isCurrent]);

    // Every authorization lane uses the same actor/generation checks, including rejection.
    const loadUserData = useCallback(async (generation: number,
        profileError = 'Tu cuenta no tiene un perfil autorizado. Contacta con administración.'): Promise<LoginResult> => {
        if (!isCurrent(generation)) return CANCELLED_LOGIN;
        const sessionBeforeRead = sessionRef.current;
        const { data: { session: currentSession }, error: sessionError } = await traceSupabaseQuery('auth.session.load_user', supabase.auth.getSession())
            .catch(error => ({ data: { session: null }, error }));
        if (!isCurrent(generation)) return CANCELLED_LOGIN;
        if (sessionError || !currentSession?.user) {
            invalidateIdentity(null);
            if (sessionError) setError('No se pudo verificar la sesión. Vuelve a iniciar sesión.');
            return CANCELLED_LOGIN;
        }

        const actor = currentSession.user.id;
        if (actorRef.current !== actor) {
            generation = invalidateIdentity(currentSession);
            setError(null);
        } else if (sessionRef.current === sessionBeforeRead) {
            sessionRef.current = currentSession;
        }
        endedActorRef.current = null;
        const selectedSession = sessionRef.current ?? currentSession;
        setSession(selectedSession);
        setUser(selectedSession.user);
        authorizationRef.current = generation;
        const userProfile = await fetchProfile(actor);
        if (!isCurrent(generation, actor)) return CANCELLED_LOGIN;

        let accessError = userProfile ? null : profileError;
        let userSedeId: string | null = null;
        if (userProfile) {
            userSedeId = await fetchSedeId(actor, userProfile.role);
            if (!isCurrent(generation, actor)) return CANCELLED_LOGIN;
            if (userProfile.role !== 'super_admin' && !userSedeId) {
                accessError = 'Tu cuenta no está vinculada a un taller activo. Contacta con administración.';
            }
        }

        const sessionBeforeVerification = sessionRef.current;
        const { data: { session: verifiedSession }, error: verificationError } = await traceSupabaseQuery('auth.session.verify', supabase.auth.getSession())
            .catch(error => ({ data: { session: null }, error }));
        if (!isCurrent(generation, actor)) return CANCELLED_LOGIN;
        if (verificationError || verifiedSession?.user.id !== actor) {
            invalidateIdentity(null);
            if (verificationError) setError('No se pudo verificar la sesión. Vuelve a iniciar sesión.');
            return CANCELLED_LOGIN;
        }
        // A same-actor event delivered during getSession owns the newer token.
        if (sessionRef.current === sessionBeforeVerification) sessionRef.current = verifiedSession;

        if (accessError || !userProfile) {
            setSession(null);
            setUser(null);
            setProfile(null);
            profileRef.current = null;
            setSedeId(null);
            setError(accessError);
            setLoading(false);
            await signOutCurrent(generation, actor);
            // SIGNED_OUT invalidates this generation too; no post-sign-out state writes.
            return { success: false, error: accessError ?? profileError };
        }

        const latestSession = sessionRef.current ?? currentSession;
        setSession(latestSession);
        setUser(latestSession.user);
        setProfile(userProfile);
        profileRef.current = userProfile;
        setSedeId(userSedeId);
        setError(null);
        authorizationRef.current = null;
        setLoading(false);
        return { success: true, role: userProfile.role };
    }, [fetchProfile, fetchSedeId, invalidateIdentity, isCurrent, signOutCurrent]);

    const scheduleUserData = useCallback((generation: number) => {
        authorizationRef.current = generation;
        const timer = setTimeout(() => {
            scheduledRef.current.delete(timer);
            if (isCurrent(generation)) void loadUserData(generation);
        }, 0);
        scheduledRef.current.add(timer);
    }, [isCurrent, loadUserData]);

    // Initialize auth on mount
    useEffect(() => {
        let active = true;
        mountedRef.current = true;
        initializedRef.current = false;
        endedActorRef.current = null;
        const initialGeneration = invalidateIdentity(null);
        setLoading(true);

        // Safety timeout: if auth takes too long, force loading=false
        const timeoutId = setTimeout(() => {
            if (isCurrent(initialGeneration) && !initializedRef.current) {
                console.warn('Auth initialization timed out — forcing loading=false');
                initializedRef.current = true;
                setLoading(false);
            }
        }, AUTH_TIMEOUT_MS);

        const initializeAuth = async () => {
            try {
                const { data: { session: currentSession }, error: sessionError } = await traceSupabaseQuery('auth.session.initial', supabase.auth.getSession());

                if (!isCurrent(initialGeneration)) return;

                if (sessionError) {
                    console.warn('Auth session warning:', sessionError.message);
                }

                if (currentSession?.user) {
                    actorRef.current = currentSession.user.id;
                    sessionRef.current = currentSession;
                    setSession(currentSession);
                    setUser(currentSession.user);
                    await loadUserData(initialGeneration);
                } else {
                    // No session: just stop loading
                    setLoading(false);
                }
            } catch (err) {
                if (isCurrent(initialGeneration)) {
                    console.error('Error initializing auth:', err);
                    setLoading(false);
                }
            } finally {
                if (isCurrent(initialGeneration)) {
                    initializedRef.current = true;
                }
            }
        };

        initializeAuth();

        // The SDK awaits subscribers under its lock. Only mutate refs/state here;
        // PostgREST/getSession/signOut must start in a later task.
        const { data: authListener } = supabase.auth.onAuthStateChange((event, newSession) => {
            if (!active || !mountedRef.current) return;

            if (event === 'SIGNED_OUT') {
                if (actorRef.current || passwordRequestRef.current || !endedActorRef.current) {
                    endedActorRef.current = { id: actorRef.current,
                        email: sessionRef.current?.user.email?.toLowerCase() ?? passwordRequestRef.current?.email };
                }
                invalidateIdentity(null);
                return;
            }

            if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && newSession?.user) {
                const endedActor = endedActorRef.current;
                if (!actorRef.current && endedActor && (endedActor.id === newSession.user.id
                    || (endedActor.email && endedActor.email === newSession.user.email?.toLowerCase())
                    || (!endedActor.id && !endedActor.email))
                    && (event === 'TOKEN_REFRESHED' || signOutInProgressRef.current !== null)) return;
                const passwordRequest = passwordRequestRef.current;
                if (event === 'SIGNED_IN' && passwordRequest
                    && newSession.user.email?.toLowerCase() === passwordRequest.email) {
                    // Even a cancelled password request can emit SIGNED_IN before returning.
                    if (isCurrent(passwordRequest.generation)) {
                        endedActorRef.current = null;
                        actorRef.current = newSession.user.id;
                        sessionRef.current = newSession;
                        setSession(newSession);
                        setUser(newSession.user);
                    } else if (actorRef.current || profileRef.current || !endedActorRef.current) {
                        // The SDK saved this cancelled request before notifying us.
                        // Drop other authority now; the later task selects SDK storage,
                        // not this event's possibly superseded session payload.
                        const generation = invalidateIdentity(null);
                        setLoading(true);
                        setError(null);
                        scheduleUserData(generation);
                    }
                    return;
                }

                let generation = generationRef.current;
                endedActorRef.current = null;
                if (actorRef.current !== newSession.user.id) {
                    generation = invalidateIdentity(newSession);
                    setError(null);
                } else {
                    sessionRef.current = newSession;
                    setSession(newSession);
                    setUser(newSession.user);
                }
                if (loginInProgressRef.current === generation || profileRef.current?.id === newSession.user.id
                    || authorizationRef.current === generation) return;

                scheduleUserData(generation);
            }
        });

        return () => {
            active = false;
            mountedRef.current = false;
            invalidateIdentity(null);
            clearTimeout(timeoutId);
            authListener.subscription.unsubscribe();
        };
    }, [invalidateIdentity, isCurrent, loadUserData, scheduleUserData]);

    const login = async (email: string, password: string): Promise<{ success: boolean; role?: UserRole; error?: string }> => {
        if (!mountedRef.current) return CANCELLED_LOGIN;
        if (loginInProgressRef.current !== null || passwordRequestRef.current || signOutInProgressRef.current !== null) {
            return { success: false, error: 'El inicio de sesión ya está en curso.' };
        }
        const generation = invalidateIdentity(null);
        endedActorRef.current = null;
        loginInProgressRef.current = generation;
        setError(null);
        const request = { generation, email: email.trim().toLowerCase(),
            promise: supabase.auth.signInWithPassword({ email, password }) };
        passwordRequestRef.current = request;

        try {
            const { data, error: authError } = await request.promise;
            if (passwordRequestRef.current === request) passwordRequestRef.current = null;
            if (!isCurrent(generation)) {
                // SIGNED_OUT can precede a password response that persists a new SDK
                // session. Clean up only while the ended identity still owns the logout.
                const endedActor = endedActorRef.current;
                if (mountedRef.current && !actorRef.current && data.session && endedActor
                    && (endedActor.id === data.session.user.id || endedActor.email === request.email)
                    && signOutInProgressRef.current === null) {
                    await signOutCurrent(generationRef.current, data.session.user.id);
                } else if (mountedRef.current && data.session && signOutInProgressRef.current === null
                    && (profileRef.current || authorizationRef.current === null)) {
                    // A response can settle after a newer SDK actor/event. Never
                    // restore a captured token; re-select storage with no authority.
                    const nextGeneration = invalidateIdentity(null);
                    setLoading(true);
                    setError(null);
                    scheduleUserData(nextGeneration);
                }
                return CANCELLED_LOGIN;
            }

            if (authError) {
                const errorMessage = authError.message === 'Invalid login credentials'
                    ? 'Credenciales incorrectas. Verifica tu email y contraseña.'
                    : authError.message;
                setError(errorMessage);
                return { success: false, error: errorMessage };
            }

            if (!data.user || !data.session || data.session.user.id !== data.user.id) {
                setError('No se pudo obtener la información del usuario.');
                return { success: false, error: 'No se pudo obtener la información del usuario.' };
            }

            actorRef.current = data.user.id;
            if (sessionRef.current?.user.id !== data.user.id) sessionRef.current = data.session;
            const result = await loadUserData(generation, 'No se encontró el perfil del usuario.');
            if (result.success && !isCurrent(generation, data.user.id)) return CANCELLED_LOGIN;
            return result;
        } catch (err) {
            if (!isCurrent(generation)) return CANCELLED_LOGIN;
            const errorMessage = 'Error inesperado al iniciar sesión.';
            setError(errorMessage);
            return { success: false, error: errorMessage };
        } finally {
            if (passwordRequestRef.current === request) passwordRequestRef.current = null;
            if (loginInProgressRef.current === generation) loginInProgressRef.current = null;
        }
    };

    const logout = async () => {
        if (!mountedRef.current) return;
        const expectedActor = actorRef.current;
        const passwordRequest = passwordRequestRef.current;
        endedActorRef.current = { id: expectedActor,
            email: sessionRef.current?.user.email?.toLowerCase() ?? passwordRequest?.email };
        const generation = invalidateIdentity(null);
        setError(null);
        signOutInProgressRef.current = generation;
        try {
            // A late password response saves its SDK session before emitting SIGNED_IN.
            // Drain it before local sign-out, while preventing a newer password request.
            const passwordResult = passwordRequest ? await passwordRequest.promise.catch(() => null) : null;
            if (!isCurrent(generation)) return;
            await signOutCurrent(generation, passwordResult?.data.user?.id ?? expectedActor ?? undefined);
        } catch (err) {
            if (isCurrent(generation)) console.error('Error logging out:', err);
        } finally {
            if (signOutInProgressRef.current === generation) signOutInProgressRef.current = null;
        }
    };

    const clearError = () => setError(null);

    const value: AuthContextType = {
        session,
        user,
        profile,
        loading,
        error,
        sedeId,
        isSuperAdmin: profile?.role === 'super_admin',
        isTallerista: profile?.role === 'tallerista',
        isStaff: profile?.role === 'staff',
        login,
        logout,
        clearError,
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
};

export default AuthContext;
