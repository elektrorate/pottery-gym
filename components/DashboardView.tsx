
import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { Student, ClassSession, AppView, GiftCard, WorkshopCapacityDefault, WorkshopScheduleDay, WorkshopScheduleException } from '../types';
import { showError } from '../context/toast';
import { getStudentLifecycle, getStudentPaymentStatus, isStudentArchived } from '../utils/studentLifecycle';
import { useWorkshopDate } from '../utils/useWorkshopDate';
import DiagonalPattern from './shared/DiagonalPattern';
import { capacityDefaultsToMap, getSessionOccupancy, sessionAvailabilityLabel } from '../utils/sessionCapacity';
import { getScheduleConflictReason } from '../utils/workshopSchedule';


interface DashboardViewProps {
  students: Student[];
  sessions: ClassSession[];
  giftCards: GiftCard[];
  onUpdateStudent: (id: string, updates: Partial<Student>) => Promise<void>;
  onUpdateSession: (id: string, updates: Partial<ClassSession>) => Promise<void>;
  onRedeemGiftCardSession: (giftCardId: string, sessionId: string, studentId?: string) => Promise<void>;
  onReverseGiftCardSession: (giftCardId: string | undefined, sessionId: string, studentId?: string) => Promise<boolean | void>;
  onNavigate: (view: AppView) => void;
  onOpenStudentProfile: (studentId: string) => void;
  capacityDefaults?: WorkshopCapacityDefault[];
  workshopSchedule?: WorkshopScheduleDay[];
  workshopScheduleExceptions?: WorkshopScheduleException[];
}

type DashboardAlert = { id: string; name: string; reason: string; type: 'warning' | 'info' | 'critical'; category: 'bonuses' | 'payment' | 'expiry' };

const AlertItem: React.FC<{ alert: DashboardAlert; onOpenStudentProfile: (studentId: string) => void }> = ({ alert, onOpenStudentProfile }) => {
  const palette = alert.type === 'critical'
    ? { card: 'bg-[#F8E1DA] border-[#EFC9BE]', icon: 'bg-[#9E3B2B] text-white', text: 'text-[#9E3B2B]', symbol: '!' }
    : { card: 'bg-[#FBEAD2] border-[#EBD5AC]', icon: 'bg-[#916438] text-white', text: 'text-[#8A5517]', symbol: '•' };
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${palette.card}`}>
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${palette.icon}`}>{palette.symbol}</div>
       <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold text-neutral-textMain">{alert.name}</p><p className={`truncate text-[12px] font-medium ${palette.text}`}>{alert.reason}</p></div>
       {alert.id && <button type="button" onClick={() => onOpenStudentProfile(alert.id)} className="min-h-[36px] shrink-0 rounded-lg bg-white/70 px-2.5 text-[12px] font-semibold text-neutral-textMain transition-colors hover:bg-white hover:text-brand">Ver ficha</button>}
    </div>
  );
};

