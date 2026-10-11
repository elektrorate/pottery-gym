import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { showError } from '../context/toast';
import { useData } from '../context/DataContext';
import type { CapacityActivity, CapacityDefaults, ClassSession, WorkshopScheduleDay, WorkshopScheduleException } from '../types';
import { capacityDefaultsToMap, getSessionOccupancy, sessionAvailabilityLabel, sessionAvailabilityTone } from '../utils/sessionCapacity';
import { addDays, getScheduleConflictReason, getWeekMonday, madridDateKey } from '../utils/workshopSchedule';

const dayLabels: Record<number, string> = { 0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado' };
const dayOrder = [1, 2, 3, 4, 5, 6, 0];
const activityLabels: Record<CapacityActivity, string> = {
  mesa: 'Mesa', torno: 'Torno', coworking: 'Coworking', workshop: 'Workshop', privada: 'Privadas'
};
const activityTypes: CapacityActivity[] = ['mesa', 'torno', 'coworking', 'workshop', 'privada'];
const inputClass = 'h-10 rounded-[9px] border border-neutral-border bg-white px-3 text-[13px] font-medium text-neutral-textMain outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15';

const closedDay = (dayOfWeek: number): WorkshopScheduleDay => ({ dayOfWeek, slotIndex: 0, isOpen: false, opensAt: '', closesAt: '' });

const buildScheduleDraft = (saved: WorkshopScheduleDay[]) => dayOrder.flatMap(dayOfWeek => {
  const rows = saved.filter(item => item.dayOfWeek === dayOfWeek);
  return rows.length ? rows : [closedDay(dayOfWeek)];
});

const dateLabel = (dateKey: string) => {
  const label = new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return label.charAt(0).toUpperCase() + label.slice(1);
};

type Conflict = { session: ClassSession; reason: string };
type Confirmation = { title: string; message: string; conflicts: Conflict[]; onConfirm: () => Promise<void> };

const WorkshopAvailabilityPanel: React.FC = () => {
  const navigate = useNavigate();
  const {
    sessions, workshopSchedule, workshopScheduleExceptions, capacityDefaults,
    updateSession, updateWorkshopSchedule, updateWorkshopScheduleException, updateCapacityDefault
  } = useData();
  const today = madridDateKey();
  const defaults = useMemo(() => capacityDefaultsToMap(capacityDefaults), [capacityDefaults]);

  const [scheduleDraft, setScheduleDraft] = useState<WorkshopScheduleDay[]>(() => buildScheduleDraft(workshopSchedule));
  const [dirtyScheduleDays, setDirtyScheduleDays] = useState<Set<number>>(new Set());
  const [expandedDay, setExpandedDay] = useState<number | null>(null);
  const [savingDay, setSavingDay] = useState<number | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState('');
  const [externalScheduleChange, setExternalScheduleChange] = useState(false);
  const [capacityDrafts, setCapacityDrafts] = useState<Record<string, string>>({});
  const [savingDefault, setSavingDefault] = useState<CapacityActivity | null>(null);
  const [savingSessionId, setSavingSessionId] = useState<string | null>(null);
  const [sessionCapacityDrafts, setSessionCapacityDrafts] = useState<Record<string, string>>({});
  const [range, setRange] = useState<'week' | 'next' | 'custom'>('week');
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(addDays(today, 14));
  const [activityFilter, setActivityFilter] = useState<'all' | CapacityActivity>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'places' | 'full' | 'conflicts'>('all');
  const [visibleCount, setVisibleCount] = useState(12);
  const [availabilityExpanded, setAvailabilityExpanded] = useState(false);
  const [enrolledSession, setEnrolledSession] = useState<ClassSession | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [exceptionDate, setExceptionDate] = useState(addDays(today, 1));
  const [exceptionOpen, setExceptionOpen] = useState(false);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionSlots, setExceptionSlots] = useState([{ slotIndex: 0, isOpen: true, opensAt: '10:00', closesAt: '14:00' }]);
  const [savingException, setSavingException] = useState(false);

  useEffect(() => {
    if (dirtyScheduleDays.size > 0) {
      setExternalScheduleChange(true);
      return;
    }
    setScheduleDraft(buildScheduleDraft(workshopSchedule));
  }, [workshopSchedule, dirtyScheduleDays.size]);

  const markDayDirty = (dayOfWeek: number) => {
    setDirtyScheduleDays(previous => new Set(previous).add(dayOfWeek));
    setScheduleNotice('');
  };

  const updateDaySlots = (dayOfWeek: number, slots: WorkshopScheduleDay[]) => {
    setScheduleDraft(previous => [
      ...previous.filter(item => item.dayOfWeek !== dayOfWeek),
      ...slots.map((slot, slotIndex) => ({ ...slot, dayOfWeek, slotIndex }))
    ].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.slotIndex - b.slotIndex));
    markDayDirty(dayOfWeek);
  };

  const toggleDay = (dayOfWeek: number, isOpen: boolean) => {
    const current = scheduleDraft.filter(item => item.dayOfWeek === dayOfWeek && item.isOpen);
    updateDaySlots(dayOfWeek, isOpen
      ? [current[0] || { dayOfWeek, slotIndex: 0, isOpen: true, opensAt: '10:00', closesAt: '20:00' }]
      : [closedDay(dayOfWeek)]);
    setExpandedDay(dayOfWeek);
  };

  const addSlot = (dayOfWeek: number) => {
    const current = scheduleDraft.filter(item => item.dayOfWeek === dayOfWeek && item.isOpen);
    updateDaySlots(dayOfWeek, [...current, { dayOfWeek, slotIndex: current.length, isOpen: true, opensAt: '16:00', closesAt: '20:00' }]);
  };

  const removeSlot = (dayOfWeek: number, slotIndex: number) => {
    const current = scheduleDraft.filter(item => item.dayOfWeek === dayOfWeek && item.isOpen && item.slotIndex !== slotIndex);
    updateDaySlots(dayOfWeek, current.length ? current : [closedDay(dayOfWeek)]);
  };

  const mergedSchedule = () => dayOrder.flatMap(dayOfWeek => {
    if (dirtyScheduleDays.has(dayOfWeek)) return scheduleDraft.filter(item => item.dayOfWeek === dayOfWeek);
    const saved = workshopSchedule.filter(item => item.dayOfWeek === dayOfWeek);
    return saved.length ? saved : [closedDay(dayOfWeek)];
  });

  const getConflicts = (weekly: WorkshopScheduleDay[], exceptions = workshopScheduleExceptions): Conflict[] => sessions
    .filter(session => session.date >= today && session.classType !== 'feriado')
    .map(session => ({ session, reason: getScheduleConflictReason(session, weekly, exceptions) }))
    .filter((item): item is Conflict => Boolean(item.reason));

  const persistSchedule = async (dayOfWeek: number, schedule: WorkshopScheduleDay[]) => {
    setSavingDay(dayOfWeek);
    const saved = await updateWorkshopSchedule(schedule);
    setSavingDay(null);
    if (saved) {
      setDirtyScheduleDays(previous => {
        const next = new Set(previous);
        next.delete(dayOfWeek);
        return next;
      });
      setExternalScheduleChange(false);
      setScheduleNotice(`${dayLabels[dayOfWeek]} guardado`);
      setExpandedDay(null);
    }
  };

  const saveDay = async (dayOfWeek: number) => {
    const daySlots = scheduleDraft.filter(item => item.dayOfWeek === dayOfWeek && item.isOpen).sort((a, b) => a.opensAt.localeCompare(b.opensAt));
    const invalid = daySlots.find(slot => !slot.opensAt || !slot.closesAt || slot.opensAt >= slot.closesAt);
    const duplicated = new Set(daySlots.map(slot => `${slot.opensAt}-${slot.closesAt}`)).size !== daySlots.length;
    const overlaps = daySlots.some((slot, index) => index > 0 && slot.opensAt < daySlots[index - 1].closesAt);
    if (invalid || duplicated || overlaps) {
      showError(duplicated ? `Hay franjas duplicadas el ${dayLabels[dayOfWeek].toLowerCase()}.` : `Las franjas del ${dayLabels[dayOfWeek].toLowerCase()} deben ser válidas y no solaparse.`);
      return;
    }
    const schedule = mergedSchedule();
    const conflicts = getConflicts(schedule);
    const save = () => persistSchedule(dayOfWeek, schedule);
    if (conflicts.length) {
      setConfirmation({
        title: 'Hay sesiones fuera del nuevo horario',
        message: 'Puedes conservarlas sin mover ni borrar reservas. Quedarán marcadas como conflictos pendientes.',
        conflicts,
        onConfirm: async () => { setConfirmation(null); await save(); }
      });
      return;
    }
    await save();
  };

  const resetScheduleDraft = () => {
    setScheduleDraft(buildScheduleDraft(workshopSchedule));
    setDirtyScheduleDays(new Set());
    setExternalScheduleChange(false);
  };

  const saveDefault = async (classType: CapacityActivity) => {
    const value = Number(capacityDrafts[classType] ?? defaults[classType] ?? 8);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      showError('La capacidad predeterminada debe ser un entero entre 1 y 100.');
      return;
    }
    setSavingDefault(classType);
    const saved = await updateCapacityDefault(classType, value);
    setSavingDefault(null);
    if (saved) setCapacityDrafts(previous => ({ ...previous, [classType]: String(value) }));
  };

  const existingExceptionDates = useMemo(() => Array.from(new Set(workshopScheduleExceptions.map(item => item.exceptionDate))).sort(), [workshopScheduleExceptions]);

  const loadException = (date: string) => {
    const rows = workshopScheduleExceptions.filter(item => item.exceptionDate === date);
    setExceptionDate(date);
    setExceptionOpen(rows.some(item => item.isOpen));
    setExceptionReason(rows.find(item => item.reason)?.reason || '');
    const openSlots = rows.filter(item => item.isOpen).map(item => ({ slotIndex: item.slotIndex, isOpen: true, opensAt: item.opensAt, closesAt: item.closesAt }));
    setExceptionSlots(openSlots.length ? openSlots : [{ slotIndex: 0, isOpen: true, opensAt: '10:00', closesAt: '14:00' }]);
  };

  const exceptionRows = () => exceptionOpen
    ? exceptionSlots.map((slot, index) => ({ ...slot, slotIndex: index, reason: exceptionReason || undefined }))
    : [{ slotIndex: 0, isOpen: false, opensAt: '', closesAt: '', reason: exceptionReason || undefined }];

  const saveException = async () => {
    const rows = exceptionRows();
    const openRows = rows.filter(row => row.isOpen).sort((a, b) => a.opensAt.localeCompare(b.opensAt));
    const invalid = openRows.find(row => !row.opensAt || !row.closesAt || row.opensAt >= row.closesAt);
    const overlap = openRows.some((row, index) => index > 0 && row.opensAt < openRows[index - 1].closesAt);
    if (invalid || overlap) {
      showError('La excepción debe tener franjas válidas y sin solapamientos.');
      return;
    }
    const nextExceptions = [...workshopScheduleExceptions.filter(item => item.exceptionDate !== exceptionDate), ...rows.map(row => ({ ...row, exceptionDate }))];
    const conflicts = getConflicts(scheduleDraft, nextExceptions);
    const save = async () => {
      setSavingException(true);
      const saved = await updateWorkshopScheduleException(exceptionDate, rows);
      setSavingException(false);
      if (saved) setScheduleNotice(`Excepción del ${dateLabel(exceptionDate)} guardada`);
    };
    if (conflicts.length) {
      setConfirmation({
        title: 'Hay sesiones afectadas por esta excepción',
        message: 'Se conservarán las sesiones y sus reservas. Confirma para marcar los conflictos pendientes.',
        conflicts,
        onConfirm: async () => { setConfirmation(null); await save(); }
      });
      return;
    }
    await save();
  };

  const removeException = async () => {
    setSavingException(true);
    await updateWorkshopScheduleException(exceptionDate, []);
    setSavingException(false);
  };

  const rangeBounds = useMemo(() => {
    const monday = getWeekMonday(today);
    if (range === 'week') return { from: monday, to: addDays(monday, 6) };
    if (range === 'next') return { from: addDays(monday, 7), to: addDays(monday, 13) };
    return { from: customFrom, to: customTo };
  }, [customFrom, customTo, range, today]);

  const filteredSessions = useMemo(() => sessions
    .filter(session => session.date >= rangeBounds.from && session.date <= rangeBounds.to && session.classType !== 'feriado')
    .filter(session => activityFilter === 'all' || session.classType === activityFilter)
    .filter(session => {
      const occupancy = getSessionOccupancy(session, defaults);
      const conflict = getScheduleConflictReason(session, workshopSchedule, workshopScheduleExceptions);
      if (statusFilter === 'places') return occupancy.remaining > 0;
      if (statusFilter === 'full') return occupancy.remaining <= 0;
      if (statusFilter === 'conflicts') return Boolean(conflict);
      return true;
    })
    .sort((a, b) => `${a.date}${a.startTime}${a.id}`.localeCompare(`${b.date}${b.startTime}${b.id}`)),
  [activityFilter, defaults, rangeBounds.from, rangeBounds.to, sessions, statusFilter, today, workshopSchedule, workshopScheduleExceptions]);

  const visibleSessions = filteredSessions.slice(0, visibleCount);
  const groupedSessions = visibleSessions.reduce<Record<string, ClassSession[]>>((groups, session) => {
    (groups[session.date] ||= []).push(session);
    return groups;
  }, {});

  const saveSessionCapacity = async (session: ClassSession) => {
    const occupancy = getSessionOccupancy(session, defaults);
    const value = Number(sessionCapacityDrafts[session.id] ?? occupancy.capacity);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      showError('El cupo debe ser un entero entre 1 y 100.');
      return;
    }
    if (value < occupancy.enrolled) {
      showError(`No puede ser menor que los ${occupancy.enrolled} inscritos.`);
      return;
    }
    setSavingSessionId(session.id);
    const saved = await updateSession(session.id, { capacity: value });
    setSavingSessionId(null);
    if (saved) setSessionCapacityDrafts(previous => ({ ...previous, [session.id]: String(value) }));
  };

  const capacityMap = defaults;

  return (
    <div className="space-y-5">
      {externalScheduleChange && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#EBD5AC] bg-[#FFF8EC] px-4 py-3 text-[12px] text-[#916438]">
          <span>El horario habitual cambió en otro dispositivo mientras editabas.</span>
          <button type="button" onClick={resetScheduleDraft} className="min-h-9 rounded-lg bg-white px-3 font-semibold text-brand">Recargar horario</button>
        </div>
      )}

      <section className="rounded-2xl border border-neutral-border bg-neutral-sec/50 p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow text-brand">A · Horario habitual de apertura</p><h3 className="ui-section-title mt-1 text-neutral-textMain">Días y franjas</h3><p className="ui-secondary mt-1">Los cambios no mueven ni cancelan sesiones existentes.</p></div>
          {scheduleNotice && <span className="rounded-lg bg-[#E7F0E8] px-3 py-2 text-[12px] font-semibold text-[#47704D]">✓ {scheduleNotice}</span>}
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          {dayOrder.map(dayOfWeek => {
            const slots = scheduleDraft.filter(item => item.dayOfWeek === dayOfWeek && item.isOpen);
            const expanded = expandedDay === dayOfWeek;
            return <div key={dayOfWeek} className="rounded-xl border border-neutral-border bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-[13px] font-semibold text-neutral-textMain">{dayLabels[dayOfWeek]}</p><p className="mt-0.5 text-[12px] text-neutral-textHelper">{slots.length ? slots.map(slot => `${slot.opensAt}–${slot.closesAt}`).join(' / ') : 'Cerrado'}</p></div>
                <div className="flex items-center gap-2"><label className="flex items-center gap-2 text-[11px] font-semibold text-neutral-textHelper"><input type="checkbox" checked={slots.length > 0} onChange={event => toggleDay(dayOfWeek, event.target.checked)} className="h-4 w-4 accent-brand" /> Abierto</label><button type="button" onClick={() => setExpandedDay(expanded ? null : dayOfWeek)} className="min-h-9 rounded-lg px-3 text-[12px] font-semibold text-brand hover:bg-brand-soft">{expanded ? 'Ocultar' : 'Editar'}</button></div>
              </div>
              {expanded && <div className="mt-3 space-y-2 border-t border-neutral-border pt-3">
                {slots.map((slot, index) => <div key={`${dayOfWeek}-${slot.slotIndex}`} className="flex flex-wrap items-center gap-2">
                  <span className="w-16 text-[11px] font-semibold text-neutral-textHelper">Franja {index + 1}</span>
                  <input aria-label={`${dayLabels[dayOfWeek]} franja ${index + 1} inicio`} type="time" value={slot.opensAt} onChange={event => updateDaySlots(dayOfWeek, slots.map((item, itemIndex) => itemIndex === index ? { ...item, opensAt: event.target.value } : item))} className={inputClass} />
                  <span className="text-neutral-textHelper">a</span>
                  <input aria-label={`${dayLabels[dayOfWeek]} franja ${index + 1} fin`} type="time" value={slot.closesAt} onChange={event => updateDaySlots(dayOfWeek, slots.map((item, itemIndex) => itemIndex === index ? { ...item, closesAt: event.target.value } : item))} className={inputClass} />
                  <button type="button" onClick={() => removeSlot(dayOfWeek, slot.slotIndex)} className="min-h-9 rounded-lg px-2 text-[12px] font-semibold text-[#9E3B2B] hover:bg-[#F8E1DA]">Eliminar</button>
                </div>)}
                {slots.length === 0 && <p className="text-[12px] text-neutral-textHelper">Día cerrado. Puedes volver a abrirlo con el interruptor.</p>}
                {slots.length > 0 && <button type="button" onClick={() => addSlot(dayOfWeek)} className="min-h-9 rounded-lg border border-brand/30 bg-brand-soft px-3 text-[12px] font-semibold text-brand">+ Añadir franja</button>}
                <div><button type="button" onClick={() => void saveDay(dayOfWeek)} disabled={savingDay === dayOfWeek} className="min-h-10 rounded-lg bg-brand px-4 text-[12px] font-semibold text-white hover:bg-brand-hover disabled:opacity-60">{savingDay === dayOfWeek ? 'Guardando…' : `Guardar ${dayLabels[dayOfWeek].toLowerCase()}`}</button></div>
              </div>}
            </div>;
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-neutral-border bg-neutral-sec/50 p-4 md:p-5">
        <div className="mb-4"><p className="eyebrow text-brand">B · Capacidades predeterminadas</p><h3 className="ui-section-title mt-1 text-neutral-textMain">Nuevas sesiones</h3><p className="ui-secondary mt-1">Solo se aplican al crear una sesión. Las sesiones existentes conservan su cupo.</p></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {activityTypes.map(classType => {
            const value = capacityDrafts[classType] ?? String(capacityMap[classType] ?? 8);
            const changed = value !== String(capacityMap[classType] ?? 8);
            return <div key={classType} className="rounded-xl border border-neutral-border bg-white p-3"><p className="text-[13px] font-semibold text-neutral-textMain">{activityLabels[classType]}</p><div className="mt-2 flex gap-2"><input aria-label={`Capacidad predeterminada de ${activityLabels[classType]}`} type="number" min="1" max="100" value={value} onChange={event => setCapacityDrafts(previous => ({ ...previous, [classType]: event.target.value }))} className={`${inputClass} min-w-0 flex-1`} /><button type="button" disabled={!changed || savingDefault === classType} onClick={() => void saveDefault(classType)} className="min-h-10 rounded-lg bg-brand px-3 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{savingDefault === classType ? '…' : 'Guardar'}</button></div></div>;
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-neutral-border bg-neutral-sec/50 p-4 md:p-5">
        <button
          type="button"
          onClick={() => setAvailabilityExpanded(expanded => !expanded)}
          aria-expanded={availabilityExpanded}
          aria-controls="session-availability-content"
          className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          <span>
            <span className="eyebrow block text-brand">C · Disponibilidad por sesión</span>
            <span className="ui-section-title mt-1 block text-neutral-textMain">Sesiones programadas</span>
          </span>
          <span className="flex items-center gap-3">
            <span className="rounded-full bg-brand-soft px-3 py-1.5 text-[12px] font-bold text-brand">{filteredSessions.length} sesiones</span>
            <span className="flex items-center gap-2 text-[12px] font-semibold text-brand">
              {availabilityExpanded ? 'Ver menos' : 'Ver más'}
              <svg aria-hidden="true" className={`h-4 w-4 transition-transform ${availabilityExpanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" /></svg>
            </span>
          </span>
        </button>
        <div id="session-availability-content" hidden={!availabilityExpanded}>
        <p className="ui-secondary mb-4 mt-3">Inscritos reales frente al cupo guardado en cada sesión.</p>
        <div className="grid gap-2 rounded-xl border border-neutral-border bg-white p-3 md:grid-cols-[auto_auto_auto_1fr]">
          <select aria-label="Periodo de sesiones" value={range} onChange={event => { setRange(event.target.value as typeof range); setVisibleCount(12); }} className={inputClass}><option value="week">Esta semana</option><option value="next">Próxima semana</option><option value="custom">Rango de fechas</option></select>
          {range === 'custom' && <><input aria-label="Desde" type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} className={inputClass} /><input aria-label="Hasta" type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} className={inputClass} /></>}
          <select aria-label="Filtrar por actividad" value={activityFilter} onChange={event => { setActivityFilter(event.target.value as typeof activityFilter); setVisibleCount(12); }} className={inputClass}><option value="all">Todas las actividades</option>{activityTypes.map(item => <option key={item} value={item}>{activityLabels[item]}</option>)}</select>
          <select aria-label="Filtrar disponibilidad" value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter); setVisibleCount(12); }} className={inputClass}><option value="all">Todas</option><option value="places">Con plazas</option><option value="full">Completas</option><option value="conflicts">Con conflictos</option></select>
        </div>
        <div className="mt-4 space-y-5">
          {Object.keys(groupedSessions).length === 0 && <p className="rounded-xl border border-dashed border-neutral-border bg-white px-4 py-8 text-center text-[13px] text-neutral-textHelper">No hay sesiones con este filtro.</p>}
          {(Object.entries(groupedSessions) as [string, ClassSession[]][]).map(([date, dateSessions]) => <div key={date}><h4 className="mb-2 text-[13px] font-bold text-neutral-textMain">{dateLabel(date)}</h4><div className="space-y-2">{dateSessions.map(session => {
            const occupancy = getSessionOccupancy(session, defaults);
            const conflict = getScheduleConflictReason(session, workshopSchedule, workshopScheduleExceptions);
            const draft = sessionCapacityDrafts[session.id] ?? String(occupancy.capacity);
            const changed = draft !== String(occupancy.capacity);
            return <article key={session.id} className="rounded-xl border border-neutral-border bg-white p-3 md:p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-[13px] font-semibold text-neutral-textMain">{session.startTime}–{session.endTime} · {activityLabels[session.classType as CapacityActivity] || session.classType}</p>{session.workshopName && <p className="mt-0.5 text-[12px] text-neutral-textHelper">{session.workshopName}</p>}<div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-neutral-textSec"><span>{occupancy.enrolled} inscritos / {occupancy.capacity} plazas</span><span>·</span><strong className={occupancy.remaining < 0 ? 'text-[#9E3B2B]' : 'text-neutral-textMain'}>{occupancy.remaining < 0 ? `${Math.abs(occupancy.remaining)} de exceso` : `${occupancy.remaining} libres`}</strong></div></div><span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${sessionAvailabilityTone[occupancy.availability]}`}>{sessionAvailabilityLabel[occupancy.availability]}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-sec"><div className={`h-full ${occupancy.availability === 'over_capacity' ? 'bg-[#9E3B2B]' : occupancy.availability === 'full' ? 'bg-brand' : 'bg-[#5F8065]'}`} style={{ width: `${occupancy.visualPercentage}%` }} /></div>{conflict && <p className="mt-2 rounded-lg border border-[#EBD5AC] bg-[#FFF8EC] px-3 py-2 text-[12px] font-semibold text-[#916438]">Conflicto pendiente: {conflict}</p>}<div className="mt-3 flex flex-wrap items-end gap-2"><label className="text-[11px] font-semibold text-neutral-textHelper">Cupo máximo<input aria-label={`Cupo máximo de ${session.date} ${session.startTime}`} type="number" min="1" max="100" value={draft} onChange={event => setSessionCapacityDrafts(previous => ({ ...previous, [session.id]: event.target.value }))} className={`${inputClass} mt-1 w-28`} /></label><button type="button" disabled={!changed || savingSessionId === session.id} onClick={() => void saveSessionCapacity(session)} className="min-h-10 rounded-lg bg-brand px-3 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{savingSessionId === session.id ? 'Guardando…' : 'Guardar'}</button><button type="button" onClick={() => setEnrolledSession(session)} className="min-h-10 rounded-lg border border-neutral-border px-3 text-[12px] font-semibold text-neutral-textMain hover:bg-neutral-sec">Ver inscritos</button><button type="button" onClick={() => navigate(`/calendar?sessionId=${encodeURIComponent(session.id)}&date=${session.date}`)} className="min-h-10 rounded-lg border border-brand/30 bg-brand-soft px-3 text-[12px] font-semibold text-brand hover:bg-brand/15">Ver en calendario</button></div></article>;
          })}</div></div>)}
        </div>
        {visibleCount < filteredSessions.length && <button type="button" onClick={() => setVisibleCount(value => value + 12)} className="mt-4 min-h-10 w-full rounded-lg border border-brand/30 bg-white text-[12px] font-semibold text-brand hover:bg-brand-soft">Cargar más sesiones ({filteredSessions.length - visibleCount} restantes)</button>}
        </div>
      </section>

      <section className="rounded-2xl border border-neutral-border bg-neutral-sec/50 p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow text-brand">D · Excepciones por fecha</p><h3 className="ui-section-title mt-1 text-neutral-textMain">Festivos, vacaciones y cierres puntuales</h3><p className="ui-secondary mt-1">La excepción tiene prioridad sobre el horario semanal.</p></div><div className="flex flex-wrap gap-2">{existingExceptionDates.slice(0, 5).map(date => <button type="button" key={date} onClick={() => loadException(date)} className="rounded-full border border-neutral-border bg-white px-3 py-1.5 text-[11px] font-semibold text-neutral-textSec hover:border-brand hover:text-brand">{date}</button>)}</div></div>
        <div className="grid gap-3 md:grid-cols-[auto_auto_1fr] md:items-end"><label className="text-[11px] font-semibold text-neutral-textHelper">Fecha<input aria-label="Fecha de excepción" type="date" value={exceptionDate} onChange={event => { setExceptionDate(event.target.value); loadException(event.target.value); }} className={`${inputClass} mt-1`} /></label><label className="flex min-h-10 items-center gap-2 text-[12px] font-semibold text-neutral-textMain"><input type="checkbox" checked={exceptionOpen} onChange={event => setExceptionOpen(event.target.checked)} className="h-4 w-4 accent-brand" /> Abrir con horario excepcional</label><input aria-label="Motivo de excepción" value={exceptionReason} onChange={event => setExceptionReason(event.target.value)} placeholder="Motivo: festivo, mantenimiento..." className={inputClass} /></div>
        {exceptionOpen && <div className="mt-3 space-y-2 rounded-xl border border-neutral-border bg-white p-3">{exceptionSlots.map((slot, index) => <div key={index} className="flex flex-wrap items-center gap-2"><span className="w-16 text-[11px] font-semibold text-neutral-textHelper">Franja {index + 1}</span><input aria-label={`Excepción franja ${index + 1} inicio`} type="time" value={slot.opensAt} onChange={event => setExceptionSlots(previous => previous.map((item, itemIndex) => itemIndex === index ? { ...item, opensAt: event.target.value } : item))} className={inputClass} /><span className="text-neutral-textHelper">a</span><input aria-label={`Excepción franja ${index + 1} fin`} type="time" value={slot.closesAt} onChange={event => setExceptionSlots(previous => previous.map((item, itemIndex) => itemIndex === index ? { ...item, closesAt: event.target.value } : item))} className={inputClass} />{exceptionSlots.length > 1 && <button type="button" onClick={() => setExceptionSlots(previous => previous.filter((_, itemIndex) => itemIndex !== index))} className="text-[12px] font-semibold text-[#9E3B2B]">Eliminar</button>}</div>)}<button type="button" onClick={() => setExceptionSlots(previous => [...previous, { slotIndex: previous.length, isOpen: true, opensAt: '16:00', closesAt: '20:00' }])} className="min-h-9 rounded-lg border border-brand/30 bg-brand-soft px-3 text-[12px] font-semibold text-brand">+ Añadir franja</button></div>}
        {!exceptionOpen && <p className="mt-3 rounded-xl border border-[#EFC9BE] bg-[#FFF8F5] px-3 py-2 text-[12px] text-[#9E3B2B]">La fecha quedará completamente cerrada.</p>}
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void saveException()} disabled={savingException} className="min-h-10 rounded-lg bg-brand px-4 text-[12px] font-semibold text-white disabled:opacity-60">{savingException ? 'Guardando…' : 'Guardar excepción'}</button>{existingExceptionDates.includes(exceptionDate) && <button type="button" onClick={() => void removeException()} disabled={savingException} className="min-h-10 rounded-lg border border-neutral-border bg-white px-4 text-[12px] font-semibold text-[#9E3B2B]">Quitar excepción</button>}</div>
      </section>

      {confirmation && <div className="fixed inset-0 z-[140] flex items-center justify-center bg-[#2F1E17]/45 p-4 backdrop-blur-sm"><section role="dialog" aria-modal="true" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-neutral-border bg-white p-5 shadow-2xl"><h3 className="ui-section-title text-neutral-textMain">{confirmation.title}</h3><p className="mt-2 text-[13px] leading-relaxed text-neutral-textSec">{confirmation.message}</p><div className="mt-4 space-y-2">{confirmation.conflicts.map(item => <button type="button" key={item.session.id} onClick={() => { setConfirmation(null); navigate(`/calendar?sessionId=${encodeURIComponent(item.session.id)}&date=${item.session.date}`); }} className="block w-full rounded-xl border border-[#EBD5AC] bg-[#FFF8EC] px-3 py-2 text-left hover:border-brand"><span className="block text-[12px] font-semibold text-[#7B3F22]">{dateLabel(item.session.date)} · {item.session.startTime}–{item.session.endTime}</span><span className="block text-[12px] text-[#916438]">{item.session.classType} · {item.session.students.length} inscritos · {item.reason}</span></button>)}</div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setConfirmation(null)} className="min-h-10 rounded-lg px-4 text-[12px] font-semibold text-neutral-textHelper">Cancelar</button><button type="button" onClick={() => void confirmation.onConfirm()} className="min-h-10 rounded-lg bg-brand px-4 text-[12px] font-semibold text-white">Confirmar y conservar sesiones</button></div></section></div>}
      {enrolledSession && <div className="fixed inset-0 z-[130] flex items-center justify-center bg-[#2F1E17]/45 p-4 backdrop-blur-sm"><section role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-neutral-border bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-3"><div><p className="eyebrow text-brand">Inscritos vinculados</p><h3 className="ui-section-title mt-1 text-neutral-textMain">{dateLabel(enrolledSession.date)}</h3><p className="ui-secondary">{enrolledSession.startTime}–{enrolledSession.endTime}</p></div><button type="button" onClick={() => setEnrolledSession(null)} aria-label="Cerrar inscritos" className="h-9 w-9 rounded-full text-neutral-textHelper hover:bg-neutral-sec">×</button></div><div className="mt-4 space-y-2">{enrolledSession.students.length ? enrolledSession.students.map((student, index) => <div key={`${student}-${index}`} className="rounded-lg bg-neutral-sec px-3 py-2 text-[13px] text-neutral-textMain">{student}</div>) : <p className="text-[13px] text-neutral-textHelper">No hay inscritos vinculados.</p>}</div></section></div>}
    </div>
  );
};

export default WorkshopAvailabilityPanel;
