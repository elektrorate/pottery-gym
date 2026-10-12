
import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { Student, ClassSession, AppView, GiftCard, ClassAdjustmentIntent, WorkshopCapacityDefault, WorkshopScheduleDay, WorkshopScheduleException } from '../types';
import { getStudentLifecycle, getPendingMembershipPayments, isStudentArchived } from '../utils/studentLifecycle';
import { useWorkshopDate } from '../utils/useWorkshopDate';
import DiagonalPattern from './shared/DiagonalPattern';
import { capacityDefaultsToMap, getSessionOccupancy, sessionAvailabilityLabel } from '../utils/sessionCapacity';
import { getScheduleConflictReason } from '../utils/workshopSchedule';


interface DashboardViewProps {
  students: Student[];
  sessions: ClassSession[];
  giftCards: GiftCard[];
  onAdjustClasses?: (intent: ClassAdjustmentIntent) => Promise<void>;
  onUpdateStudent?: (id: string, updates: Partial<Student>) => Promise<void>;
  onUpdateSession?: (id: string, updates: Partial<ClassSession>) => Promise<void>;
  onRedeemGiftCardSession?: (giftCardId: string, sessionId: string, studentId?: string) => Promise<void>;
  onReverseGiftCardSession?: (giftCardId: string | undefined, sessionId: string, studentId?: string) => Promise<boolean | void>;
  onNavigate: (view: AppView) => void;
  onOpenStudentProfile: (studentId: string) => void;
  onOpenSession?: (sessionId: string, date: string) => void;
  capacityDefaults?: WorkshopCapacityDefault[];
  workshopSchedule?: WorkshopScheduleDay[];
  workshopScheduleExceptions?: WorkshopScheduleException[];
}

type DashboardAlert = { key?: string; id: string; name: string; reason: string; type: 'warning' | 'info' | 'critical'; category: 'bonuses' | 'payment' | 'expiry' };
type WorkshopActivity = { id: string; title: string; date: string; time: string; description: string };

const MetricIcon: React.FC<{ type: 'members' | 'payments' | 'bonuses' | 'students' | 'sessions' }> = ({ type }) => {
  const paths = {
    members: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0',
    payments: 'M4 7h16M4 12h10M4 17h7',
    bonuses: 'M12 3l2.6 5.3L20 9l-4 4 .9 5.7-4.9-2.6-4.9 2.6.9-5.7-4-4 5.4-.7L12 3z',
    students: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm7-1a3 3 0 100-6m4 17v-2a4 4 0 00-3-3.9',
    sessions: 'M4 5h16v14H4zM8 3v4m8-4v4M4 10h16'
  } as const;
  return <svg aria-hidden="true" className="h-4 w-4 text-neutral-textHelper md:h-5 md:w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d={paths[type]} /></svg>;
};

const AlertItem: React.FC<{ alert: DashboardAlert; onOpenStudentProfile: (studentId: string) => void }> = ({ alert, onOpenStudentProfile }) => {
  const palette = alert.type === 'critical'
    ? { card: 'bg-[#F8E1DA] border-[#EFC9BE]', icon: 'bg-[#9E3B2B] text-white', text: 'text-[#9E3B2B]', symbol: '!' }
    : { card: 'bg-[#FBEAD2] border-[#EBD5AC]', icon: 'bg-[#916438] text-white', text: 'text-[#8A5517]', symbol: '•' };
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${palette.card}`}>
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${palette.icon}`}>{palette.symbol}</div>
       <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold text-neutral-textMain">{alert.name}</p><p className={`truncate text-[12px] font-medium ${palette.text}`}>{alert.reason}</p></div>
       {alert.id && <button type="button" onClick={() => onOpenStudentProfile(alert.id)} className="min-h-[36px] w-12 shrink-0 rounded-lg bg-white/70 px-1 text-center text-[12px] font-semibold leading-[1.1] text-neutral-textMain transition-colors hover:bg-white hover:text-brand sm:w-auto sm:px-2.5"><span className="sm:hidden">Ver<br />ficha</span><span className="hidden sm:inline">Ver ficha</span></button>}
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
      {alerts.length > 0 ? <div className="space-y-2">{alerts.map((alert, idx) => <AlertItem key={alert.key || `${alert.id}-${alert.category}`} alert={alert} onOpenStudentProfile={onOpenStudentProfile} />)}</div> : <p className="rounded-lg bg-white/70 px-3 py-3 text-[12px] text-neutral-textHelper">{emptyLabel}</p>}
    </div>
  );
};

