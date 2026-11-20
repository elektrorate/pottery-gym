import { designerStorageKey, clearDesignerCaches, removeUnscopedDesignerCaches, type DesignerScope } from './lib/cacheScope';
﻿
import React, { useEffect, useState, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { GiftCardData } from './types';
import { GiftCardSide } from './components/GiftCardSide';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Download,
  Globe,
  History as HistoryIcon,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  MessageCircle,
  Phone,
  RefreshCw,
  RotateCcw,
  Save,
  User,
  Users
} from 'lucide-react';
import logoAdjunto from './assets/logos/logo-casa-rosier.png';
import { buildGiftCardPdfBytes } from '../supabase/functions/_shared/gift-card-pdf/giftCardPdf.ts';
import { ScaledCard } from './components/ScaledCard';
import { DEFAULT_VALIDITY_TEXT, LEGACY_DEFAULT_VALIDITY_TEXT, PREVIOUS_DEFAULT_VALIDITY_TEXT, VALIDITY_OPTIONS, presentGiftCardCopy } from './lib/giftCardDefaults';
import { formatDate, formatDateTime, formatTime } from '../utils/dateFormat';
import { supabase } from '../supabaseClient';
import { validateGiftCard } from './lib/validation';
import {
  loadLocalHistory,
  saveLocalHistory,
  upsertLocalHistoryRecord,
  type LocalGiftCardRecord
} from './lib/localHistory';
import { generateVoucherCode } from './lib/voucherCode';
import {
  cancelPotteryGiftCard,
  createPotteryGiftCard,
  fetchPotteryHistory,
  fetchSedeStudents,
  mergeHistory,
  updateDesignerStatus,
  type PotteryClassType,
  type PotteryPaymentStatus,
  type PotteryRecord,
  type PotteryStudentOption
} from './lib/potteryStore';
import { decodePrefillToken } from './lib/buildGiftCard';
import { flushSync } from 'react-dom';

const isSupabaseConfigured = true;



const todayEs = () => formatDate(new Date());

/** Tells pottery-gym /giftcards (parent frame, same origin) to reload its bonos. */
const notifyParent = (message: { type: 'bonos-designer:saved'; code: string }) => {
  if (typeof window === 'undefined' || window.parent === window) return;
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch (error) {
    console.warn('No se pudo avisar a pottery-gym:', error);
  }
};

const initialGiftCardData: GiftCardData = {
  buyerName: '',
  donorName: '',
  recipientName: '',
  numberOfClasses: 4,
  sessionDuration: '2.5',
  creationDate: todayEs(),
  voucherCode: '',
  logoUrl: logoAdjunto,
  title: 'BONO REGALO',
  subtitle: 'Clases de Cerámica',
  subtitle2: '',
  introText: '¡Felicidades!',
  mainQuote: '"En tus manos sostienes uno de los regalos más especiales que podrías recibir:\nUna invitación a un día lleno de inspiración y creatividad."',
  fromLabel: 'Este regalo tan significativo llega a ti gracias a:',
  experienceTitle: 'Instrucciones de Uso',
  experienceIntro: 'Contacta con nosotros para reservar tus clases',
  experienceLocation: 'Presenta este bono regalo al inicio de tu primera clase',
  experienceBullet4: '',
  includesLabel: 'Este bono regalo incluye:',
  includesDetails: 'Disfruta de la experiencia creativa',
  validityText: DEFAULT_VALIDITY_TEXT,
  contactTitle: 'Información de contacto',
  contactSubtitle: 'Cómo usar tu bono regalo',
  phone: '+34 633 788 860',
  email: 'info@casarosierceramica.com',
  website: 'www.casarosierceramica.com',
  internalContactPhone: ''
};

const loadDraft = (scope: DesignerScope): GiftCardData => {
  const DRAFT_STORAGE_KEY = designerStorageKey('draft', scope);
  if (!DRAFT_STORAGE_KEY) return { ...initialGiftCardData, creationDate: todayEs() };
  if (typeof window === 'undefined') return { ...initialGiftCardData, creationDate: todayEs() };

  try {
    const rawDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!rawDraft) return { ...initialGiftCardData, creationDate: todayEs() };

    const parsedDraft: unknown = JSON.parse(rawDraft);
    if (parsedDraft && typeof parsedDraft === 'object') {
      const restoredDraft = { ...initialGiftCardData, ...(parsedDraft as Partial<GiftCardData>) };
      return presentGiftCardCopy({
        ...restoredDraft,
        // Always stamp today's date; drafts must not keep a stale emission date.
        creationDate: todayEs(),
        voucherCode: '',
        // Drafts saved before the 12-month default still carry the old default.
        validityText: restoredDraft.validityText === LEGACY_DEFAULT_VALIDITY_TEXT
          || restoredDraft.validityText === PREVIOUS_DEFAULT_VALIDITY_TEXT
          ? DEFAULT_VALIDITY_TEXT
          : restoredDraft.validityText,
        // Old defaults without accents move to the corrected defaults.
        contactTitle: restoredDraft.contactTitle === 'Informacion de contacto'
          ? initialGiftCardData.contactTitle
          : restoredDraft.contactTitle,
        contactSubtitle: restoredDraft.contactSubtitle === 'Como usar tu tarjeta'
          || restoredDraft.contactSubtitle === 'Cómo usar tu tarjeta'
          ? initialGiftCardData.contactSubtitle
          : restoredDraft.contactSubtitle,
        internalContactPhone: restoredDraft.internalContactPhone || ''
      });
    }
  } catch (error) {
    console.warn('No se pudo restaurar el borrador local:', error);
  }

  return { ...initialGiftCardData, creationDate: todayEs() };
};

type GiftCardRecord = PotteryRecord;

type GiftCardStatus = 'created' | 'sent' | 'redeemed' | 'cancelled';

const statusLabels: Record<GiftCardStatus, string> = {
  created: 'Creado',
  sent: 'Enviado',
  redeemed: 'Utilizado',
  cancelled: 'Cancelado'
};

const normalizeStatus = (status: string | null | undefined): GiftCardStatus => {
  if (status === 'sent' || status === 'redeemed' || status === 'cancelled') return status;
  return 'created';
};

const normalizeWhatsAppPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  return /^[6789]\d{8}$/.test(digits) ? `34${digits}` : digits;
};

const getSafeFileName = (buyerName: string): string => {
  const safeBuyer = buyerName
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return safeBuyer ? `Bono-Casa-Rosier-${safeBuyer}.pdf` : 'Bono-Casa-Rosier.pdf';
};

interface GiftCardTemplate {
  id: string;
  name: string;
  data: GiftCardData;
  updatedAt: string;
}