const AlertGroup: React.FC<{
  title: string;
  alerts: DashboardAlert[];
  tone: 'danger' | 'warning';
  emptyLabel: string;
  onOpenStudentProfile: (studentId: string) => void;
}> = ({ title, alerts, tone, emptyLabel, onOpenStudentProfile }) => {
  const colors = tone === 'danger'
    ? { border: 'border-[#EFC9BE]', background: 'bg-[#FFF8F5]', text: 'text-[#9E3B2B]', badge: 'bg-[#F8E1DA]' }
    : { border: 'border-[#EBD5AC]', background: 'bg-[#FFFBF3]', text: 'text-[#8A5517]', badge: 'bg-[#FBEAD2]' };
  return (
    <div className={`rounded-xl border p-3 ${colors.border} ${colors.background}`}>
      <div className="mb-2 flex items-center justify-between gap-2"><p className={`text-[11px] font-bold uppercase tracking-[0.14em] ${colors.text}`}>{title}</p><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${colors.badge} ${colors.text}`}>{alerts.length}</span></div>
      {alerts.length > 0 ? <div className="space-y-2">{alerts.map((alert, idx) => <AlertItem key={`${alert.id}-${idx}`} alert={alert} onOpenStudentProfile={onOpenStudentProfile} />)}</div> : <p className="rounded-lg bg-white/70 px-3 py-3 text-[12px] text-neutral-textHelper">{emptyLabel}</p>}
    </div>
  );
};

const DashboardView: React.FC<DashboardViewProps> = ({ students, sessions, giftCards, onUpdateStudent, onUpdateSession, onRedeemGiftCardSession, onReverseGiftCardSession, onNavigate, onOpenStudentProfile, capacityDefaults = [], workshopSchedule = [], workshopScheduleExceptions = [] }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const alertAudioContextRef = useRef<AudioContext | null>(null);
  const previousAlertKeysRef = useRef<Set<string> | null>(null);

  // BUG 1 FIX: Local attendance state + debounce to prevent race conditions
  const [localAttendance, setLocalAttendance] = useState<Record<string, Record<string, 'present' | 'absent' | undefined>>>({});
  const debounceTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingUpdatesRef = useRef<Record<string, Record<string, 'present' | 'absent' | undefined>>>({});

  const capacityMap = useMemo(() => capacityDefaultsToMap(capacityDefaults), [capacityDefaults]);

  const getSessionTypeLabel = (type: ClassSession['classType']) => {
    const map: Record<ClassSession['classType'], string> = {
      mesa: 'Mesa de Trabajo',
      torno: 'Clase de Torno',
      coworking: 'Coworking',
      workshop: 'Workshop',
      privada: 'Privadas',
      feriado: 'Feriados'
    };
    return map[type] || 'Sesion';
  };

  const todayStr = useWorkshopDate();

  // ─── TODAY's data ───
  const todaySessions = useMemo(() =>
    sessions.filter(s => s.date === todayStr).sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [sessions, todayStr]);

  const uniqueStudentsToday = useMemo(() => {
    const names = new Set<string>();
    todaySessions.forEach(s => s.students.forEach(st => names.add(st.toUpperCase())));
    return Array.from(names);
  }, [todaySessions]);

  // ─── GLOBAL stats ───
  const globalStats = useMemo(() => {
    const totalStudents = students.length;
     const activeStudents = students.filter(s => getStudentLifecycle(s, todayStr) === 'active').length;
     const pendingStudents = students.filter(s => getStudentLifecycle(s, todayStr) === 'pending').length;
     const totalSessions = sessions.length;

    // Students by category
    const byCategory: Record<string, number> = { membresia: 0, temporal: 0 };
    students.forEach(s => {
      const cat = s.studentCategory || 'membresia';
        if (byCategory[cat] !== undefined && !isStudentArchived(s, todayStr)) byCategory[cat]++;
    });

     return { totalStudents, activeStudents, pendingStudents, totalSessions, byCategory };
    }, [students, sessions, todayStr]);

  // ─── TODAY stats ───
  const todayStats = useMemo(() => {
    let totalSpots = 0;
    let occupiedSpots = 0;
    let tornosTotales = 0;
    let tornosOcupados = 0;
    let mesasTotales = 0;
    let mesasOcupadas = 0;

     todaySessions.forEach(s => {
       if (s.classType === 'feriado') return;
       const occupancy = getSessionOccupancy(s, capacityMap);
       totalSpots += occupancy.capacity;
       occupiedSpots += occupancy.enrolled;
       if (s.classType === 'torno') { tornosTotales += occupancy.capacity; tornosOcupados += occupancy.enrolled; }
       else { mesasTotales += occupancy.capacity; mesasOcupadas += occupancy.enrolled; }
    });

    return {
      occTornos: tornosTotales > 0 ? Math.round((tornosOcupados / tornosTotales) * 100) : 0,
      mesasLibres: mesasTotales - mesasOcupadas,
      totalAlumnos: uniqueStudentsToday.length,
      totalSessions: todaySessions.length,
      globalOccupancy: totalSpots > 0 ? Math.round((occupiedSpots / totalSpots) * 100) : 0
    };
  }, [capacityMap, todaySessions, uniqueStudentsToday]);

  // ─── Alerts ───
  const alerts = useMemo(() => {
    const list: DashboardAlert[] = [];
    // Keep expiration and payment as separate causes so the dashboard is actionable.
    students.forEach(student => {
      if (isStudentArchived(student, todayStr)) return;
      const fullName = `${student.name} ${student.surname || ''}`.trim();
      const isMembership = (student.studentCategory || 'membresia') === 'membresia';
      const isExpired = Boolean(student.expiryDate && student.expiryDate < todayStr);
      const isPaymentPending = isMembership
        && getStudentPaymentStatus(student) === 'pending'
        && !isExpired;

      if (student.classesRemaining <= 1 && student.classesRemaining >= 0) {
        list.push({ id: student.id, name: fullName, reason: `Bono agotándose (${student.classesRemaining} rest.)`, type: 'critical', category: 'bonuses' });
      }
      if (isExpired && isMembership) {
        list.push({ id: student.id, name: fullName, reason: 'Membresía vencida', type: 'critical', category: 'expiry' });
      }
      if (isPaymentPending) {
        list.push({ id: student.id, name: fullName, reason: 'Pago pendiente de membresía', type: 'warning', category: 'payment' });
      }
    });
    return list;
  }, [students, todayStr]);

  const bonusAlerts = useMemo(() => alerts.filter(alert => alert.category === 'bonuses'), [alerts]);
  const paymentAlerts = useMemo(() => alerts.filter(alert => alert.category === 'payment'), [alerts]);
  const expiryAlerts = useMemo(() => alerts.filter(alert => alert.category === 'expiry'), [alerts]);

  const playAlertSound = useCallback(() => {
    if (typeof window === 'undefined') return;
    const AudioContextConstructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    const context = alertAudioContextRef.current || new AudioContextConstructor();
    alertAudioContextRef.current = context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, startAt);
    oscillator.frequency.setValueAtTime(988, startAt + 0.12);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.32);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.32);
    context.resume().catch(() => undefined);
  }, []);

  useEffect(() => {
    const currentKeys = new Set(alerts.map(alert => `${alert.type}:${alert.id}`));
    const previousKeys = previousAlertKeysRef.current;
    const hasNewAlert = previousKeys
      ? Array.from(currentKeys).some(key => !previousKeys.has(key))
      : false;

    if (hasNewAlert && soundEnabled) playAlertSound();
    previousAlertKeysRef.current = currentKeys;
  }, [alerts, soundEnabled, playAlertSound]);

  useEffect(() => () => {
    alertAudioContextRef.current?.close().catch(() => undefined);
  }, []);

  // ─── All students searchable ───
  const filteredStudents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
      return students
      .filter(s => {
        if (isStudentArchived(s)) return false;
        if (!q) return true;
        const fullName = `${s.name} ${s.surname || ''}`.trim().toLowerCase();
        return fullName.includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [students, searchQuery]);

  // Today's student list for attendance - uses localAttendance for immediate UI feedback
  const todayStudentList = useMemo(() => {
    const list: { name: string; time: string; type: string; status?: string; sessionId: string }[] = [];
    todaySessions.forEach(s => {
      s.students.forEach(st => {
        // BUG 1 FIX: Prefer local state for immediate feedback, fallback to session state
        const currentAtt = localAttendance[s.id] ?? s.attendance;
        list.push({ name: st, time: s.startTime, type: s.classType, status: currentAtt?.[st] || 'pending', sessionId: s.id });
      });
    });
    return list;
  }, [todaySessions, localAttendance]);

  // BUG 1 FIX: Debounced attendance handler - accumulates clicks for 2 seconds before sending
  const handleAttendance = useCallback((session: ClassSession, studentName: string, status: 'present' | 'absent') => {
    const sessionId = session.id;

    // Get current attendance (merge session data with local pending changes)
    const baseAtt = session.attendance || {};
    const pendingAtt = pendingUpdatesRef.current[sessionId] || {};
    const currentAtt = { ...baseAtt, ...pendingAtt };

    // Toggle logic
    const newStatus = currentAtt[studentName] === status ? undefined : status;
    const nextAtt = { ...currentAtt };
    if (newStatus) nextAtt[studentName] = newStatus;
    else delete nextAtt[studentName];

    // Store pending update
    pendingUpdatesRef.current[sessionId] = nextAtt;

    // Update local state for immediate UI feedback
    setLocalAttendance(prev => ({ ...prev, [sessionId]: nextAtt }));

    // Clear existing timer for this session
    if (debounceTimerRef.current[sessionId]) {
      clearTimeout(debounceTimerRef.current[sessionId]);
    }

    // Set new debounce timer (2 seconds)
    debounceTimerRef.current[sessionId] = setTimeout(async () => {
      const finalAtt = pendingUpdatesRef.current[sessionId];
      if (finalAtt) {
        try {
          const baseAttendance = session.attendance || {};
          const changedNames = new Set([...Object.keys(baseAttendance), ...Object.keys(finalAtt)]);
          for (const name of changedNames) {
            const nextStatus = finalAtt[name];
            const wasPresent = baseAttendance[name] === 'present';
            const isPresent = nextStatus === 'present';
            if (wasPresent === isPresent) continue;

            const student = students.find(item => {
              const fullName = `${item.name} ${item.surname || ''}`.trim().toUpperCase();
              return fullName === name.toUpperCase() || item.name.toUpperCase() === name.toUpperCase();
            });
            if (!student) continue;

            const linkedGiftCardId = session.giftCardIdByStudentId?.[student.id];
            const giftCardId = linkedGiftCardId || giftCards.find(card =>
              card.recipientStudentId === student.id
              && card.status === 'active'
              && (card.sessionsRemaining || 0) > 0
            )?.id;

            if (wasPresent && !isPresent) {
              const reversed = await onReverseGiftCardSession(giftCardId, sessionId, student.id);
              if (reversed) continue;
            } else if (!wasPresent && isPresent && giftCardId) {
              await onRedeemGiftCardSession(giftCardId, sessionId, student.id);
              continue;
            }

            const maxBonuses = student.bonosAsignados ?? 4;
            const nextClassesRemaining = isPresent
              ? Math.max(0, student.classesRemaining - 1)
              : Math.min(maxBonuses, student.classesRemaining + 1);
            await onUpdateStudent(student.id, {
              classesRemaining: nextClassesRemaining
            });
          }

          await onUpdateSession(sessionId, { attendance: finalAtt });
          delete pendingUpdatesRef.current[sessionId];
          delete debounceTimerRef.current[sessionId];
        } catch (error: any) {
          showError(`No se pudo guardar la asistencia. ${error?.message || 'Intenta de nuevo.'}`);
        }
      }
    }, 2000);
  }, [giftCards, onRedeemGiftCardSession, onReverseGiftCardSession, onUpdateSession, onUpdateStudent, students]);

  const CATEGORY_LABELS: Record<string, string> = { membresia: 'Membresía', temporal: 'Temporal' };
  const CATEGORY_COLORS: Record<string, string> = { membresia: 'bg-brand', temporal: 'bg-caramelo' };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-base animate-fade-in">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-24 pt-3 custom-scrollbar md:px-6 md:py-4">

        <section className="relative mb-5 overflow-hidden rounded-[22px] border border-brand/20 bg-brand-soft px-5 py-5 md:px-7 md:py-6">
          <DiagonalPattern />
          <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="eyebrow text-brand">Resumen operativo</p>
              <h3 className="ui-page-title mt-2 text-neutral-textMain">El taller, en movimiento.</h3>
              <p className="ui-secondary mt-1.5 max-w-xl">Una lectura rápida de tus clases, alumnos y pendientes para tomar decisiones sin ruido.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-xl bg-white/70 px-3 py-2 text-[11px] font-semibold text-neutral-textSec">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Operación activa
            </div>
          </div>
        </section>

        {/* ─── GLOBAL STATS ROW ─── */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-5">
           <div className="group flex min-h-[6.5rem] cursor-pointer flex-col justify-between rounded-[18px] border border-neutral-border border-l-4 border-l-brand bg-white p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-soft md:p-4"
             onClick={() => onNavigate(AppView.STUDENTS)}
             style={{ cursor: 'pointer' }}>
             <p className="eyebrow">Activos de membresía</p>
              <span className="ui-kpi text-[#20663B]">{globalStats.activeStudents}</span>
           </div>
             <div className="flex min-h-[6.5rem] flex-col justify-between rounded-[18px] border border-neutral-border border-l-4 border-l-[#C98A53] bg-white p-3.5 md:p-4">
             <p className="eyebrow">Pendientes de pago</p>
               <span className={`ui-kpi ${globalStats.pendingStudents > 0 ? 'text-[#9E3B2B]' : 'text-[#20663B]'}`}>{globalStats.pendingStudents}</span>
            </div>
            <div className="flex min-h-[6.5rem] flex-col justify-between rounded-[18px] border border-neutral-border border-l-4 border-l-[#9E3B2B] bg-white p-3.5 md:p-4">
             <p className="eyebrow">Bonos agotándose</p>
               <span className={`ui-kpi ${bonusAlerts.length > 0 ? 'text-[#9E3B2B]' : 'text-[#20663B]'}`}>{bonusAlerts.length}</span>
            </div>
           {/* Today's metrics */}
            <div className="flex min-h-[6.5rem] flex-col justify-between rounded-[18px] border border-neutral-border bg-white p-3.5 md:p-4">
             <p className="eyebrow">Alumnos Hoy</p>
               <span className="ui-kpi text-neutral-textMain">{todayStats.totalAlumnos}</span>
            </div>
            <div className="flex min-h-[6.5rem] flex-col justify-between rounded-[18px] border border-neutral-border bg-white p-3.5 md:p-4">
             <p className="eyebrow">Sesiones Hoy</p>
               <span className="ui-kpi text-neutral-textMain">{todayStats.totalSessions}</span>
           </div>
        </div>

        {/* ─── STUDENT CATEGORIES ROW ─── */}
        {globalStats.totalStudents > 0 && (
           <div className="mb-4 flex flex-wrap gap-2">
            {Object.entries(globalStats.byCategory).filter(([, count]) => (count as number) > 0).map(([cat, count]) => (
              <div key={cat} className="flex items-center gap-2 rounded-full border border-neutral-border bg-white px-2.5 py-1">
                <div className={`w-2.5 h-2.5 rounded-full ${CATEGORY_COLORS[cat] || 'bg-neutral-border'}`}></div>
                <span className="text-[11px] font-semibold text-neutral-textMain">{CATEGORY_LABELS[cat] || cat}</span>
                <span className="text-[11px] font-semibold text-neutral-textHelper">{count}</span>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8">

          {/* ─── TODAY TIMELINE (Left Column) ─── */}
          <div className="lg:col-span-12 space-y-5">
           <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-6 bg-brand rounded-full"></div>
                <h4 className="text-[16px] font-bold text-neutral-textMain">Agenda de Hoy</h4>
              </div>
               <button onClick={() => onNavigate(AppView.CALENDAR)} className="min-h-[36px] px-2 text-[12px] font-semibold text-brand hover:text-brand-hover transition-colors">
                Ver Calendario Completo
              </button>
            </div>

            <div className="space-y-3">
              {todaySessions.length === 0 ? (
                <div className="bg-white/60 border border-dashed border-neutral-border p-8 md:p-10 rounded-2xl text-center">
                  <p className="text-neutral-textHelper text-[13px]">No hay sesiones programadas para hoy</p>
                  <button onClick={() => onNavigate(AppView.CALENDAR)} className="mt-4 min-h-[44px] px-4 py-2.5 bg-brand text-white text-[14px] font-semibold rounded-[10px] hover:bg-brand-hover transition-all">
                    Crear Sesión
                  </button>
                </div>
              ) : (
                 todaySessions.map(session => {
                   const occupancy = getSessionOccupancy(session, capacityMap);
                   const conflict = getScheduleConflictReason(session, workshopSchedule, workshopScheduleExceptions);
                   const isFull = occupancy.availability === 'full' || occupancy.availability === 'over_capacity';
                   return (
                     <div key={session.id} className="group flex items-center justify-between rounded-[18px] border border-neutral-border bg-white p-3.5 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-soft md:p-4">
                      <div className="flex items-center gap-3 md:gap-5">
                        <div className="min-w-[50px] text-center">
                           <p className="ui-card-title text-neutral-textMain">{session.startTime}</p>
                           <p className="ui-meta mt-1 font-semibold tracking-wide">Inicio</p>
                        </div>
                        <div className="h-8 w-[1px] bg-neutral-border"></div>
                        <div>
                           <p className="ui-card-title text-neutral-textMain">{getSessionTypeLabel(session.classType)}</p>
                           <div className="mt-1 flex flex-wrap items-center gap-2">
                              {session.classType === 'feriado' ? <span className="ui-meta font-semibold text-neutral-textHelper">Día bloqueado</span> : <span className={`ui-meta font-semibold ${isFull ? 'text-[#9E3B2B]' : 'text-[#20663B]'}`}>
                               {occupancy.enrolled}/{occupancy.capacity} {sessionAvailabilityLabel[occupancy.availability]}
                             </span>}
                             {conflict && <span className="ui-meta font-semibold text-[#916438]">Conflicto de horario</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <div className="flex -space-x-2">
                          {session.students.slice(0, 3).map((st, i) => (
                              <div key={i} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-neutral-sec text-[10px] font-semibold text-neutral-textSec">
                              {st.charAt(0)}
                            </div>
                          ))}
                          {session.students.length > 3 && (
                              <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-brand-soft text-[10px] font-semibold text-brand">
                              +{session.students.length - 3}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

          </div>

          {/* ─── ALERTS ─── */}
          <section className="mt-1 rounded-2xl border border-neutral-border bg-[#FBF7F2] p-4 md:p-5 lg:col-span-12">
                <div className="flex items-center justify-between gap-3 px-1">
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-6 bg-caramelo rounded-full"></div>
                    <h4 className="text-[15px] font-bold text-neutral-textMain">Alertas</h4>
                    <span className="text-[12px] font-semibold text-neutral-textHelper">({alerts.length})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!soundEnabled) playAlertSound();
                      setSoundEnabled(enabled => !enabled);
                    }}
                    aria-pressed={soundEnabled}
                    className={`min-h-[36px] px-2.5 rounded-[9px] border text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors ${soundEnabled ? 'bg-[#DFF0E4] text-[#20663B] border-[#BFDECB]' : 'bg-white text-neutral-textHelper border-neutral-border hover:border-arena hover:text-brand'}`}
                    title={soundEnabled ? 'Desactivar sonido de alertas' : 'Activar sonido de alertas'}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={soundEnabled ? 'M11 5L6 9H3v6h3l5 4V5zm5.5 3.5a5 5 0 010 7M19 5a9 9 0 010 14' : 'M11 5L6 9H3v6h3l5 4V5zm5 7H22'} /></svg>
                    <span className="hidden sm:inline">{soundEnabled ? 'Sonido activo' : 'Activar sonido'}</span>
                  </button>
                </div>
                 <div className="grid gap-3 md:grid-cols-3">
                   <AlertGroup title="Bonos agotándose" alerts={bonusAlerts} tone="danger" emptyLabel="No hay bonos próximos a agotarse." onOpenStudentProfile={onOpenStudentProfile} />
                   <AlertGroup title="Pagos pendientes" alerts={paymentAlerts} tone="warning" emptyLabel="No hay pagos pendientes." onOpenStudentProfile={onOpenStudentProfile} />
                   <AlertGroup title="Membresías vencidas" alerts={expiryAlerts} tone="danger" emptyLabel="No hay membresías vencidas." onOpenStudentProfile={onOpenStudentProfile} />
                 </div>
              </section>

      </div>
    </div>
    </div>
  );
};

export default DashboardView;
