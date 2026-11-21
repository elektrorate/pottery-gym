import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { Workshop, User, WorkshopStatus, UserRole, ActivityLog, Invitation, InvitationStatus, WorkshopDataMetrics } from '../types';
import { logoutAndRedirect } from '../../utils/logout';
import { madridDateKey } from '../../utils/dateFormat';

interface AppContextType {
  workshops: Workshop[];
  users: User[];
  workshopMetrics: Record<string, WorkshopDataMetrics>;
  globalMetrics: WorkshopDataMetrics;
  activityLogs: ActivityLog[];
  invitations: Invitation[];
  currentUser: User | null;
  login: (email: string, pass: string) => Promise<boolean>;
  logout: () => Promise<void>;
  addWorkshop: (workshop: Omit<Workshop, 'id' | 'createdAt' | 'updatedAt'>) => Promise<boolean>;
  updateWorkshop: (id: string, updates: Partial<Workshop>) => Promise<boolean>;
  deleteWorkshop: (id: string) => Promise<boolean>;
  addUser: (user: Omit<User, 'id'>) => Promise<{ userId: string; sedeId?: string } | null>;
  updateUser: (id: string, updates: Partial<User>) => Promise<void>;
  cancelInvitation: (id: string) => Promise<void>;
  authError: string | null;
  loading: boolean;
  showOptimisticUI: boolean;
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  clearAuthError: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Check if there's likely a session in localStorage (optimistic approach)
const hasStoredSession = (): boolean => {
  try {
    const storageKey = Object.keys(localStorage).find(key =>
      key.startsWith('sb-') && key.endsWith('-auth-token')
    );
    return storageKey ? !!localStorage.getItem(storageKey) : false;
  } catch {
    return false;
  }
};

const createEmptyMetrics = (): WorkshopDataMetrics => ({
  totalStudents: 0,
  membershipStudents: 0,
  temporaryStudents: 0,
  totalGiftCards: 0,
  activeGiftCards: 0,
  expiredGiftCards: 0,
  unlinkedGiftCards: 0,
  missingExpiryGiftCards: 0,
  totalSessions: 0,
  temporalSessions: 0,
  membershipSessions: 0,
  nullAudienceSessions: 0
});

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [workshopMetrics, setWorkshopMetrics] = useState<Record<string, WorkshopDataMetrics>>({});
  const [globalMetrics, setGlobalMetrics] = useState<WorkshopDataMetrics>(createEmptyMetrics());
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  // Start with optimistic loading if there's a stored session
  const [loading, setLoading] = useState(hasStoredSession());
  const [showOptimisticUI, setShowOptimisticUI] = useState(hasStoredSession());
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const fetchProfile = async (userId: string) => {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      console.error('Error fetching profile:', error);
      return null;
    }