const loadTemplates = (scope: DesignerScope): GiftCardTemplate[] => {
  const TEMPLATE_STORAGE_KEY = designerStorageKey('templates', scope);
  if (!TEMPLATE_STORAGE_KEY) return [];
  if (typeof window === 'undefined') return [];

  try {
    const rawTemplates = window.localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!rawTemplates) return [];

    const parsedTemplates: unknown = JSON.parse(rawTemplates);
    if (!Array.isArray(parsedTemplates)) return [];

    return parsedTemplates.filter((template): template is GiftCardTemplate => {
      if (!template || typeof template !== 'object') return false;
      const candidate = template as Partial<GiftCardTemplate>;
      return typeof candidate.id === 'string'
        && typeof candidate.name === 'string'
        && typeof candidate.updatedAt === 'string'
        && Boolean(candidate.data);
    }).slice(0, 20);
  } catch (error) {
    console.warn('No se pudieron cargar las plantillas locales:', error);
    return [];
  }
};

type EditorSectionKey = 'gift' | 'front' | 'back' | 'contact';

interface EditorSectionProps {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const EditorSection: React.FC<EditorSectionProps> = ({ title, description, open, onToggle, children }) => (
  <section className="overflow-hidden rounded-lg border border-stone-200 bg-white">
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-slate-50"
    >
      <span>
        <span className="block text-[13px] font-bold uppercase tracking-[0.12em] text-stone-700">{title}</span>
        <span className="mt-1 block text-xs text-stone-500">{description}</span>
      </span>
      {open ? <ChevronDown size={19} className="shrink-0 text-stone-600" /> : <ChevronRight size={19} className="shrink-0 text-stone-600" />}
    </button>
    {open ? <div className="border-t border-stone-200 p-5">{children}</div> : null}
  </section>
);

const AdminApp: React.FC = () => {
  const [data, setData] = useState<GiftCardData>(() => ({ ...initialGiftCardData, creationDate: todayEs() }));
  const [history, setHistory] = useState<GiftCardRecord[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyStatus, setHistoryStatus] = useState<'all' | GiftCardStatus>('all');
  const [showHistory, setShowHistory] = useState(false);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const actorIdRef = useRef<string | null>(null);
  const [sedeLoading, setSedeLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured);
  const [authBusy, setAuthBusy] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedPdf, setGeneratedPdf] = useState<{ fileName: string; blob: Blob } | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [activeFormToken, setActiveFormToken] = useState<string | null>(null);
  const [templates, setTemplates] = useState<GiftCardTemplate[]>([]);
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [sedeId, setSedeId] = useState<string | null>(null);
  const cacheScope: DesignerScope = session?.user.id && sedeId ? { userId: session.user.id, sedeId } : null;
  const scopeKey = designerStorageKey('identity', cacheScope);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const resetSensitiveState = () => {
    setData({ ...initialGiftCardData, creationDate: todayEs() }); setTemplates([]); setHistory([]);
    setGeneratedPdf(null); setActiveRecordId(null); setActiveFormToken(null); setStudents([]);
    setRecipientStudentId(''); setNotice(null); setShowHistory(false); setExpandedRecordId(null);
    setAuthPassword(''); setHistoryQuery(''); setDraftSavedAt(null); setHistoryError(null);
  };
  useEffect(() => {
    removeUnscopedDesignerCaches();
    resetSensitiveState();
    if (cacheScope) { setData(loadDraft(cacheScope)); setTemplates(loadTemplates(cacheScope)); }
    setLoadedScope(scopeKey);
  }, [scopeKey]);

  const [students, setStudents] = useState<PotteryStudentOption[]>([]);
  const [recipientStudentId, setRecipientStudentId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<PotteryPaymentStatus>('pending');
  const [classType, setClassType] = useState<PotteryClassType>('modelado');
  const [openSections, setOpenSections] = useState<Record<EditorSectionKey, boolean>>({
    gift: true,
    front: true,
    back: false,
    contact: false
  });

  const filteredHistory = history.filter((record) => {
    const query = historyQuery.trim().toLowerCase();
    const matchesQuery = !query || [
      record.fileName,
      record.voucherCode || '',
      record.data.recipientName,
      record.data.donorName
    ].some((value) => value.toLowerCase().includes(query));
    const matchesStatus = historyStatus === 'all' || record.status === historyStatus;
    return matchesQuery && matchesStatus;
  });

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setAuthLoading(false);
      return;
    }

