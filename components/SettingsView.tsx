import { showError } from '../context/toast';
import React, { useEffect, useState } from 'react';
import { useData } from '../context/DataContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabaseClient';
import type { WorkshopScheduleDay } from '../types';
import * as XLSX from 'xlsx';

/* ─── Collapsible Section ─── */
const Section: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, defaultOpen = false, open: controlledOpen, onOpenChange, badge, children }) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const toggleOpen = () => {
    const nextOpen = !open;
    if (onOpenChange) onOpenChange(nextOpen);
    else setInternalOpen(nextOpen);
  };
  return (
    <div className={`border border-neutral-border rounded-2xl overflow-hidden transition-all duration-300 ${open ? 'bg-white soft-shadow' : 'bg-neutral-sec/60 hover:bg-white hover:shadow-sm'}`}>
      <button
        onClick={toggleOpen}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left group"
      >
        <div className={`w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 transition-colors ${open ? 'bg-brand-soft text-brand' : 'bg-neutral-sec text-neutral-textHelper group-hover:bg-brand-soft group-hover:text-brand'}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-[14px] font-semibold text-neutral-textMain">{title}</span>
          <span className="block text-[12px] text-neutral-textHelper truncate">{subtitle}</span>
        </div>
        {badge && <div className="mr-2">{badge}</div>}
        <svg
          className={`w-4 h-4 text-neutral-textHelper shrink-0 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        className={`transition-all duration-300 ease-in-out overflow-hidden ${open ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}`}
      >
        <div className="px-4 pb-4 pt-1 border-t border-neutral-border">
          {children}
        </div>
      </div>
    </div>
  );
};

/* ─── Compact Input ─── */
const CompactField: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div>
    <label className="ui-label mb-1.5 block">{label}</label>
    {children}
  </div>
);

const inputClass = "ui-control w-full px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-neutral-textMain focus:outline-none focus:ring-2 focus:ring-brand/15 focus:border-brand transition-all placeholder:text-neutral-textHelper";
const selectClass = `${inputClass} appearance-none`;

const scheduleDayLabels = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const defaultWorkshopSchedule = (): WorkshopScheduleDay[] => scheduleDayLabels.map((_, dayOfWeek) => ({
  dayOfWeek,
  slotIndex: 0,
  isOpen: false,
  opensAt: '',
  closesAt: ''
}));