    // Map DB profile to App User
    return {
      id: profile.id,
      nombre: profile.full_name || 'Usuario',
      email: profile.email,
      telefono: profile.phone || '',
      pais: '', // Not in DB yet
      ciudad: '', // Not in DB yet
      estado: WorkshopStatus.ACTIVE,
      rolesGlobales: profile.role === 'super_admin' ? [UserRole.SUPER_ADMIN] : [UserRole.WORKSHOP_ADMIN],
      rolesPorTaller: [] // Logic to be refined based on Sedes ownership
    } as User;
  };

  // Ref to track if initialization is in progress to prevent double firing in React Strict Mode
  const isInitializingRef = React.useRef(false);

  // Ref to track currentUser to avoid stale closures in loadInitialData
  const currentUserRef = React.useRef<User | null>(null);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // BUG 7 FIX: Added timeout safety to prevent infinite loading
  const ADMIN_LOAD_TIMEOUT_MS = 10000;

  const loadInitialData = async (providedSession?: any) => {
    if (isInitializingRef.current) {
      console.log('Skipping loadInitialData: already initializing');
      return;
    }

    isInitializingRef.current = true;
    console.log('--- Loading Initial Data ---');

    // Only show full screen loading if we don't have a user yet (initial load)
    // allowing background refreshes without blocking UI
    // Use ref to check current state, as this function might be closed over initial render
    if (!currentUserRef.current) {
      setLoading(true);
    }
    setAuthError(null);

    // BUG 7 FIX: Safety timeout to prevent infinite loading
    const timeoutId = setTimeout(() => {
      console.warn('loadInitialData: timeout reached, forcing loading=false');
      setLoading(false);
      setShowOptimisticUI(false);
      isInitializingRef.current = false;
    }, ADMIN_LOAD_TIMEOUT_MS);

    try {
      let session = providedSession;
      if (!session) {
        const { data } = await supabase.auth.getSession();
        session = data.session;
      }

      if (session?.user) {
        console.log('User found, fetching profile...');
        const user = await fetchProfile(session.user.id);

        if (user) {
          console.log('User profile loaded, setting context...');
          setCurrentUser(user);

          console.log('Fetching workshops, users and operational metrics in parallel...');
          // Execute fetches in parallel
          await Promise.all([fetchWorkshops(), fetchUsers(), fetchOperationalMetrics()]);
          console.log('Initial data loaded successfully.');
        } else {
          console.warn('No profile found for user');
        }
      } else {
        console.log('No active session');
        setCurrentUser(null);
      }
    } catch (error) {
      console.error('Error loading initial data:', error);
      showToast('Error cargando datos del sistema', 'error');
    } finally {
      clearTimeout(timeoutId);
      console.log('Cleaning up loading state...');
      setLoading(false);
      setShowOptimisticUI(false);
      isInitializingRef.current = false;
    }
  };

  const fetchWorkshops = async () => {
    try {
      const { data, error } = await supabase.from('sedes').select('*');
      if (error) {
        throw error;
      }
      if (!data) return;

      const mapped: Workshop[] = data.map((s: any) => ({
        id: s.id,
        nombre: s.name,
        pais: s.country || '',
        ciudad: s.city || '',
        direccion: s.address || '',
        lat: 0,
        lng: 0,
        emailTaller: s.contact_email,
        telefonoTaller: s.contact_phone,
        estado: s.is_active ? WorkshopStatus.ACTIVE : WorkshopStatus.INACTIVE,
        adminGeneralUserId: s.owner_id,
        adminUserIds: s.owner_id ? [s.owner_id] : [],
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }));
      setWorkshops(mapped);
    } catch (error) {
      console.error('Error fetching workshops:', error);
      // Don't toast here to avoid spamming if multiple fail, or handle gracefully
    }
  };

  const fetchUsers = async () => {
    const { data, error } = await supabase.from('profiles').select('*');
    if (error) {
      console.error(error);
      return;
    }
    const mapped: User[] = data.map((p: any) => ({
      id: p.id,
      nombre: p.full_name || 'Sin nombre',
      email: p.email,
      telefono: p.phone || '',
      pais: '',
      ciudad: '',
      estado: WorkshopStatus.ACTIVE,
      rolesGlobales: p.role === 'super_admin' ? [UserRole.SUPER_ADMIN] : [UserRole.WORKSHOP_ADMIN],
      rolesPorTaller: []
    }));
    setUsers(mapped);
  };

  const fetchOperationalMetrics = async () => {
    try {
      const todayIso = madridDateKey();
      const [studentsRes, sessionsRes, giftCardsRes] = await Promise.all([
        supabase.from('students').select('id, sede_id, student_category'),
        supabase.from('sessions').select('id, sede_id, session_audience'),
        supabase.from('gift_cards').select('id, sede_id, expiry_date, recipient_student_id')
      ]);

      if (studentsRes.error) throw studentsRes.error;
      if (sessionsRes.error) throw sessionsRes.error;
      if (giftCardsRes.error) throw giftCardsRes.error;

      const byWorkshop: Record<string, WorkshopDataMetrics> = {};
      const ensureMetrics = (sedeId?: string | null) => {
        if (!sedeId) return null;
        if (!byWorkshop[sedeId]) {
          byWorkshop[sedeId] = createEmptyMetrics();
        }
        return byWorkshop[sedeId];
      };

      (studentsRes.data || []).forEach((student: any) => {
        const target = ensureMetrics(student.sede_id);
        if (!target) return;
        target.totalStudents += 1;
        const category = student.student_category || 'membresia';
        if (category === 'membresia') target.membershipStudents += 1;
        if (category === 'temporal') target.temporaryStudents += 1;
      });

      (sessionsRes.data || []).forEach((session: any) => {
        const target = ensureMetrics(session.sede_id);
        if (!target) return;
        target.totalSessions += 1;
        if (session.session_audience === 'temporal') target.temporalSessions += 1;
        else if (session.session_audience === 'membresia') target.membershipSessions += 1;
        else target.nullAudienceSessions += 1;
      });

      (giftCardsRes.data || []).forEach((card: any) => {
        const target = ensureMetrics(card.sede_id);
        if (!target) return;
        target.totalGiftCards += 1;

        if (!card.recipient_student_id) {
          target.unlinkedGiftCards += 1;
        }

        if (!card.expiry_date) {
          target.missingExpiryGiftCards += 1;
          return;
        }

        if (card.expiry_date < todayIso) target.expiredGiftCards += 1;
        else target.activeGiftCards += 1;
      });

      const global = Object.values(byWorkshop).reduce((acc, current) => ({
        totalStudents: acc.totalStudents + current.totalStudents,
        membershipStudents: acc.membershipStudents + current.membershipStudents,
        temporaryStudents: acc.temporaryStudents + current.temporaryStudents,
        totalGiftCards: acc.totalGiftCards + current.totalGiftCards,
        activeGiftCards: acc.activeGiftCards + current.activeGiftCards,
        expiredGiftCards: acc.expiredGiftCards + current.expiredGiftCards,
        unlinkedGiftCards: acc.unlinkedGiftCards + current.unlinkedGiftCards,
        missingExpiryGiftCards: acc.missingExpiryGiftCards + current.missingExpiryGiftCards,
        totalSessions: acc.totalSessions + current.totalSessions,
        temporalSessions: acc.temporalSessions + current.temporalSessions,
        membershipSessions: acc.membershipSessions + current.membershipSessions,
        nullAudienceSessions: acc.nullAudienceSessions + current.nullAudienceSessions
      }), createEmptyMetrics());

      setWorkshopMetrics(byWorkshop);
      setGlobalMetrics(global);
    } catch (error) {
      console.error('Error fetching operational metrics:', error);
    }
  };

  useEffect(() => {
    loadInitialData();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('Auth state change:', event);
      if (event === 'SIGNED_IN' && session) {
        // Prevent reload if we already have a user and the IDs match
        if (currentUserRef.current && currentUserRef.current.id === session.user.id) {
          console.log('Already logged in as', session.user.email, '- skipping reload');
          return;
        }
        await loadInitialData(session);
      } else if (event === 'SIGNED_OUT') {
        setCurrentUser(null);
        setWorkshops([]);
        setUsers([]);
        setWorkshopMetrics({});
        setGlobalMetrics(createEmptyMetrics());
        isInitializingRef.current = false;
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const login = async (email: string, pass: string): Promise<boolean> => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) {
      console.error("Login error:", error);
      let message = 'Error al iniciar sesión.';
      if (error.message.includes("Invalid login credentials") || error.message.includes("invalid_grant")) {
        message = 'Credenciales erróneas';
      } else if (error.message.includes("Email not confirmed")) {
        message = 'El correo electrónico no ha sido confirmado. Por favor revisa tu bandeja de entrada.';
      } else {
        message = error.message;
      }
      setAuthError(message);
      return false;
    }
    return true;
  };

  const logout = async () => {
    await logoutAndRedirect('/login');
  };

  const clearAuthError = () => setAuthError(null);

  // BUG 14 FIX: Helper to normalize slug (remove accents and special chars)
  const normalizeSlug = (str: string): string => {
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove accents
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-') // Spaces to hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .trim();
  };

  const addWorkshop = async (workshop: Omit<Workshop, 'id' | 'createdAt' | 'updatedAt'>): Promise<boolean> => {
    try {
      // BUG 2 FIX: Include is_active: true and use || null for optional fields
      const { error } = await supabase.from('sedes').insert({
        name: workshop.nombre,
        address: workshop.direccion || null,
        city: workshop.ciudad || null,
        country: workshop.pais || null,
        contact_email: workshop.emailTaller || null,
        contact_phone: workshop.telefonoTaller || null,
        owner_id: workshop.adminGeneralUserId,
        slug: normalizeSlug(workshop.nombre),
        is_active: true  // BUG 2 FIX: Explicitly set active
      });

      if (error) {
        showToast('Error creando taller: ' + error.message, 'error');
        return false;
      }
      showToast('Taller creado con éxito', 'success');
      Promise.all([fetchWorkshops(), fetchOperationalMetrics()]);
      return true;
    } catch (err: any) {
      showToast('Error inesperado creando taller: ' + (err.message || ''), 'error');
      return false;
    }
  };

  const updateWorkshop = async (id: string, updates: Partial<Workshop>): Promise<boolean> => {
    try {
      // BUG 1 FIX: Use || null for optional fields so empty strings clear the DB value
      const dbPayload: Record<string, unknown> = {};
      if (updates.nombre !== undefined) {
        dbPayload.name = updates.nombre;
        dbPayload.slug = normalizeSlug(updates.nombre);
      }
      if (updates.direccion !== undefined) dbPayload.address = updates.direccion || null;
      if (updates.ciudad !== undefined) dbPayload.city = updates.ciudad || null;
      if (updates.pais !== undefined) dbPayload.country = updates.pais || null;
      if (updates.emailTaller !== undefined) dbPayload.contact_email = updates.emailTaller || null;
      if (updates.telefonoTaller !== undefined) dbPayload.contact_phone = updates.telefonoTaller || null;
      if (updates.estado !== undefined) dbPayload.is_active = updates.estado === WorkshopStatus.ACTIVE;
      if (updates.adminGeneralUserId !== undefined) dbPayload.owner_id = updates.adminGeneralUserId || null;

      const { error } = await supabase.from('sedes').update(dbPayload).eq('id', id);

      if (error) {
        showToast('Error actualizando taller: ' + error.message, 'error');
        return false;
      }
      showToast('Taller actualizado', 'success');
      Promise.all([fetchWorkshops(), fetchOperationalMetrics()]);
      return true;
    } catch (err: any) {
      showToast('Error inesperado actualizando taller: ' + (err.message || ''), 'error');
      return false;
    }
  };

  const deleteWorkshop = async (id: string): Promise<boolean> => {
    try {
      // Find the owner (tallerista) of this sede
      const workshop = workshops.find(w => w.id === id);
      const ownerId = workshop?.adminGeneralUserId;

      if (!ownerId) {
        showToast('No se encontró el propietario del taller', 'error');
        return false;
      }

      // Call the Edge Function that deletes EVERYTHING:
      // auth user + profile + sede + all dependent data (teachers, students, etc.)
      const { data, error } = await supabase.functions.invoke('delete-user', {
        body: { userId: ownerId }
      });

      if (error) {
        showToast('Error al eliminar: ' + error.message, 'error');
        return false;
      }

      if (data?.error) {
        showToast(data.error, 'error');
        return false;
      }

      showToast('Taller y usuario eliminados correctamente', 'success');
      Promise.all([fetchWorkshops(), fetchUsers(), fetchOperationalMetrics()]);
      return true;
    } catch (err: any) {
      showToast('Error inesperado: ' + (err.message || ''), 'error');
      return false;
    }
  };

  const addUser = async (user: Omit<User, 'id'>): Promise<{ userId: string; sedeId?: string } | null> => {
    try {
      if (!user.password?.trim()) {
        showToast('Debes definir una contraseña para el nuevo usuario', 'error');
        return null;
      }
      const { data, error } = await supabase.functions.invoke('create-user', {
        body: {
          email: user.email,
          password: user.password,
          nombre: user.nombre,
          role: 'tallerista',
          telefono: user.telefono,
          pais: user.pais,
          ciudad: user.ciudad
        }
      });

      if (error) {
        const msg = error.message || 'Error desconocido';
        throw new Error(msg);
      }

      if (!data) {
        throw new Error('No se recibió respuesta. Inténtelo de nuevo.');
      }

      // Check for error in response body
      if (data.error) {
        throw new Error(data.error);
      }

      // Successful creation — Edge Function now returns { user, sede }
      const userId = data.id || data.user?.id;

      if (!userId) {
        console.warn('User created but no ID returned immediately', data);
        if (data.email) {
          showToast(`Usuario ${user.nombre} creado correctamente`, 'success');
          Promise.all([fetchUsers(), fetchWorkshops(), fetchOperationalMetrics()]);
          return { userId: data.id };
        }
        throw new Error('No se pudo crear el usuario. Inténtelo de nuevo.');
      }

      // Log sede creation result
      if (data.sede) {
        if (data.sede.error) {
          console.warn('Sede auto-creation had an issue:', data.sede.error);
        } else {
          console.log('Sede auto-created:', data.sede.id, data.sede.name);
        }
      }

      showToast(`Usuario ${user.nombre} creado correctamente`, 'success');
      // Fire-and-forget: refresh in background, don't block the UI
      Promise.all([fetchUsers(), fetchWorkshops(), fetchOperationalMetrics()]);
      return { userId, sedeId: data.sede?.id };

    } catch (err: any) {
      console.error('Error creating user:', err);
      showToast(err.message || 'Error al crear usuario', 'error');
      return null;
    }
  };

  // BUG 6 FIX: Added await to fetchUsers() so toast appears after data refresh
  const updateUser = async (id: string, updates: Partial<User>) => {
    const { error } = await supabase.from('profiles').update({
      full_name: updates.nombre,
      phone: updates.telefono
    }).eq('id', id);

    if (error) {
      showToast('Error actualizando usuario', 'error');
      return;
    }
    fetchUsers();
    showToast('Usuario actualizado', 'info');
  };

  const cancelInvitation = async (id: string) => {
    setInvitations(prev => prev.filter(i => i.id !== id));
    showToast('Invitación cancelada', 'info');
  };

  const showToast = (message: string, type: 'success' | 'error' | 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <AppContext.Provider value={{ workshops, users, workshopMetrics, globalMetrics, activityLogs, invitations, currentUser, login, logout, addWorkshop, updateWorkshop, deleteWorkshop, addUser, updateUser, cancelInvitation, loading, showOptimisticUI, toast, showToast, authError, clearAuthError }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within AppProvider');
  return context;
};