    let mounted = true;
    void supabase.auth.getSession().then(({ data: authData, error }) => {
      if (!mounted) return;
      if (error) setAuthError('No se pudo comprobar la sesión.');
      actorIdRef.current = authData.session?.user.id ?? null;
      setSession(authData.session);
      setAuthLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT') { clearDesignerCaches(); resetSensitiveState(); setSedeId(null); setLoadedScope(null); }
      const nextActor = nextSession?.user.id ?? null;
      if (nextActor !== actorIdRef.current) { clearDesignerCaches(); resetSensitiveState(); setSedeId(null); setLoadedScope(null); setSedeLoading(Boolean(nextActor)); }
      actorIdRef.current = nextActor;
      setSession(nextSession);
      setAuthLoading(false);
    });

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    try {
      const DRAFT_STORAGE_KEY = designerStorageKey('draft', cacheScope);
      if (!DRAFT_STORAGE_KEY || loadedScope !== scopeKey) return;
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(data));
      setDraftSavedAt(new Date());
      setGeneratedPdf(null);
    } catch (error) {
      console.warn('No se pudo guardar el borrador local:', error);
    }
  }, [data, scopeKey, loadedScope]);

  useEffect(() => {
    try {
      const TEMPLATE_STORAGE_KEY = designerStorageKey('templates', cacheScope);
      if (!TEMPLATE_STORAGE_KEY || loadedScope !== scopeKey) return;
      window.localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
    } catch (error) {
      console.warn('No se pudieron guardar las plantillas locales:', error);
    }
  }, [templates, scopeKey, loadedScope]);

  useEffect(() => {
    if (!showHistory) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHistory(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showHistory]);

  useEffect(() => {
    setData((previous) => ({ ...previous, creationDate: todayEs() }));
  }, []);

  useEffect(() => {
    if (authLoading || !scopeKey || loadedScope !== scopeKey) return;
    if (isSupabaseConfigured && !session) return;

    try {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('prefill');
      if (!token) return;

      const prefill = decodePrefillToken(token);
      if (!prefill) {
        setNotice({ type: 'error', message: 'No se pudo importar el bono regalo del bot (prefill inválido).' });
        return;
      }

      setData((previous) => ({
        ...previous,
        ...prefill,
        logoUrl: previous.logoUrl,
        creationDate: prefill.creationDate || todayEs(),
        voucherCode: prefill.voucherCode || previous.voucherCode
      }));
      setNotice({
        type: 'success',
        message: `Bono regalo del bot cargado${prefill.voucherCode ? ` (${prefill.voucherCode})` : ''}.`
      });

      params.delete('prefill');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    } catch (error) {
      console.warn('No se pudo aplicar prefill del bot:', error);
    }
  }, [authLoading, scopeKey, loadedScope]);

  const handleSignIn = async () => {
    if (!supabase) return;

    setAuthBusy(true);
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim().toLowerCase(),
      password: authPassword
    });

    if (error) {
      const detail = error.message?.toLowerCase().includes('invalid')
        ? 'Email o contraseña incorrectos.'
        : `No se pudo iniciar sesión (${error.message}).`;
      setAuthError(detail);
    }
    setAuthBusy(false);
  };

  const handleSignOut = async () => {
    if (!supabase) return;
    clearDesignerCaches(); resetSensitiveState();
    await supabase.auth.signOut();
    setShowHistory(false);
  };

  const loadAllHistory = async (): Promise<void> => {
    const requestScope = scopeKey;
    if (!requestScope || loadedScope !== requestScope) { setHistory([]); return; }
    setHistoryLoading(true);
    setHistoryError(null);

    const localRecords = loadLocalHistory(cacheScope).map((record) => ({ ...record, origin: 'local' as const }));
    setHistory(localRecords);

    let server: GiftCardRecord[] = [];
    if (session && sedeId) {
      try {
        server = await fetchPotteryHistory(supabase, sedeId, initialGiftCardData);
      } catch (error) {
        console.warn('Historial de pottery-gym no disponible; se usa el local:', error);
        setHistoryError('No se pudo leer el historial de pottery-gym; se muestra el historial de este navegador.');
      }
    }
    if (currentScope.current !== requestScope) return;
    setHistory(mergeHistory<GiftCardRecord>(server, localRecords));
    setHistoryLoading(false);
  };

  useEffect(() => {
    void loadAllHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, sedeId, loadedScope]);

  // Sede of the logged-in user (same lookup as pottery-gym); ?sede= from /giftcards wins if accessible.
  useEffect(() => {
    if (!session) {
      setSedeId(null);
      return;
    }
    let active = true;
    const resolveSede = async () => {
      const requested = new URLSearchParams(window.location.search).get('sede');
      if (requested) {
        const { data: row } = await supabase.from('sedes').select('id').eq('id', requested).eq('is_active', true).maybeSingle();
        if (active && row?.id) {
          setSedeId(row.id); setSedeLoading(false);
          return;
        }
      }
      const userId = session.user.id;
      const [{ data: owned }, { data: memberships }] = await Promise.all([
        supabase.from('sedes').select('id').eq('owner_id', userId).eq('is_active', true).limit(1),
        supabase.from('sede_members').select('sede_id').eq('user_id', userId).limit(1)
      ]);
      if (!active) return;
      const resolved = owned?.[0]?.id || memberships?.[0]?.sede_id || null;
      setSedeId(resolved); setSedeLoading(false);
      if (!resolved) setNotice({ type: 'error', message: 'Tu usuario no tiene una sede de pottery-gym asignada. Los bonos regalo no se podrán guardar.' });
    };
    void resolveSede().catch(() => { if (active) { setSedeId(null); setSedeLoading(false); setNotice({type:'error',message:'No se pudo verificar tu taller. Vuelve a iniciar sesión.'}); } });
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session || !sedeId) {
      setStudents([]);
      return;
    }
    let active = true;
    fetchSedeStudents(supabase, sedeId)
      .then((rows) => { if (active) setStudents(rows); })
      .catch((error) => console.warn('No se pudieron cargar los alumnos de la sede:', error));
    return () => {
      active = false;
    };
  }, [session?.user?.id, sedeId]);

  const handleRefreshHistory = async () => {
    await loadAllHistory();
  };

  const toggleEditorSection = (section: EditorSectionKey) => {
    setOpenSections((previous) => ({ ...previous, [section]: !previous[section] }));
  };

  const handleResetDraft = () => {
    const confirmed = window.confirm('¿Restaurar los valores iniciales del editor? Se perderán los cambios actuales.');
    if (!confirmed) return;

    const freshData = {
      ...initialGiftCardData,
      creationDate: todayEs()
    };
    setData(freshData);
    setActiveRecordId(null);
    setActiveFormToken(null);
    setRecipientStudentId('');
    setPaymentStatus('pending');
    setClassType('modelado');
    setNotice({ type: 'success', message: 'El editor volvió a sus valores iniciales.' });
  };

  const handleSaveTemplate = () => {
    const name = window.prompt('Nombre de la plantilla:');
    if (!name?.trim()) return;

    const template: GiftCardTemplate = {
      id: `template-${Date.now()}`,
      name: name.trim(),
      data: { ...data },
      updatedAt: new Date().toISOString()
    };

    setTemplates((previous) => [template, ...previous].slice(0, 20));
    setNotice({ type: 'success', message: `Plantilla “${template.name}” guardada en este navegador.` });
  };

  const handleApplyTemplate = (templateId: string) => {
    if (!templateId) return;
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;

    setData((current) => ({
      ...template.data,
      recipientName: current.recipientName,
      donorName: current.donorName,
      creationDate: current.creationDate,
      internalContactPhone: current.internalContactPhone
    }));
    setNotice({ type: 'success', message: `Plantilla “${template.name}” aplicada.` });
  };

  const saveCurrentRecord = async (
    fileName: string,
    voucherCode: string,
    cardData: GiftCardData
  ): Promise<'saved' | 'skipped' | 'error'> => {
    const localRecord: GiftCardRecord = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      origin: 'local',
      createdAt: new Date().toISOString(),
      fileName,
      voucherCode,
      formToken: activeFormToken,
      formCompletedAt: null,
      status: 'created',
      data: { ...cardData, voucherCode, creationDate: cardData.creationDate || todayEs() }
    };

    // Local copy first (fallback if pottery-gym is unavailable).
    const nextLocal = upsertLocalHistoryRecord(loadLocalHistory(cacheScope), localRecord);
    saveLocalHistory(nextLocal, cacheScope);
    setActiveRecordId(localRecord.id);
    setHistory((prev) => upsertLocalHistoryRecord(prev, localRecord).slice(0, 200) as GiftCardRecord[]);

    if (!session || !sedeId) return 'error';

    try {
      // Same voucher code as the PDF. Without a chosen student, pottery-gym
      // creates a NEW temporal student. buyer_phone is internal (never printed).
      const saved = await createPotteryGiftCard(
        supabase,
        sedeId,
        localRecord.data,
        { voucherCode, fileName, paymentStatus, type: classType },
        recipientStudentId ? { mode: 'student', studentId: recipientStudentId } : { mode: 'temporal' }
      );
      // Saved in pottery-gym: the local fallback copy is no longer needed.
      saveLocalHistory(loadLocalHistory(cacheScope).filter((item) => item.id !== localRecord.id), cacheScope);
      setActiveRecordId(saved.id);
      setHistory((prev) => upsertLocalHistoryRecord(
        prev.filter((item) => item.id !== localRecord.id),
        saved
      ).slice(0, 200) as GiftCardRecord[]);
      notifyParent({ type: 'bonos-designer:saved', code: voucherCode });
      if (!recipientStudentId) {
        void fetchSedeStudents(supabase, sedeId).then(setStudents).catch(() => undefined);
      }
      return 'saved';
    } catch (error) {
      // Non-fatal for the PDF: the local history keeps it. 23505 = code already exists.
      console.warn('pottery-gym no guardó el bono (queda en el historial local):', error);
      return 'error';
    }
  };

  const handleDeleteRecord = (id: string) => {
    const run = async () => {
      const confirmed = window.confirm('¿Seguro que deseas eliminar este registro? Esta acción no se puede deshacer.');
      if (!confirmed) return;

      const target = history.find((item) => item.id === id);
      if (target?.origin === 'server') {
        // pottery-gym bonos are never deleted: they are cancelled (anulados).
        try {
          await cancelPotteryGiftCard(supabase, id);
          setHistory((prev) => prev.map((item) => (item.id === id ? { ...item, status: 'cancelled' } : item)));
          setNotice({ type: 'success', message: 'El bono regalo queda en pottery-gym como anulado (cancelado).' });
          notifyParent({ type: 'bonos-designer:saved', code: target.voucherCode || '' });
        } catch (error) {
          console.warn('No se pudo anular el bono en pottery-gym:', error);
          setNotice({ type: 'error', message: `No se pudo anular el bono regalo en pottery-gym${error instanceof Error ? ` (${error.message})` : ''}.` });
        }
        return;
      }

      const nextLocal = loadLocalHistory(cacheScope).filter((item) => item.id !== id);
      saveLocalHistory(nextLocal, cacheScope);
      setHistory((prev) => prev.filter((item) => item.id !== id));
      if (expandedRecordId === id) setExpandedRecordId(null);

    };

    void run();
  };

  const handleStatusChange = async (id: string, status: GiftCardStatus) => {
    const target = history.find((item) => item.id === id);

    if (target?.origin === 'server') {
      if (status === target.status) return;
      if (target.status === 'cancelled' || target.status === 'redeemed') {
        setNotice({ type: 'warning', message: 'Este bono regalo ya está cerrado en pottery-gym; su estado no se puede cambiar desde aquí.' });
        return;
      }
      if (status === 'redeemed') {
        setNotice({ type: 'warning', message: 'El consumo se registra en pottery-gym (pestaña «Bonos regalo») al validar la asistencia.' });
        return;
      }
      if (status === 'cancelled') {
        if (!window.confirm('¿Anular este bono regalo en pottery-gym? Quedará visible como anulado.')) return;
        try {
          await cancelPotteryGiftCard(supabase, id);
          setHistory((prev) => prev.map((record) => (record.id === id ? { ...record, status, potteryStatus: 'cancelled' } : record)));
          notifyParent({ type: 'bonos-designer:saved', code: target.voucherCode || '' });
        } catch (error) {
          console.warn('No se pudo anular el bono en pottery-gym:', error);
          setNotice({ type: 'error', message: 'No se pudo anular el bono regalo en pottery-gym.' });
        }
        return;
      }
      try {
        await updateDesignerStatus(supabase, target, status);
        setHistory((prev) => prev.map((record) => (
          record.id === id ? { ...record, status, metadata: { ...(record.metadata || {}), designerStatus: status } } : record
        )));
      } catch (error) {
        console.warn('No se pudo actualizar el estado en pottery-gym:', error);
        setNotice({ type: 'error', message: 'No se pudo actualizar el estado en pottery-gym.' });
      }
      return;
    }

    const nextLocal = loadLocalHistory(cacheScope).map((record) => (
      record.id === id ? { ...record, status } : record
    ));
    saveLocalHistory(nextLocal, cacheScope);
    setHistory((prev) => prev.map((record) => (record.id === id ? { ...record, status } : record)));
  };

  const handleLoadRecord = (record: GiftCardRecord) => {
    setData({ ...record.data });
    setActiveRecordId(record.id);
    setActiveFormToken(record.formToken);
    setShowHistory(false);
    setNotice({ type: 'success', message: `Se cargó el bono regalo ${record.voucherCode || record.fileName} en el editor.` });
  };

  // Shared vector PDF keeps the official card design on every screen size.
  const buildWhatsAppMessage = (card: GiftCardData, fileName?: string) => (
    `Hola ${card.buyerName || ''}, te comparto tu bono regalo de Casa Rosier.\n\nDestinatario: ${card.recipientName}\nDe parte de: ${card.donorName}\nClases: ${card.numberOfClasses}\nDuración: ${card.sessionDuration} h\nFecha de emisión: ${card.creationDate}${card.voucherCode ? `\nCódigo: ${card.voucherCode}` : ''}\n\nTe adjunto el PDF del bono regalo${fileName ? ` (${fileName})` : ''}.`
  );

  const downloadPdfBlob = (pdf: { fileName: string; blob: Blob }) => {
    const downloadUrl = URL.createObjectURL(pdf.blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = downloadUrl;
    downloadLink.download = pdf.fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
  };

  /**
   * Always opens WhatsApp to the buyer's phone (internalContactPhone).
   * Downloads the PDF so it can be attached in that chat (wa.me cannot attach files by URL).
   * On supporting mobile browsers, also offers the system share sheet with the PDF attached.
   */
  const sharePdfViaWhatsApp = async (
    pdf: { fileName: string; blob: Blob },
    card: GiftCardData,
    buyerPhone: string
  ): Promise<'shared-to-buyer' | 'opened-buyer-chat' | 'aborted'> => {
    const message = buildWhatsAppMessage(card, pdf.fileName);
    const buyerChatUrl = `https://wa.me/${buyerPhone}?text=${encodeURIComponent(message)}`;
    const pdfFile = new File([pdf.blob], pdf.fileName, { type: 'application/pdf' });
    const canShareFile = typeof navigator.share === 'function'
      && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [pdfFile] }));

    // Always download so the PDF is available to attach in the buyer's chat.
    downloadPdfBlob(pdf);

    // Mobile: share sheet with PDF attached. Text includes buyer so the right chat is chosen.
    if (canShareFile) {
      try {
        await navigator.share({
          title: `Bono regalo Casa Rosier → ${card.buyerName || 'comprador'}`,
          text: `${message}\n\nDestino: comprador ${card.buyerName || ''} (WhatsApp +${buyerPhone})`,
          files: [pdfFile]
        });
        return 'shared-to-buyer';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // User dismissed share; still open the buyer's chat.
          openWhatsAppExternally(buyerChatUrl);
          return 'aborted';
        }
        console.warn('No se pudo compartir el PDF con archivos:', error);
      }
    }

    // Desktop / fallback: open the buyer's WhatsApp chat directly.
    openWhatsAppExternally(buyerChatUrl);
    return 'opened-buyer-chat';
  };

  const generateGiftCardPdf = async (): Promise<{
    fileName: string;
    blob: Blob;
    voucherCode: string;
    cardSnapshot: GiftCardData;
  }> => {
    const creationDate = todayEs();
    const voucherCode = generateVoucherCode(data.donorName, data.recipientName, creationDate);
    const cardSnapshot: GiftCardData = { ...data, creationDate, voucherCode };
    flushSync(() => {
      setData(cardSnapshot);
    });
    // Official vector PDF (same lib, fonts and layout as bono-gift-card / the bot API).
    const bytes = await buildGiftCardPdfBytes(cardSnapshot);
    const fileName = getSafeFileName(cardSnapshot.donorName);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    return { fileName, blob, voucherCode, cardSnapshot };
  };

  const handleDownloadPDF = async () => {
    if (isGenerating) return;

    const validationErrors = validateGiftCard(data);
    if (validationErrors.length > 0) {
      setNotice({ type: 'error', message: validationErrors.join(' ') });
      return;
    }

    setIsGenerating(true);
    setNotice(null);

    try {
      const generated = await generateGiftCardPdf();
      setGeneratedPdf({ fileName: generated.fileName, blob: generated.blob });
      downloadPdfBlob(generated);

      const saveResult = await saveCurrentRecord(generated.fileName, generated.voucherCode, generated.cardSnapshot);
      if (saveResult === 'saved') {
        setNotice({ type: 'success', message: `PDF descargado. Código del bono regalo: ${generated.voucherCode}` });
      } else if (saveResult === 'skipped') {
        setNotice({ type: 'warning', message: 'PDF descargado. El historial no está configurado.' });
      } else {
        setNotice({ type: 'warning', message: `PDF descargado con código ${generated.voucherCode}, pero no se pudo guardar en pottery-gym. Queda en el historial de este navegador.` });
      }
    } catch (error) {
      console.error('Error generando PDF:', error);
      const detail = error instanceof Error ? ` (${error.message})` : '';
      setNotice({ type: 'error', message: `Hubo un error al generar el PDF${detail}. Por favor, inténtalo de nuevo.` });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGeneratePdfAndWhatsApp = async () => {
    if (isGenerating) return;

    const phone = normalizeWhatsAppPhone(data.internalContactPhone);
    if (phone.length < 8) {
      setNotice({ type: 'error', message: 'Indica el WhatsApp del comprador para enviar el PDF.' });
      return;
    }

    const validationErrors = validateGiftCard(data);
    if (validationErrors.length > 0) {
      setNotice({ type: 'error', message: validationErrors.join(' ') });
      return;
    }

    setIsGenerating(true);
    setNotice(null);

    try {
      const generated = await generateGiftCardPdf();
      setGeneratedPdf({ fileName: generated.fileName, blob: generated.blob });
      const saveResult = await saveCurrentRecord(generated.fileName, generated.voucherCode, generated.cardSnapshot);

      const shareResult = await sharePdfViaWhatsApp(
        { fileName: generated.fileName, blob: generated.blob },
        generated.cardSnapshot,
        phone
      );

      if (shareResult === 'shared-to-buyer') {
        setNotice({
          type: 'success',
          message: `PDF listo (${generated.voucherCode}). Envíalo por WhatsApp al comprador ${generated.cardSnapshot.buyerName || ''} (+${phone}).`
        });
      } else if (shareResult === 'opened-buyer-chat') {
        setNotice({
          type: 'success',
          message: `Chat del comprador abierto (+${phone}). Adjunta el PDF descargado (${generated.voucherCode}).`
        });
      }
      if (saveResult === 'error') {
        setNotice({ type: 'warning', message: `PDF listo con código ${generated.voucherCode}, pero no se pudo guardar en pottery-gym. Queda en el historial de este navegador.` });
      }
    } catch (error) {
      console.error('Error generando PDF para WhatsApp:', error);
      const detail = error instanceof Error ? ` (${error.message})` : '';
      setNotice({ type: 'error', message: `No se pudo generar el PDF para WhatsApp${detail}.` });
    } finally {
      setIsGenerating(false);
    }
  };

  /** Re-downloads the PDF already made in this session; otherwise creates the bono and downloads it. */
  const handleDownloadClick = async () => {
    if (generatedPdf) {
      downloadPdfBlob(generatedPdf);
      setNotice({ type: 'success', message: `PDF descargado de nuevo (${data.voucherCode || generatedPdf.fileName}). No se ha creado un bono regalo nuevo.` });
      return;
    }
    await handleDownloadPDF();
  };

  const handleWhatsApp = async () => {
    const phone = normalizeWhatsAppPhone(data.internalContactPhone);
    if (phone.length < 8) {
      setNotice({ type: 'error', message: 'Indica el WhatsApp del comprador para enviar el PDF.' });
      return;
    }

    if (!generatedPdf) {
      await handleGeneratePdfAndWhatsApp();
      return;
    }

    const shareResult = await sharePdfViaWhatsApp(generatedPdf, data, phone);
    if (shareResult === 'shared-to-buyer') {
      setNotice({
        type: 'success',
        message: `Envía el PDF al comprador ${data.buyerName || ''} (+${phone}).`
      });
    } else if (shareResult === 'opened-buyer-chat' || shareResult === 'aborted') {
      setNotice({
        type: 'success',
        message: `Chat del comprador abierto (+${phone}). Adjunta el PDF descargado.`
      });
    }
  };

  const openWhatsAppExternally = (url: string, pendingWindow: Window | null = null) => {
    const externalWindow = pendingWindow || window.open(url, '_blank');

    if (!externalWindow) {
      window.location.assign(url);
      return;
    }

    externalWindow.opener = null;
    if (pendingWindow) externalWindow.location.href = url;
  };

  const updateField = <K extends keyof GiftCardData>(field: K, value: GiftCardData[K]) => {
    setData(prev => ({ ...prev, [field]: value }));
  };

  if (isSupabaseConfigured && (authLoading || (session && (sedeLoading || (scopeKey && loadedScope !== scopeKey))))) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#faf9f6] text-stone-700">
        <div className="flex items-center gap-3 text-sm">
          <LoaderCircle size={18} className="animate-spin" />
          Comprobando sesión...
        </div>
      </main>
    );
  }

  if (session && !sedeId && !sedeLoading) return <main className="min-h-screen flex items-center justify-center p-6"><div role="alert"><p>No se pudo verificar un taller autorizado para tu cuenta.</p><button type="button" onClick={handleSignOut}>Cerrar sesión</button></div></main>;

  if (isSupabaseConfigured && !session) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#faf9f6] p-6 text-stone-800">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSignIn();
          }}
          className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-xl shadow-stone-200/50"
        >
          <div className="mb-8 text-center">
            <LockKeyhole className="mx-auto mb-4 text-stone-500" size={28} />
            <h1 className="serif text-3xl">Casa Rosier</h1>
            <p className="mt-2 text-xs uppercase tracking-[0.2em] text-stone-400">Acceso al diseñador</p>
          </div>

          {authError ? (
            <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-xs text-red-700">
              {authError}
            </p>
          ) : null}

          <div className="space-y-4">
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-500">
              Email
              <input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                className="input-field mt-2"
                autoComplete="email"
                required
              />
            </label>
            <label className="block text-xs font-semibold uppercase tracking-wider text-stone-500">
              Contraseña
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                className="input-field mt-2"
                autoComplete="current-password"
                required
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={authBusy}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-stone-800 py-3 text-sm font-semibold uppercase tracking-wider text-white transition hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {authBusy ? <LoaderCircle size={16} className="animate-spin" /> : null}
            {authBusy ? 'Entrando...' : 'Iniciar sesión'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell min-h-screen flex flex-col md:flex-row bg-[#faf9f6]">
      {/* Sidebar Editor - Hidden on Print */}
      <aside className="admin-panel no-print w-full md:w-[460px] bg-slate-50 border-r border-slate-300 p-5 md:p-6 flex flex-col md:h-screen md:sticky md:top-0 md:overflow-y-auto md:z-20 shadow-xl shadow-slate-200">
        <div className="mb-6 border-b border-slate-300 pb-5">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-600">Panel de administración</p>
          <h1 className="mt-1 text-3xl serif font-semibold text-slate-900 tracking-tight">Casa Rosier</h1>
          <p className="mt-1 text-sm text-slate-600">Editor de bonos regalo</p>
        </div>

        {isSupabaseConfigured && session ? (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 text-xs text-slate-700 shadow-sm">
            <span className="truncate">{session.user.email}</span>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="flex shrink-0 items-center gap-1 font-semibold text-slate-700 hover:text-slate-950"
              title="Cerrar sesión"
            >
              <LogOut size={13} />
              Salir
            </button>
          </div>
        ) : null}

        {notice ? (
          <div
            role={notice.type === 'error' ? 'alert' : 'status'}
            className={`mb-5 rounded-lg border p-4 text-sm leading-relaxed ${
              notice.type === 'error'
                ? 'border-red-200 bg-red-50 text-red-800'
                : notice.type === 'warning'
                  ? 'border-amber-200 bg-amber-50 text-amber-900'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
            }`}
          >
            {notice.message}
          </div>
        ) : null}

        <section className="mb-5 rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-[0.16em] text-slate-800">Datos del comprador</h2>
          <div className="mt-4 space-y-3">
            <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
              Nombre del comprador
              <input
                type="text"
                value={data.buyerName}
                onChange={(event) => updateField('buyerName', event.target.value)}
                placeholder="Nombre"
                className="input-field mt-1.5 bg-white"
                maxLength={80}
              />
            </label>
            <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
              WhatsApp del comprador (destino)
              <input
                type="tel"
                value={data.internalContactPhone}
                onChange={(event) => updateField('internalContactPhone', event.target.value)}
                placeholder="Teléfono"
                className="input-field mt-1.5 bg-white"
                inputMode="tel"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
                Nº de clases
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={data.numberOfClasses || ''}
                  onChange={(event) => updateField('numberOfClasses', parseInt(event.target.value) || 0)}
                  className="input-field mt-1.5 bg-white"
                />
              </label>
              <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
                Horas por clase
                <input
                  type="text"
                  inputMode="decimal"
                  value={data.sessionDuration}
                  onChange={(event) => updateField('sessionDuration', event.target.value)}
                  className="input-field mt-1.5 bg-white"
                  maxLength={10}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
                Estado de pago
                <select
                  value={paymentStatus}
                  onChange={(event) => setPaymentStatus(event.target.value === 'paid' ? 'paid' : 'pending')}
                  className="input-field mt-1.5 bg-white"
                >
                  <option value="pending">Pendiente</option>
                  <option value="paid">Pagado</option>
                </select>
              </label>
              <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
                Tipo de clase
                <select
                  value={classType}
                  onChange={(event) => setClassType(event.target.value === 'torno' ? 'torno' : 'modelado')}
                  className="input-field mt-1.5 bg-white"
                >
                  <option value="modelado">Modelado</option>
                  <option value="torno">Torno</option>
                </select>
              </label>
            </div>
            <label className="block text-[9px] font-bold uppercase tracking-widest text-stone-400">
              Alumno destinatario en pottery-gym
              <select
                value={recipientStudentId}
                onChange={(event) => setRecipientStudentId(event.target.value)}
                className="input-field mt-1.5 bg-white"
              >
                <option value="">Crear alumno de bonos de clases con el nombre del destinatario</option>
                {students.map((student) => (
                  <option key={student.id} value={student.id}>
                    {student.name}{student.category === 'temporal' ? ' (bonos de clases)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            El teléfono no aparece en el bono regalo. Se usa para enviar el formulario y el PDF.
          </p>
        </section>

        <button
          type="button"
          onClick={() => setShowHistory(true)}
          className="mb-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white py-3 text-sm font-bold uppercase tracking-wider text-slate-800 shadow-sm transition hover:bg-slate-100"
        >
          <HistoryIcon size={16} />
          Bonos regalo generados
        </button>

        <div className="mb-6 space-y-3 rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="sr-only" htmlFor="template-selector">Aplicar plantilla</label>
            <select
              id="template-selector"
              defaultValue=""
              onChange={(event) => handleApplyTemplate(event.target.value)}
              className="input-field bg-white text-sm"
            >
              <option value="">Aplicar plantilla...</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleSaveTemplate}
              className="flex min-h-12 items-center justify-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-bold uppercase tracking-wider text-slate-700 transition hover:bg-slate-100"
              title="Guardar el contenido actual como plantilla"
            >
              <Save size={14} />
              Guardar
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-slate-600">
            <span className="flex min-w-0 items-center gap-1 truncate">
              <CheckCircle2 size={13} className="shrink-0 text-emerald-600" />
              {draftSavedAt ? `Borrador guardado ${formatTime(draftSavedAt)}` : 'Guardando borrador...'}
            </span>
            <button
              type="button"
              onClick={handleResetDraft}
              className="flex shrink-0 items-center gap-1 font-semibold text-slate-700 transition hover:text-slate-950"
            >
              <RotateCcw size={13} />
              Restaurar
            </button>
          </div>
          {templates.length === 0 ? (
            <p className="text-xs leading-relaxed text-slate-600">Guarda una plantilla para reutilizar estos textos en futuros bonos regalo.</p>
          ) : null}
        </div>

        <div className="flex-grow space-y-5 pb-10">
          {/* SECCIÓN 1: DATOS VARIABLES */}
          <EditorSection
            title="1. Datos del regalo"
            description="Comprador, destinatario y características del bono regalo"
            open={openSections.gift}
            onToggle={() => toggleEditorSection('gift')}
          >
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-1.5">
                  <User size={12} /> Destinatario
                </label>
                 <input type="text" value={data.recipientName} onChange={(e) => updateField('recipientName', e.target.value)} placeholder="Nombre" className="input-field" maxLength={80} />
              </div>
              <div>
                <label className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-1.5">
                  <Users size={12} /> De parte de
                </label>
                 <input type="text" value={data.donorName} onChange={(e) => updateField('donorName', e.target.value)} placeholder="Nombre" className="input-field" maxLength={80} />
              </div>
              <div>
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-stone-400">Fecha de emisión</p>
                  <p className="mt-1 text-sm text-stone-700">{data.creationDate}</p>
                  <p className="mt-1 text-[10px] text-stone-400">Generada automáticamente al crear el bono regalo.</p>
                </div>
              </div>
            </div>
          </EditorSection>

          {/* ENVÍO: un solo bloque, sin capas fijas que tapen los campos en el móvil */}
          <section
            aria-labelledby="send-actions-title"
            className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm"
          >
            <h2 id="send-actions-title" className="text-sm font-bold uppercase tracking-[0.16em] text-slate-800">
              Enviar el bono regalo
            </h2>
            <button
              type="button"
              onClick={() => void handleWhatsApp()}
              disabled={isGenerating}
              className="mt-3 flex min-h-14 w-full items-center justify-center gap-3 rounded-lg bg-[#168f47] px-3 py-4 text-sm font-bold uppercase tracking-wider text-white shadow-sm transition hover:bg-[#11783b] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isGenerating ? <LoaderCircle size={18} className="animate-spin" /> : <MessageCircle size={18} />}
              {isGenerating
                ? 'Generando...'
                : generatedPdf
                  ? 'Volver a enviar por WhatsApp'
                  : 'Crear bono regalo y enviar por WhatsApp'}
            </button>
            <p className="mt-2 text-center text-xs leading-relaxed text-slate-600">
              {generatedPdf
                ? 'Usa el mismo PDF y el mismo código. No crea un bono regalo nuevo.'
                : `Guarda el bono regalo, descarga el PDF y abre el WhatsApp del comprador (${data.internalContactPhone || 'indica su número arriba'}).`}
            </p>
            <button
              type="button"
              onClick={() => void handleDownloadClick()}
              disabled={isGenerating}
              className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white py-3 text-sm font-bold uppercase tracking-wider text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Download size={16} />
              {generatedPdf ? 'Descargar de nuevo el PDF' : 'Crear bono regalo y descargar PDF'}
            </button>


            <p className="mt-3 text-center text-[11px] font-medium uppercase tracking-wider text-slate-500">
              PDF vertical 120 × 190 mm · Recomendado: papel texturizado 250g-300g
            </p>
          </section>

          {/* SECCIÓN 2: TEXTOS CARA FRONTAL */}
          <EditorSection
            title="2. Cara frontal"
            description="Saludo, destinatario y mensaje principal"
            open={openSections.front}
            onToggle={() => toggleEditorSection('front')}
          >
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Título Principal</label>
                <input type="text" value={data.title} onChange={(e) => updateField('title', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Subtítulo 1</label>
                <input type="text" value={data.subtitle} onChange={(e) => updateField('subtitle', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Subtítulo 2</label>
                <input type="text" value={data.subtitle2} onChange={(e) => updateField('subtitle2', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Texto Introducción</label>
                <input type="text" value={data.introText} onChange={(e) => updateField('introText', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Cita / Mensaje Central</label>
                <textarea rows={3} maxLength={500} value={data.mainQuote} onChange={(e) => updateField('mainQuote', e.target.value)} className="input-field py-2 text-xs" />
                <p className="mt-1 text-right text-[10px] text-stone-400">{data.mainQuote.length}/500</p>
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Etiqueta "De parte de"</label>
                <input type="text" value={data.fromLabel} onChange={(e) => updateField('fromLabel', e.target.value)} className="input-field" />
              </div>
            </div>
          </EditorSection>

          {/* SECCIÓN 3: TEXTOS CARA POSTERIOR */}
          <EditorSection
            title="3. Cara posterior"
            description="Instrucciones, validez y detalles de la experiencia"
            open={openSections.back}
            onToggle={() => toggleEditorSection('back')}
          >
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Título Sección</label>
                <input type="text" value={data.experienceTitle} onChange={(e) => updateField('experienceTitle', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Bullet 1 (Línea)</label>
                 <textarea rows={2} maxLength={180} value={data.experienceIntro} onChange={(e) => updateField('experienceIntro', e.target.value)} className="input-field py-2 text-xs" placeholder="Escribe la primera línea" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Bullet 2 (Línea)</label>
                 <textarea rows={2} maxLength={180} value={data.experienceLocation} onChange={(e) => updateField('experienceLocation', e.target.value)} className="input-field py-2 text-xs" placeholder="Escribe la segunda línea" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Bullet 3 (Línea)</label>
                 <textarea rows={2} maxLength={180} value={data.includesDetails} onChange={(e) => updateField('includesDetails', e.target.value)} className="input-field py-2 text-xs" placeholder="Escribe los detalles" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Bullet 4 (Línea)</label>
                 <textarea rows={2} maxLength={180} value={data.experienceBullet4} onChange={(e) => updateField('experienceBullet4', e.target.value)} className="input-field py-2 text-xs" placeholder="Escribe la cuarta línea" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Etiqueta "Incluye"</label>
                <input type="text" value={data.includesLabel} onChange={(e) => updateField('includesLabel', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Texto Validez</label>
                <select
                  value={data.validityText}
                  onChange={(e) => updateField('validityText', e.target.value)}
                 className="input-field"
                >
                  <option value="">Selecciona la validez</option>
                  {VALIDITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                  {data.validityText && !(VALIDITY_OPTIONS as readonly string[]).includes(data.validityText) ? (
                    <option value={data.validityText}>{data.validityText}</option>
                  ) : null}
                </select>
              </div>
            </div>
          </EditorSection>

          {/* SECCIÓN 4: CONTACTO */}
          <EditorSection
            title="4. Contacto y reservas"
            description="Datos visibles de Casa Rosier y reservas"
            open={openSections.contact}
            onToggle={() => toggleEditorSection('contact')}
          >
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Título Contacto</label>
                <input type="text" value={data.contactTitle} onChange={(e) => updateField('contactTitle', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-stone-400 mb-1.5 block">Instrucción Reservas</label>
                <input type="text" value={data.contactSubtitle} onChange={(e) => updateField('contactSubtitle', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-1.5">
                  <Phone size={12} /> WhatsApp/Tel
                </label>
                <input type="text" value={data.phone} onChange={(e) => updateField('phone', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-1.5">
                  <Mail size={12} /> Email
                </label>
                <input type="text" value={data.email} onChange={(e) => updateField('email', e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-stone-400 mb-1.5">
                  <Globe size={12} /> Web
                </label>
                <input type="text" maxLength={120} value={data.website} onChange={(e) => updateField('website', e.target.value)} className="input-field" />
              </div>
            </div>
          </EditorSection>
        </div>

      </aside>

      {/* Preview Area */}
      <main className="flex-grow p-4 md:p-16 flex flex-col items-center gap-16 overflow-y-auto print:p-0 print:m-0 print:bg-white print:overflow-visible print:h-auto bg-[#f4f2ee]">
        <div className="print-root w-full max-w-[480px] space-y-12 print:space-y-0">
          <div className="print-page space-y-6 print:space-y-0">
            <h2 className="no-print text-[10px] uppercase tracking-[0.4em] text-stone-400 text-center font-bold">Cara Anterior (Frontal)</h2>
            <ScaledCard>
              <div className="print-container shadow-2xl shadow-stone-200/50 print:shadow-none">
                <GiftCardSide side={1} data={data} />
              </div>
            </ScaledCard>
          </div>

          <div className="print-page space-y-6 print:space-y-0">
            <h2 className="no-print text-[10px] uppercase tracking-[0.4em] text-stone-400 text-center font-bold">Cara Posterior (Detalles)</h2>
            <ScaledCard>
              <div className="print-container shadow-2xl shadow-stone-200/50 print:shadow-none">
                <GiftCardSide side={2} data={data} />
              </div>
            </ScaledCard>
          </div>
        </div>
      </main>

      {showHistory ? (
        <div className="no-print fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
            className="w-full max-w-2xl max-h-[85vh] overflow-hidden bg-white rounded-xl shadow-2xl border border-stone-200 flex flex-col"
          >
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
              <p id="history-title" className="text-[12px] font-bold uppercase tracking-[0.2em] text-stone-600">Bonos generados</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleRefreshHistory()}
                  disabled={historyLoading}
                  className="flex items-center gap-1 text-[11px] px-3 py-1.5 border border-stone-300 rounded hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={12} className={historyLoading ? 'animate-spin' : ''} />
                  Actualizar
                </button>
                <button
                  type="button"
                  onClick={() => setShowHistory(false)}
                  className="text-[11px] px-3 py-1.5 border border-stone-300 rounded hover:bg-stone-100"
                >
                  Cerrar
                </button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto space-y-2">
              {historyError ? (
                <p role="alert" className="text-[12px] text-red-700">{historyError}</p>
              ) : historyLoading ? (
                <p className="text-[12px] text-stone-500">Cargando historial...</p>
              ) : history.length === 0 ? (
                <p className="text-[12px] text-stone-500">Aún no hay bonos regalo guardados.</p>
              ) : (
                <>
                  <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                    <label className="sr-only" htmlFor="history-search">Buscar bono regalo</label>
                    <input
                      id="history-search"
                      type="search"
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.target.value)}
                      placeholder="Buscar por nombre o código"
                      className="input-field text-xs"
                    />
                    <label className="sr-only" htmlFor="history-status">Filtrar por estado</label>
                    <select
                      id="history-status"
                      value={historyStatus}
                      onChange={(event) => setHistoryStatus(event.target.value as 'all' | GiftCardStatus)}
                      className="input-field text-xs sm:w-36"
                    >
                      <option value="all">Todos</option>
                      {Object.entries(statusLabels).map(([status, label]) => (
                        <option key={status} value={status}>{label}</option>
                      ))}
                    </select>
                  </div>

                  {filteredHistory.length === 0 ? (
                    <p className="text-[12px] text-stone-500">No hay registros que coincidan con el filtro.</p>
                  ) : filteredHistory.map((record) => (
                  <div key={record.id} className="bg-stone-50 border border-stone-200 rounded-md p-3 space-y-2">
                    <p className="text-[12px] font-semibold text-stone-700 break-all">{record.fileName}</p>
                    <p className="text-[11px] text-stone-500">
                      {formatDateTime(record.createdAt)}
                    </p>
                    <p className="text-[11px] text-stone-500">
                      Código: <span className="font-semibold text-stone-700">{record.voucherCode || 'Sin código'}</span>
                    </p>
                    <label className="flex items-center gap-2 text-[11px] text-stone-500">
                      Estado
                      <select
                        value={record.status}
                        onChange={(event) => void handleStatusChange(record.id, event.target.value as GiftCardStatus)}
                        className="rounded border border-stone-300 bg-white px-2 py-1 text-[11px] text-stone-700"
                      >
                        {Object.entries(statusLabels).map(([status, label]) => (
                          <option key={status} value={status}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedRecordId((prev) => (prev === record.id ? null : record.id))}
                        className="text-[11px] px-3 py-1.5 border border-stone-300 rounded hover:bg-stone-100"
                      >
                        {expandedRecordId === record.id ? 'Ocultar detalle' : 'Ver detalle'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteRecord(record.id)}
                        className="text-[11px] px-3 py-1.5 border border-stone-300 rounded hover:bg-stone-100"
                      >
                        Eliminar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleLoadRecord(record)}
                        className="text-[11px] px-3 py-1.5 border border-stone-300 rounded hover:bg-stone-100"
                      >
                        Cargar
                      </button>
                    </div>

                    {expandedRecordId === record.id ? (
                      <div className="mt-2 pt-2 border-t border-stone-200 text-[11px] text-stone-700 space-y-1">
                        <p><span className="font-semibold">Estado:</span> {record.status}</p>
                        <p><span className="font-semibold">Comprador:</span> {record.data.buyerName || '-'}</p>
                        <p><span className="font-semibold">Destinatario:</span> {record.data.recipientName || '-'}</p>
                        <p><span className="font-semibold">De parte de:</span> {record.data.donorName || '-'}</p>
                        <p><span className="font-semibold">Clases:</span> {record.data.numberOfClasses || '-'}</p>
                        <p><span className="font-semibold">Horas:</span> {record.data.sessionDuration || '-'}</p>
                        <p><span className="font-semibold">Fecha emisión:</span> {record.data.creationDate || '-'}</p>
                        <p><span className="font-semibold">Subtítulo 1:</span> {record.data.subtitle || '-'}</p>
                        <p><span className="font-semibold">Subtítulo 2:</span> {record.data.subtitle2 || '-'}</p>
                        <p><span className="font-semibold">WhatsApp del comprador:</span> {record.data.internalContactPhone || '-'}</p>
                        <p><span className="font-semibold">pottery-gym:</span> {record.origin === 'server' ? `${record.potteryStatus || '-'} · pago ${record.paymentStatus || '-'}` : 'No guardado (solo en este navegador)'}</p>
                      </div>
                    ) : null}
                  </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// Remount all sensitive state on account changes. Late promises from the old
// instance cannot repopulate the new account's editor, history or PDF.
const DesignerIdentityBoundary: React.FC = () => {
  const [actor, setActor] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true, revision = 0;
    const start = revision;
    void supabase.auth.getSession().then(({data}) => {if(active && revision === start) setActor(data.session?.user.id ?? null);}).catch(() => {if(active && revision === start) setActor(null);});
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event, next) => {revision++; if(active) setActor(next?.user.id ?? null);});
    return () => {active=false; subscription.unsubscribe();};
  }, []);
  if (actor === undefined) return <main role="status" className="min-h-screen flex items-center justify-center">Comprobando sesión…</main>;
  return <AdminApp key={actor || 'anonymous'} />;
};
export default DesignerIdentityBoundary;