const SettingsView: React.FC = () => {
  const { students, sessions, pieces, giftCards, teachers, inventoryItems, inventoryMovements, updateSession, workshopSchedule, updateWorkshopSchedule } = useData();
  const { profile, sedeId } = useAuth();

  // Config states — persisted in localStorage
  const storageKey = `settings_${profile?.id || 'default'}`;
  const savedSettings = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
  })();

  const [workshopName, setWorkshopName] = useState(savedSettings.workshopName || '');
  const [defaultClassDuration, setDefaultClassDuration] = useState(savedSettings.defaultClassDuration || '120');
  const [defaultMaxCapacity, setDefaultMaxCapacity] = useState(savedSettings.defaultMaxCapacity || '10');
  const [currency, setCurrency] = useState(savedSettings.currency || 'EUR');
  const [timezone, setTimezone] = useState(savedSettings.timezone || 'Europe/Madrid');
  const [notifyLowClasses, setNotifyLowClasses] = useState(savedSettings.notifyLowClasses ?? true);
  const [lowClassesThreshold, setLowClassesThreshold] = useState(savedSettings.lowClassesThreshold || '2');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportDone, setExportDone] = useState('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ newPassword: '', confirmPassword: '' });
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [capacityDrafts, setCapacityDrafts] = useState<Record<string, string>>({});
  const [savingCapacityId, setSavingCapacityId] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<WorkshopScheduleDay[]>(defaultWorkshopSchedule);
  const [savingScheduleDay, setSavingScheduleDay] = useState<number | null>(null);
  const [openScheduleDays, setOpenScheduleDays] = useState<Record<number, boolean>>({});
  const [isScheduleSectionOpen, setIsScheduleSectionOpen] = useState(false);

  useEffect(() => {
    if (workshopSchedule.length > 0) {
      setScheduleDraft(defaultWorkshopSchedule().flatMap(defaultDay => {
        const savedSlots = workshopSchedule.filter(day => day.dayOfWeek === defaultDay.dayOfWeek);
        return savedSlots.length ? savedSlots : [defaultDay];
      }));
    }
  }, [workshopSchedule]);

  const replaceDaySlots = (dayOfWeek: number, slots: WorkshopScheduleDay[]) => {
    setScheduleDraft(previous => [
      ...previous.filter(day => day.dayOfWeek !== dayOfWeek),
      ...slots.map((slot, slotIndex) => ({ ...slot, dayOfWeek, slotIndex }))
    ].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.slotIndex - b.slotIndex));
  };

  const toggleScheduleDay = (dayOfWeek: number, isOpen: boolean) => {
    const currentSlot = scheduleDraft.find(day => day.dayOfWeek === dayOfWeek);
    setOpenScheduleDays(previous => ({ ...previous, [dayOfWeek]: true }));
    replaceDaySlots(dayOfWeek, isOpen
      ? [{ ...(currentSlot || {}), dayOfWeek, slotIndex: 0, isOpen: true, opensAt: currentSlot?.opensAt || '10:00', closesAt: currentSlot?.closesAt || '20:00' }]
      : [{ ...(currentSlot || {}), dayOfWeek, slotIndex: 0, isOpen: false, opensAt: '', closesAt: '' }]);
  };

  const addScheduleSlot = (dayOfWeek: number) => {
    const slots = scheduleDraft.filter(day => day.dayOfWeek === dayOfWeek && day.isOpen);
    replaceDaySlots(dayOfWeek, [
      ...slots,
      {
        dayOfWeek,
        slotIndex: slots.length,
        isOpen: true,
        opensAt: '16:00',
        closesAt: '20:00'
      }
    ]);
  };

  const removeScheduleSlot = (dayOfWeek: number, slotIndex: number) => {
    const slots = scheduleDraft.filter(day => day.dayOfWeek === dayOfWeek && day.isOpen && day.slotIndex !== slotIndex);
    replaceDaySlots(dayOfWeek, slots.length ? slots : [{ dayOfWeek, slotIndex: 0, isOpen: false, opensAt: '', closesAt: '' }]);
  };

  const saveWorkshopScheduleDay = async (dayOfWeek: number) => {
    const daySlots = scheduleDraft
      .filter(day => day.dayOfWeek === dayOfWeek && day.isOpen)
      .sort((a, b) => a.opensAt.localeCompare(b.opensAt));
    const invalidSlot = daySlots.find(day => !day.opensAt || !day.closesAt || day.opensAt >= day.closesAt);
    if (invalidSlot) {
      showError(`Revisa el horario del ${scheduleDayLabels[dayOfWeek].toLowerCase()}.`);
      return;
    }
    if (daySlots.some((slot, index) => index > 0 && slot.opensAt < daySlots[index - 1].closesAt)) {
      showError(`Hay horarios solapados el ${scheduleDayLabels[dayOfWeek].toLowerCase()}.`);
      return;
    }

    const persistedSchedule = scheduleDayLabels.flatMap((_, currentDay) => {
      if (currentDay === dayOfWeek) {
        return daySlots.length
          ? daySlots
          : [{ dayOfWeek: currentDay, slotIndex: 0, isOpen: false, opensAt: '', closesAt: '' }];
      }
      const savedSlots = workshopSchedule.filter(day => day.dayOfWeek === currentDay);
      return savedSlots.length
        ? savedSlots
        : [{ dayOfWeek: currentDay, slotIndex: 0, isOpen: false, opensAt: '', closesAt: '' }];
    });

    setSavingScheduleDay(dayOfWeek);
    try {
      const saved = await updateWorkshopSchedule(persistedSchedule);
      if (saved) {
        setOpenScheduleDays(previous => ({ ...previous, [dayOfWeek]: false }));
        setIsScheduleSectionOpen(false);
      }
    } finally {
      setSavingScheduleDay(null);
    }
  };

  const getSessionCapacity = (session: typeof sessions[number]) => session.capacity ?? (session.classType === 'torno' ? 5 : 8);
  const today = new Date().toISOString().slice(0, 10);
  const upcomingSessions = sessions
    .filter(session => session.date >= today && session.classType !== 'feriado')
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
    .slice(0, 40);

  const saveSessionCapacity = async (session: typeof sessions[number]) => {
    const rawValue = capacityDrafts[session.id] ?? String(getSessionCapacity(session));
    const capacity = Number(rawValue);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
      showError('La capacidad debe ser un número entero entre 1 y 100.');
      return;
    }
    if (capacity < session.students.length) {
      showError(`No puede ser menor que los ${session.students.length} alumnos inscritos.`);
      return;
    }
    setSavingCapacityId(session.id);
    try {
      await updateSession(session.id, { capacity });
      setCapacityDrafts(previous => ({ ...previous, [session.id]: String(capacity) }));
    } finally {
      setSavingCapacityId(null);
    }
  };

  const saveSettings = () => {
    const config = {
      workshopName,
      defaultClassDuration,
      defaultMaxCapacity,
      currency,
      timezone,
      notifyLowClasses,
      lowClassesThreshold
    };
    localStorage.setItem(storageKey, JSON.stringify(config));
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2500);
  };

  // ── Excel Export (real, functional) ──
  const exportToExcel = async (mode: 'all' | 'students' | 'sessions' | 'teachers' | 'pieces' | 'giftcards' | 'inventory') => {
    setIsExporting(true);

    try {
      const wb = XLSX.utils.book_new();
      const today = new Date().toISOString().slice(0, 10);

      const addSheet = (name: string, data: Record<string, unknown>[]) => {
        if (data.length === 0) {
          data = [{ info: 'Sin datos' }];
        }
        const ws = XLSX.utils.json_to_sheet(data);
        const maxWidths: number[] = [];
        data.forEach(row => {
          Object.keys(row).forEach((key, i) => {
            const val = String(row[key] ?? '');
            maxWidths[i] = Math.max(maxWidths[i] || key.length, val.length);
          });
        });
        ws['!cols'] = maxWidths.map(w => ({ wch: Math.min(w + 2, 50) }));
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
      };

      if (mode === 'all') {
        addSheet('Resumen', [{
          'Fecha de exportación': today,
          'Sede ID': sedeId || 'Todas las sedes autorizadas',
          Alumnos: students.length,
          Sesiones: sessions.length,
          Profesores: teachers.length,
          Piezas: pieces.length,
          'Bonos regalo': giftCards.length,
          Inventario: inventoryItems.length,
          'Movimientos inventario': inventoryMovements.length
        }]);
      }
      if (mode === 'all' || mode === 'students') {
        addSheet('Alumnos', students.map(s => ({
          ID: s.id,
          Nombre: s.name || '', Apellido: s.surname || '', Email: s.email || '',
          Teléfono: s.phone || '', Estado: s.status || '', 'Clases restantes': s.classesRemaining ?? 0,
          'Método de pago': s.paymentMethod || '', Precio: s.price ?? '',
          'Tipo de clase': s.classType || '', Categoría: s.studentCategory || '', Grupo: s.groupName || '',
          'Fecha alta': s.createdAt || '', 'Fecha vencimiento': s.expiryDate || '',
          Notas: s.notes || '', Observaciones: s.observations || ''
        })));
      }
      if (mode === 'all' || mode === 'sessions') {
        addSheet('Sesiones', sessions.map(s => ({
          ID: s.id,
          Fecha: s.date || '', Inicio: s.startTime || '', Fin: s.endTime || '',
          'Tipo de clase': s.classType || '', 'Cupo máximo': s.capacity ?? (s.classType === 'torno' ? 5 : 8),
          Inscritos: s.students.length, Alumnos: (s.students || []).join(', '),
          'Profesor ID': s.teacherId || '', Taller: s.workshopName || '',
          Audiencia: s.sessionAudience || '', Completada: s.completedAt ? 'Sí' : 'No'
        })));
        if (mode === 'all') {
          addSheet('Asistencia', sessions.flatMap(session => session.students.map((studentName, index) => ({
            'Sesión ID': session.id,
            Fecha: session.date,
            'Alumno ID': session.studentIds?.[index] || '',
            Alumno: studentName,
            Estado: session.attendance?.[studentName] || 'pendiente'
          }))));
        }
      }
      if (mode === 'all' || mode === 'teachers') {
        addSheet('Profesores', teachers.map(t => ({
          ID: t.id,
          Nombre: t.name || '', Apellido: t.surname || '', Especialidad: t.specialty || '',
          Email: t.email || '', Teléfono: t.phone || '', Notas: t.notes || ''
        })));
      }
      if (mode === 'all' || mode === 'pieces') {
        addSheet('Piezas', pieces.map(p => ({
          ID: p.id,
          Propietario: p.owner || '', Descripción: p.description || '', Estado: p.status || '',
          'Tipo de esmalte': p.glazeType || '', 'Fecha entrega': p.deliveryDate || '',
          Notas: p.notes || '', Comentarios: p.extraCommentary || ''
        })));
      }
      if (mode === 'all' || mode === 'giftcards') {
        addSheet('Bonos Regalo', giftCards.map(g => ({
          ID: g.id, Código: g.code || '',
          Comprador: g.buyer || '', Destinatario: g.recipient || '',
          'Nº Clases': g.numClasses ?? '', Tipo: g.type || '',
          Usadas: g.sessionsUsed ?? 0, Restantes: g.sessionsRemaining ?? 0,
          Estado: g.status || '', 'Fecha de emisión': g.issuedDate || '',
          'Fecha caducidad': g.expiryDate || '', Comentarios: g.extraCommentary || ''
        })));
        if (mode === 'all') {
          addSheet('Mov. Bonos', giftCards.flatMap(card => (card.movements || []).map(movement => ({
            ID: movement.id,
            'Bono ID': movement.giftCardId,
            'Sesión ID': movement.sessionId || '',
            'Alumno ID': movement.studentId || '',
            Tipo: movement.type,
            'Variación clases': movement.sessionsDelta,
            Nota: movement.note || '',
            Fecha: movement.createdAt
          }))));
        }
      }
      if (mode === 'all' || mode === 'inventory') {
        addSheet('Inventario', inventoryItems.map((item: any) => ({
          ID: item.id,
          Nombre: item.name || '', Categoría: item.category || '', Código: item.code || '',
          'Cantidad actual': item.current_quantity ?? 0, Unidad: item.unit || '',
          'Cantidad mínima': item.min_quantity ?? 0, Estado: item.status || '',
          Ubicación: item.location || ''
        })));
        if (mode === 'all') {
          addSheet('Movimientos Inv.', inventoryMovements.map((m: any) => ({
            ID: m.id, 'Artículo ID': m.item_id || '',
            Tipo: m.type || '', Cantidad: m.quantity ?? '', 'Nueva cantidad': m.new_quantity ?? '',
            Unidad: m.unit || '', Razón: m.reason || '', Fecha: m.date || '', Notas: m.notes || ''
          })));
        }
      }

      if (mode === 'all') {
        // These tables are not needed by the daily UI, so load them only for the full backup.
        const extraTables = ['payments', 'packages', 'student_assigned_classes', 'sedes', 'sede_members', 'workshop_schedules'] as const;
        const extraRows = await Promise.all(extraTables.map(async table => {
          const { data, error } = await supabase.from(table).select('*');
          if (error) {
            console.warn(`Backup: no se pudo exportar ${table}:`, error.message);
            return { table, rows: [] as Record<string, unknown>[] };
          }
          return {
            table,
            rows: (data || []).map(row => Object.fromEntries(
              Object.entries(row as Record<string, unknown>).filter(([key]) => !/(password|token|secret|api.?key)/i.test(key))
            ))
          };
        }));
        extraRows.forEach(({ table, rows }) => addSheet(table.slice(0, 31), rows));
      }

      const fileName = mode === 'all'
        ? `backup_completo_${today}.xlsx`
        : `backup_${mode}_${today}.xlsx`;
      XLSX.writeFile(wb, fileName);
      setExportDone(mode === 'all' ? 'completo' : mode);
      setTimeout(() => setExportDone(''), 3000);
    } catch (err) {
      console.error('Export error:', err);
      showError('Error al exportar datos.');
    } finally {
      setIsExporting(false);
    }
  };

  /* ── Icons ── */
  const IconWorkshop = (
    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
  const IconSecurity = (
    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
  const IconBackup = (
    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );

  return (
    <div className="bg-white rounded-2xl border border-neutral-border p-4 md:p-6 h-full flex flex-col overflow-y-auto custom-scrollbar">
      {/* ── Header ── */}
      <div className="mb-5">
        <p className="eyebrow mb-1.5">Configuración</p>
        <h2 className="ui-page-title text-neutral-textMain">Administración del taller</h2>
        <p className="ui-secondary mt-1">Gestiona capacidades, seguridad y respaldos de tu sede</p>
      </div>

      {/* ── Sections ── */}
      <div className="flex flex-col gap-3 flex-1">

        {/* ─── 1. CONFIGURACIÓN DEL TALLER ─── */}
        <Section
          icon={IconWorkshop}
          title="Taller"
          subtitle="Nombre, duración, capacidad y moneda"
          defaultOpen={true}
        >
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mt-3">
            <CompactField label="Nombre del taller">
              <input
                type="text" value={workshopName}
                onChange={e => setWorkshopName(e.target.value)}
                placeholder="Ej: Cerámica artesanal"
                className={`${inputClass} col-span-1`}
              />
            </CompactField>

            <CompactField label="Duración clase">
              <select value={defaultClassDuration} onChange={e => setDefaultClassDuration(e.target.value)} className={selectClass}>
                <option value="60">60 min</option>
                <option value="90">90 min</option>
                <option value="120">120 min</option>
                <option value="150">150 min</option>
                <option value="180">180 min</option>
              </select>
            </CompactField>

            <CompactField label="Capacidad máx.">
              <input type="number" min="1" max="50" value={defaultMaxCapacity}
                onChange={e => setDefaultMaxCapacity(e.target.value)} className={inputClass} />
            </CompactField>

            <CompactField label="Moneda">
              <select value={currency} onChange={e => setCurrency(e.target.value)} className={selectClass}>
                <option value="EUR">€ EUR</option>
                <option value="USD">$ USD</option>
                <option value="GBP">£ GBP</option>
                <option value="MXN">$ MXN</option>
                <option value="ARS">$ ARS</option>
                <option value="COP">$ COP</option>
              </select>
            </CompactField>

            <CompactField label="Zona horaria">
              <select value={timezone} onChange={e => setTimezone(e.target.value)} className={selectClass}>
                <option value="Europe/Madrid">España</option>
                <option value="Europe/London">Reino Unido</option>
                <option value="America/Mexico_City">México</option>
                <option value="America/Argentina/Buenos_Aires">Argentina</option>
                <option value="America/Bogota">Colombia</option>
                <option value="America/New_York">EE.UU. Este</option>
                <option value="America/Los_Angeles">EE.UU. Oeste</option>
              </select>
            </CompactField>

            {/* Alerta toggle — inline compact */}
            <div className="flex items-center gap-3 px-3 py-2.5 bg-neutral-sec border border-neutral-border rounded-[10px]">
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input type="checkbox" checked={notifyLowClasses} onChange={e => setNotifyLowClasses(e.target.checked)} className="sr-only peer" />
                <div className="w-9 h-5 bg-neutral-border peer-focus:ring-2 peer-focus:ring-brand/20 rounded-full peer peer-checked:bg-brand transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
              </label>
              <div className="min-w-0">
                <span className="text-[12px] font-semibold text-neutral-textSec block leading-tight">Alerta</span>
                <span className="text-[13px] text-neutral-textSec leading-tight">
                  Avisar si &lt;
                  <input type="number" min="1" max="10" value={lowClassesThreshold}
                    onChange={e => setLowClassesThreshold(e.target.value)}
                    className="w-7 mx-0.5 px-0.5 py-0 text-center bg-white border border-neutral-border rounded text-[12px] font-semibold text-neutral-textMain focus:outline-none inline"
                  /> clases
                </span>
              </div>
            </div>
          </div>

          {/* Save */}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveSettings}
              className="min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[14px] hover:bg-brand-hover active:scale-[0.97] transition-all"
            >
              Guardar
            </button>
            {settingsSaved && (
              <span className="text-[13px] font-semibold text-[#20663B] animate-pulse">✓ Guardado</span>
            )}
          </div>
        </Section>

        {/* ─── 2. HORARIO Y CUPOS DEL TALLER ─── */}
        <Section
          icon={
            <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.5" strokeWidth="2" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 7v5l3 2" />
            </svg>
          }
          title="Horario y cupos del taller"
          subtitle="Gestiona franjas de apertura y capacidad de cada clase"
          defaultOpen={false}
          open={isScheduleSectionOpen}
          onOpenChange={setIsScheduleSectionOpen}
        >
          <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
            <div>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-[14px] font-semibold text-neutral-textMain">Días y franjas</h3>
                  <p className="text-[12px] text-neutral-textHelper">Cada día se guarda por separado.</p>
                </div>
              </div>
              <div className="space-y-3">
                {scheduleDayLabels.map((label, dayOfWeek) => {
                  const slots = scheduleDraft.filter(day => day.dayOfWeek === dayOfWeek && day.isOpen);
                  const isOpen = slots.length > 0;
                  const isExpanded = openScheduleDays[dayOfWeek] ?? false;
                  return (
                    <div key={dayOfWeek} className="rounded-xl border border-neutral-border bg-neutral-sec/50 px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="flex min-h-10 items-center gap-3 text-[13px] font-semibold text-neutral-textMain">
                          <input
                            type="checkbox"
                            checked={isOpen}
                            onChange={event => toggleScheduleDay(dayOfWeek, event.target.checked)}
                            className="h-4 w-4 accent-brand"
                          />
                          {label}
                        </label>
                        <div className="flex items-center gap-2">
                          {isOpen && (
                            <button
                              type="button"
                              onClick={() => { setOpenScheduleDays(previous => ({ ...previous, [dayOfWeek]: true })); addScheduleSlot(dayOfWeek); }}
                              className="min-h-9 rounded-[9px] border border-brand/30 bg-brand-soft px-3 text-[12px] font-semibold text-brand transition hover:bg-brand/15"
                            >
                              + Añadir horario
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setOpenScheduleDays(previous => ({ ...previous, [dayOfWeek]: !isExpanded }))}
                            className="min-h-9 rounded-[9px] px-3 text-[12px] font-semibold text-neutral-textHelper transition hover:bg-white hover:text-brand"
                          >
                            {isExpanded ? 'Ocultar' : 'Editar'}
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="mt-2 space-y-2 border-t border-neutral-border pt-2">
                          {isOpen ? slots.map(slot => (
                            <div key={`${dayOfWeek}-${slot.slotIndex}`} className="flex flex-wrap items-center gap-2 sm:pl-2">
                              <span className="w-16 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-textHelper">Franja {slot.slotIndex + 1}</span>
                              <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-textHelper">
                                Abre
                                <input
                                  aria-label={`${label} franja ${slot.slotIndex + 1} hora de apertura`}
                                  type="time"
                                  value={slot.opensAt}
                                  onChange={event => setScheduleDraft(previous => previous.map(item => item.dayOfWeek === dayOfWeek && item.slotIndex === slot.slotIndex ? { ...item, opensAt: event.target.value } : item))}
                                  className="h-10 rounded-[9px] border border-neutral-border bg-white px-2 text-[13px] font-semibold text-neutral-textMain outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                                />
                              </label>
                              <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-textHelper">
                                Cierra
                                <input
                                  aria-label={`${label} franja ${slot.slotIndex + 1} hora de cierre`}
                                  type="time"
                                  value={slot.closesAt}
                                  onChange={event => setScheduleDraft(previous => previous.map(item => item.dayOfWeek === dayOfWeek && item.slotIndex === slot.slotIndex ? { ...item, closesAt: event.target.value } : item))}
                                  className="h-10 rounded-[9px] border border-neutral-border bg-white px-2 text-[13px] font-semibold text-neutral-textMain outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() => removeScheduleSlot(dayOfWeek, slot.slotIndex)}
                                aria-label={`Eliminar ${label} franja ${slot.slotIndex + 1}`}
                                className="ml-auto min-h-9 rounded-[9px] px-2 text-[12px] font-semibold text-[#9E3B2B] transition hover:bg-[#F8E1DA]"
                              >
                                Eliminar
                              </button>
                            </div>
                          )) : <p className="text-[12px] text-neutral-textHelper">Día cerrado.</p>}
                          <button
                            type="button"
                            onClick={() => void saveWorkshopScheduleDay(dayOfWeek)}
                            disabled={savingScheduleDay === dayOfWeek}
                            className="mt-2 min-h-10 rounded-[9px] bg-brand px-3 text-[12px] font-semibold text-white transition hover:bg-brand-hover disabled:opacity-60"
                          >
                            {savingScheduleDay === dayOfWeek ? 'Guardando...' : `Guardar ${label.toLowerCase()}`}
                          </button>
                        </div>
                      )}
                      {!isExpanded && <p className="mt-1 text-[12px] text-neutral-textHelper">{isOpen ? slots.map(slot => `${slot.opensAt}–${slot.closesAt}`).join(' · ') : 'Cerrado'}</p>}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-neutral-textHelper">El calendario solo permite sesiones completamente dentro de una franja guardada.</p>
            </div>

            <div className="border-t border-neutral-border pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-[14px] font-semibold text-neutral-textMain">Cupo por taller</h3>
                  <p className="text-[12px] text-neutral-textHelper">Capacidad de próximas sesiones.</p>
                </div>
                <span className="text-[16px] font-bold text-brand">{upcomingSessions.length}</span>
              </div>
              <div className="space-y-2">
                {upcomingSessions.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-neutral-border px-4 py-5 text-center text-[13px] text-neutral-textHelper">No hay clases próximas.</p>
                ) : upcomingSessions.map(session => {
                  const capacity = getSessionCapacity(session);
                  const enrolled = session.students.length;
                  const remaining = capacity - enrolled;
                  const dateLabel = new Date(`${session.date}T12:00:00`).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
                  return (
                    <div key={session.id} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-xl border border-neutral-border bg-neutral-sec/50 px-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-neutral-textMain">{dateLabel} · {session.startTime}–{session.endTime}</p>
                        <p className="mt-0.5 text-[11px] uppercase tracking-[0.1em] text-neutral-textHelper">{session.classType} · {enrolled} inscritos</p>
                      </div>
                      <span className={`text-right text-[12px] font-semibold ${remaining === 0 ? 'text-[#9E3B2B]' : remaining < 3 ? 'text-[#8A5517]' : 'text-[#20663B]'}`}>{remaining === 0 ? 'Completa' : `${remaining} libres`}</span>
                      <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-textHelper">
                        Cupo
                        <input
                          aria-label={`Cupo de ${dateLabel}`}
                          type="number"
                          min="1"
                          max="100"
                          value={capacityDrafts[session.id] ?? String(capacity)}
                          onChange={event => setCapacityDrafts(previous => ({ ...previous, [session.id]: event.target.value }))}
                          className="h-10 w-20 rounded-[9px] border border-neutral-border bg-white px-2 text-center text-[13px] font-semibold text-neutral-textMain outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                        />
                      </label>
                      <button type="button" onClick={() => void saveSessionCapacity(session)} disabled={savingCapacityId === session.id} className="min-h-10 rounded-[9px] bg-brand px-3 text-[12px] font-semibold text-white transition hover:bg-brand-hover disabled:opacity-60">
                        {savingCapacityId === session.id ? 'Guardando...' : 'Guardar'}
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-neutral-textHelper">Las nuevas sesiones empiezan con 5 plazas para torno y 8 para el resto.</p>
            </div>
          </div>
        </Section>


        {/* ─── 4. SEGURIDAD ─── */}
        <Section
          icon={IconSecurity}
          title="Seguridad"
          subtitle="Contraseña de acceso"
        >
          <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-[14px] text-neutral-textSec">Actualiza tu contraseña cuando lo necesites.</p>
            <button
              onClick={() => { setShowPasswordModal(true); setPasswordFeedback(null); }}
              className="min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[14px] hover:bg-brand-hover active:scale-[0.97] transition-all shrink-0 inline-flex items-center justify-center gap-2"
            >
              Cambiar contraseña
            </button>
          </div>
        </Section>


        {/* ─── 5. RESPALDO ─── */}
        <Section
          icon={IconBackup}
          title="Respaldo de datos"
          subtitle="Exportar en Excel (.xlsx)"
        >
          <div className="mt-3">
            {/* Full backup */}
            <button
              onClick={() => exportToExcel('all')}
              disabled={isExporting}
              className="w-full min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[14px] hover:bg-brand-hover active:scale-[0.98] transition-all inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {isExporting ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              )}
              {exportDone === 'completo' ? '✓ Descargado' : 'Backup completo'}
            </button>

            {/* Individual */}
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-2 mt-3">
              {[
                { key: 'students' as const, label: 'Alumnos', count: students.length, color: 'text-[#9E3B2B] bg-[#F8E1DA] border-[#EFC9BE]' },
                { key: 'sessions' as const, label: 'Sesiones', count: sessions.length, color: 'text-blue-600 bg-blue-50 border-blue-100' },
                { key: 'teachers' as const, label: 'Profes', count: teachers.length, color: 'text-purple-600 bg-purple-50 border-purple-100' },
                { key: 'pieces' as const, label: 'Piezas', count: pieces.length, color: 'text-amber-700 bg-amber-50 border-amber-100' },
                { key: 'giftcards' as const, label: 'Bonos', count: giftCards.length, color: 'text-emerald-600 bg-emerald-50 border-emerald-100' },
                { key: 'inventory' as const, label: 'Inventario', count: inventoryItems.length, color: 'text-neutral-textSec bg-neutral-alt border-neutral-border' }
              ].map(item => (
                <button
                  key={item.key}
                  onClick={() => exportToExcel(item.key)}
                  disabled={isExporting}
                  className={`min-h-[44px] p-2.5 ${item.color} rounded-[10px] border font-semibold text-[12px] hover:shadow-sm active:scale-[0.97] transition-all disabled:opacity-50 flex flex-col items-center gap-0.5`}
                >
                  <span className="text-[16px] font-bold leading-none">{item.count}</span>
                  <span className="leading-tight">{exportDone === item.key ? '✓' : item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </Section>

        {/* ── Info note ── */}
        <div className="mt-1 px-4 py-3 bg-neutral-sec border border-neutral-border rounded-2xl">
          <p className="text-[13px] text-neutral-textSec leading-relaxed">
            <strong className="text-neutral-textMain">Nota:</strong> Las configuraciones se guardan localmente.
            Los backups se descargan en formato .xlsx. Se recomienda hacer un respaldo semanal.
          </p>
        </div>
      </div>

      {/* ── PASSWORD CHANGE MODAL ── */}
      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-2xl shadow-xl relative animate-fade-in border border-neutral-border overflow-hidden">
            <button onClick={() => setShowPasswordModal(false)} className="absolute top-4 right-4 w-9 h-9 rounded-[10px] flex items-center justify-center text-neutral-textHelper hover:text-brand transition-colors z-20">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <div className="p-5">
              <h3 className="text-[20px] font-bold text-neutral-textMain leading-tight mb-1">Cambiar Contraseña</h3>
              <p className="text-neutral-textSec text-[14px] mb-4">Actualiza tu contraseña de acceso.</p>

              {passwordFeedback && (
                <div className={`mb-4 p-3 rounded-[10px] text-[13px] font-semibold ${passwordFeedback.type === 'success' ? 'bg-[#DFF0E4] text-[#20663B] border border-[#BFDECB]' : 'bg-[#F8E1DA] text-[#9E3B2B] border border-[#EFC9BE]'}`}>
                  {passwordFeedback.msg}
                </div>
              )}

              <form onSubmit={async (e) => {
                e.preventDefault();
                if (passwordForm.newPassword !== passwordForm.confirmPassword) {
                  setPasswordFeedback({ type: 'error', msg: 'Las contraseñas no coinciden.' });
                  return;
                }
                if (passwordForm.newPassword.length < 6) {
                  setPasswordFeedback({ type: 'error', msg: 'La contraseña debe tener al menos 6 caracteres.' });
                  return;
                }
                try {
                  setPasswordLoading(true);
                  const { createClient } = await import('@supabase/supabase-js');
                  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_PROJECT_URL || '';
                  const supabase = createClient(supabaseUrl, import.meta.env.VITE_SUPABASE_ANON_KEY || '');
                  const { error } = await supabase.auth.updateUser({ password: passwordForm.newPassword });
                  if (error) {
                    setPasswordFeedback({ type: 'error', msg: error.message || 'Error al cambiar contraseña.' });
                  } else {
                    setPasswordFeedback({ type: 'success', msg: 'Contraseña actualizada exitosamente.' });
                    setPasswordForm({ newPassword: '', confirmPassword: '' });
                    setTimeout(() => setShowPasswordModal(false), 1500);
                  }
                } catch (err: any) {
                  setPasswordFeedback({ type: 'error', msg: err.message || 'Error de conexión.' });
                } finally {
                  setPasswordLoading(false);
                }
              }} className="space-y-4">
                <CompactField label="Nueva contraseña">
                  <input required type="password" value={passwordForm.newPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                    placeholder="Mínimo 6 caracteres" className={inputClass} />
                </CompactField>
                <CompactField label="Confirmar contraseña">
                  <input required type="password" value={passwordForm.confirmPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                    placeholder="Repite la nueva contraseña" className={inputClass} />
                </CompactField>
                <button type="submit" disabled={passwordLoading}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[14px] hover:bg-brand-hover active:scale-[0.97] transition-all mt-1 disabled:opacity-50"
                >
                  {passwordLoading ? 'Actualizando...' : 'Actualizar'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsView;