const DashboardView: React.FC<DashboardViewProps> = ({ students, sessions, onNavigate, onOpenStudentProfile, onOpenSession, capacityDefaults = [], workshopSchedule = [], workshopScheduleExceptions = [] }) => {
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [activities, setActivities] = useState<WorkshopActivity[]>([]);
  const [activityFormOpen, setActivityFormOpen] = useState(false);
  const [activityPendingDelete, setActivityPendingDelete] = useState<WorkshopActivity | null>(null);
  const [activityForm, setActivityForm] = useState({ title: '', date: '', time: '', description: '' });
  const alertAudioContextRef = useRef<AudioContext | null>(null);
  const previousAlertKeysRef = useRef<Set<string> | null>(null);

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

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('taller-workshop-activities');
      if (stored) setActivities(JSON.parse(stored));
    } catch { setActivities([]); }
  }, []);

  const saveActivities = (next: WorkshopActivity[]) => {
    setActivities(next);
    window.localStorage.setItem('taller-workshop-activities', JSON.stringify(next));
  };
  const todayActivities = useMemo(() => activities.filter(activity => activity.date === todayStr).sort((a, b) => a.time.localeCompare(b.time)), [activities, todayStr]);
  const submitActivity = (event: React.FormEvent) => {
    event.preventDefault();
    if (!activityForm.title.trim() || !activityForm.date || !activityForm.time) return;
    saveActivities([...activities, { id: crypto.randomUUID(), title: activityForm.title.trim(), date: activityForm.date, time: activityForm.time, description: activityForm.description.trim() }]);
    setActivityForm({ title: '', date: todayStr, time: '', description: '' });
    setActivityFormOpen(false);
  };

  // ─── TODAY's data ───
  const todaySessions = useMemo(() =>
    sessions.filter(s => s.date === todayStr).sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [sessions, todayStr]);

  const uniqueStudentsToday = useMemo(() => {
    const ids = new Set<string>();
    todaySessions.forEach(s => s.students.forEach((_name, index) => {
      const id = s.studentIds?.[index];
      if (id && s.attendancePolicyVersion === 2 && s.businessStateByStudentId?.[id]?.reservationState === 'cancelled') return;
      ids.add(id || `${s.id}:${index}`);
    }));
    return Array.from(ids);
  }, [todaySessions]);

  // ─── GLOBAL stats ───
  const globalStats = useMemo(() => {
    const totalStudents = students.length;
     const activeStudents = students.filter(s => getStudentLifecycle(s, todayStr) === 'active').length;
     const pendingStudents = students.filter(s => getPendingMembershipPayments(s).length > 0).length;
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
      const fullName = `${student.name} ${student.surname || ''}`.trim();
      const isMembership = (student.studentCategory || 'membresia') === 'membresia';
      const isExpired = Boolean(student.expiryDate && student.expiryDate < todayStr);
      getPendingMembershipPayments(student).forEach(period => list.push({
        id: student.id, key: `${student.id}:${period.id}:payment`, name: fullName,
        reason: `Pago pendiente · ${period.startsOn || 'Sin inicio'} — ${period.endsOn || 'Sin vencimiento'}`,
        type: 'warning', category: 'payment'
      }));
      if (isStudentArchived(student, todayStr)) return;

      if (student.classesRemaining <= 1 && student.classesRemaining >= 0) {
        list.push({ id: student.id, key: `${student.id}:${student.effectivePeriodId || 'legacy'}:bonuses`, name: fullName, reason: `Bono agotándose (${student.classesRemaining} rest.)`, type: 'critical', category: 'bonuses' });
      }
      if (isExpired && isMembership) {
        list.push({ id: student.id, key: `${student.id}:${student.effectivePeriodId || 'legacy'}:expiry`, name: fullName, reason: `Membresía vencida · ${student.expiryDate}`,  type: 'critical', category: 'expiry' });
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
    const currentKeys = new Set(alerts.map(alert => alert.key || `${alert.id}:${alert.category}`));
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

  const CATEGORY_LABELS: Record<string, string> = { membresia: 'Membresía', temporal: 'Temporal' };
  const CATEGORY_COLORS: Record<string, string> = { membresia: 'bg-brand', temporal: 'bg-caramelo' };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-base animate-fade-in">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-24 pt-3 custom-scrollbar md:px-6 md:py-4">

        <section className="relative mb-5 overflow-hidden rounded-[30px] border border-neutral-border bg-white px-5 py-5 md:px-7 md:py-6">
          <DiagonalPattern />
          <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="eyebrow text-brand">Resumen operativo</p>
              <h3 className="ui-page-title mt-2 text-neutral-textMain">El taller, en movimiento.</h3>
              <p className="ui-secondary mt-1.5 max-w-xl">Una lectura rápida de tus clases, alumnos y pendientes para tomar decisiones sin ruido.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-full bg-neutral-soft px-3 py-2 text-[11px] font-semibold text-neutral-textSec">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Operación activa
            </div>
          </div>
        </section>

        {/* ─── GLOBAL STATS ROW ─── */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-5">
           <div className="group relative flex min-h-[7rem] cursor-pointer flex-col justify-between rounded-[22px] border-0 bg-white p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-soft md:min-h-[8rem] md:rounded-[26px] md:p-4"
             onClick={() => onNavigate(AppView.STUDENTS)}
             style={{ cursor: 'pointer' }}>
             <span className="absolute right-3.5 top-3.5 md:right-4 md:top-4"><MetricIcon type="members" /></span>
             <p className="text-[11px] font-semibold uppercase leading-tight tracking-[0.12em] text-neutral-textSec">Activos de membresía</p>
              <span className="text-[2rem] font-semibold leading-none text-neutral-textMain">{globalStats.activeStudents}</span>
           </div>
             <div className="relative flex min-h-[7rem] flex-col justify-between rounded-[22px] border-0 bg-white p-3.5 md:min-h-[8rem] md:rounded-[26px] md:p-4">
             <span className="absolute right-3.5 top-3.5 md:right-4 md:top-4"><MetricIcon type="payments" /></span>
             <p className="text-[11px] font-semibold uppercase leading-tight tracking-[0.12em] text-neutral-textSec">Pendientes de pago</p>
               <span className="text-[2rem] font-semibold leading-none text-neutral-textMain">{globalStats.pendingStudents}</span>
            </div>
            <div className="relative flex min-h-[7rem] flex-col justify-between rounded-[22px] border-0 bg-white p-3.5 md:min-h-[8rem] md:rounded-[26px] md:p-4">
             <span className="absolute right-3.5 top-3.5 md:right-4 md:top-4"><MetricIcon type="bonuses" /></span>
             <p className="text-[11px] font-semibold uppercase leading-tight tracking-[0.12em] text-neutral-textSec">Bonos agotándose</p>
               <span className="text-[2rem] font-semibold leading-none text-neutral-textMain">{bonusAlerts.length}</span>
            </div>
           {/* Today's metrics */}
            <div className="relative flex min-h-[7rem] flex-col justify-between rounded-[22px] border-0 bg-white p-3.5 md:min-h-[8rem] md:rounded-[26px] md:p-4">
             <span className="absolute right-3.5 top-3.5 md:right-4 md:top-4"><MetricIcon type="students" /></span>
             <p className="text-[11px] font-semibold uppercase leading-tight tracking-[0.12em] text-neutral-textSec">Alumnos Hoy</p>
               <span className="text-[2rem] font-semibold leading-none text-neutral-textMain">{todayStats.totalAlumnos}</span>
            </div>
            <div className="relative flex min-h-[7rem] flex-col justify-between rounded-[22px] border-0 bg-white p-3.5 md:min-h-[8rem] md:rounded-[26px] md:p-4">
             <span className="absolute right-3.5 top-3.5 md:right-4 md:top-4"><MetricIcon type="sessions" /></span>
             <p className="text-[11px] font-semibold uppercase leading-tight tracking-[0.12em] text-neutral-textSec">Sesiones Hoy</p>
               <span className="text-[2rem] font-semibold leading-none text-neutral-textMain">{todayStats.totalSessions}</span>
           </div>
        </div>

        {/* ─── STUDENT CATEGORIES ROW ─── */}
        {globalStats.totalStudents > 0 && (
           <div className="mb-4 flex flex-wrap gap-2">
            {Object.entries(globalStats.byCategory).filter(([, count]) => (count as number) > 0).map(([cat, count]) => (
              <div key={cat} className="flex items-center gap-2 rounded-full border border-neutral-border bg-white px-2.5 py-1">
                <div className={`w-2.5 h-2.5 rounded-full ${CATEGORY_COLORS[cat] || 'bg-neutral-border'}`}></div>
                <span className="text-[14px] font-semibold text-neutral-textMain md:text-[11px]">{CATEGORY_LABELS[cat] || cat}</span>
                <span className="text-[14px] font-semibold text-neutral-textHelper md:text-[11px]">{count}</span>
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
                <h4 className="text-[20px] font-bold text-neutral-textMain md:text-[16px]">Actividades de hoy</h4>
              </div>
               <button onClick={() => { setActivityForm({ title: '', date: todayStr, time: '', description: '' }); setActivityFormOpen(true); }} className="min-h-[36px] px-2 text-[12px] font-semibold text-brand hover:text-brand-hover transition-colors">
                Añadir actividad
              </button>
            </div>

            <div className="space-y-3">
              {todayActivities.length === 0 && todaySessions.length === 0 ? (
                <div className="bg-white/60 border border-dashed border-neutral-border p-8 md:p-10 rounded-2xl text-center">
                  <p className="text-neutral-textHelper text-[13px]">No hay actividades programadas para hoy</p>
                  <button onClick={() => { setActivityForm({ title: '', date: todayStr, time: '', description: '' }); setActivityFormOpen(true); }} className="mt-4 min-h-[44px] px-4 py-2.5 bg-brand text-white text-[14px] font-semibold rounded-[10px] hover:bg-brand-hover transition-all">
                    Añadir actividad
                  </button>
                </div>
              ) : (
                 <>
                 {todayActivities.map(activity => <div key={activity.id} className="flex items-start gap-3 rounded-[18px] border border-neutral-border bg-white p-3.5">
                   <time className="min-w-[46px] pt-0.5 text-[13px] font-semibold text-neutral-textMain">{activity.time}</time>
                   <div className="min-w-0 flex-1"><p className="text-[14px] font-semibold text-neutral-textMain">{activity.title}</p><p className="mt-1 text-[14px] leading-snug text-neutral-textHelper">{activity.description || 'Sin descripción'}</p></div>
                   <button type="button" aria-label={`Eliminar ${activity.title}`} onClick={() => setActivityPendingDelete(activity)} className="text-[12px] text-neutral-textHelper hover:text-brand">Eliminar</button>
                 </div>)}
                 {todaySessions.map(session => {
                   const occupancy = getSessionOccupancy(session, capacityMap);
                   const conflict = getScheduleConflictReason(session, workshopSchedule, workshopScheduleExceptions);
                   const isFull = occupancy.availability === 'full' || occupancy.availability === 'over_capacity';
                   return (
                      <div key={session.id} className="group flex flex-col items-stretch justify-between gap-3 rounded-[18px] border border-neutral-border bg-white p-3.5 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-soft sm:flex-row sm:items-center md:p-4">
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
                       <div className="flex items-center justify-between gap-2 sm:justify-end">
                         {session.classType !== 'feriado' && <button type="button" className="min-h-11 rounded-lg border border-neutral-border px-3 text-[12px] font-semibold text-brand" onClick={() => onOpenSession ? onOpenSession(session.id, session.date) : onNavigate(AppView.CALENDAR)}>Control de asistencia</button>}
                        <div className="flex -space-x-2">
                          {session.students.slice(0, 3).map((st, i) => (
                              <div key={i} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-neutral-sec text-[11px] font-semibold text-neutral-textSec">
                              {st.charAt(0)}
                            </div>
                          ))}
                          {session.students.length > 3 && (
                              <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-brand-soft text-[11px] font-semibold text-brand">
                              +{session.students.length - 3}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                </>
              )}
            </div>

          </div>

          {activityFormOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Añadir actividad">
            <form onSubmit={submitActivity} className="w-full max-w-md rounded-[24px] bg-white p-5 shadow-xl">
              <div className="mb-4 flex items-center justify-between"><h3 className="text-[18px] font-bold text-neutral-textMain">Añadir actividad</h3><button type="button" onClick={() => setActivityFormOpen(false)} className="text-neutral-textHelper">×</button></div>
              <div className="space-y-3">
                <input required autoFocus value={activityForm.title} onChange={event => setActivityForm({ ...activityForm, title: event.target.value })} placeholder="Nombre de la actividad" className="w-full rounded-xl border border-neutral-border px-3 py-2.5 text-[14px]" />
                <div className="grid grid-cols-2 gap-3"><input required type="date" value={activityForm.date} onChange={event => setActivityForm({ ...activityForm, date: event.target.value })} className="rounded-xl border border-neutral-border px-3 py-2.5 text-[14px]" /><input required type="time" value={activityForm.time} onChange={event => setActivityForm({ ...activityForm, time: event.target.value })} className="rounded-xl border border-neutral-border px-3 py-2.5 text-[14px]" /></div>
                <textarea value={activityForm.description} onChange={event => setActivityForm({ ...activityForm, description: event.target.value })} placeholder="Descripción breve (opcional)" rows={3} className="w-full resize-none rounded-xl border border-neutral-border px-3 py-2.5 text-[14px]" />
              </div>
              <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setActivityFormOpen(false)} className="rounded-xl px-3 py-2 text-[13px] text-neutral-textHelper">Cancelar</button><button type="submit" className="rounded-xl bg-brand px-4 py-2 text-[13px] font-semibold text-white">Guardar</button></div>
            </form>
          </div>}
          {activityPendingDelete && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30 p-4" role="alertdialog" aria-modal="true" aria-labelledby="delete-activity-title">
            <div className="w-full max-w-sm rounded-[22px] bg-white p-5 shadow-xl">
              <h3 id="delete-activity-title" className="text-[17px] font-bold text-neutral-textMain">¿Eliminar actividad?</h3>
              <p className="mt-2 text-[14px] leading-snug text-neutral-textHelper">Se eliminará “{activityPendingDelete.title}” de la agenda.</p>
              <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setActivityPendingDelete(null)} className="rounded-xl px-3 py-2 text-[13px] text-neutral-textHelper">Cancelar</button><button type="button" onClick={() => { saveActivities(activities.filter(item => item.id !== activityPendingDelete.id)); setActivityPendingDelete(null); }} className="rounded-xl bg-[#9E3B2B] px-4 py-2 text-[13px] font-semibold text-white">Eliminar</button></div>
            </div>
          </div>}

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
