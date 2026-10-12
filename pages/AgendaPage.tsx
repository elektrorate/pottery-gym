import React, { useMemo, useState } from 'react';
import { useWorkshopDate } from '../utils/useWorkshopDate';

type Activity = { id: string; title: string; date: string; time: string; description: string };
const STORAGE_KEY = 'taller-workshop-activities';
const pad = (value: number) => String(value).padStart(2, '0');
const toDateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseKey = (key: string) => { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day); };
const monthLabel = (date: Date) => new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(date);

const AgendaPage: React.FC = () => {
  const today = useWorkshopDate();
  const [month, setMonth] = useState(() => parseKey(today));
  const [activities, setActivities] = useState<Activity[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });
  const [selectedDate, setSelectedDate] = useState(today);
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ title: '', time: '', description: '' });

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  }, [month]);
  const selectedActivities = activities.filter(item => item.date === selectedDate).sort((a, b) => a.time.localeCompare(b.time));
  const agendaCount = (key: string) => activities.filter(item => item.date === key).length;
  const save = (next: Activity[]) => { setActivities(next); window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); };
  const openAdd = () => { setForm({ title: '', time: '', description: '' }); setFormOpen(true); };
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!form.title.trim() || !form.time) return; save([...activities, { id: crypto.randomUUID(), title: form.title.trim(), date: selectedDate, time: form.time, description: form.description.trim() }]); setFormOpen(false); };
  const remove = (id: string) => save(activities.filter(item => item.id !== id));

  return <div className="h-full overflow-y-auto bg-neutral-base px-3 pb-28 pt-4 sm:px-6 sm:pt-6">
    <div className="mx-auto max-w-5xl space-y-4">
      <section className="rounded-2xl border border-neutral-border bg-white p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3"><div><p className="eyebrow">Agenda del taller</p><h1 className="ui-page-title text-neutral-textMain">Calendario de actividades</h1></div><button type="button" onClick={openAdd} className="min-h-10 rounded-lg bg-brand px-3 text-[12px] font-semibold text-white">Añadir actividad</button></div>
        <div className="mb-4 flex items-center justify-between"><button type="button" aria-label="Mes anterior" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="h-10 w-10 rounded-lg border border-neutral-border text-lg">‹</button><h2 className="text-[17px] font-semibold capitalize text-neutral-textMain">{monthLabel(month)}</h2><button type="button" aria-label="Mes siguiente" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="h-10 w-10 rounded-lg border border-neutral-border text-lg">›</button></div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase text-neutral-textHelper">{['L','M','X','J','V','S','D'].map(day => <span key={day} className="py-2">{day}</span>)}</div>
        <div className="grid grid-cols-7 gap-1">{days.map(day => { const key = toDateKey(day); const count = agendaCount(key); const inMonth = day.getMonth() === month.getMonth(); return <button type="button" key={key} onClick={() => { setSelectedDate(key); setDayModalOpen(true); }} className={`relative min-h-14 rounded-lg border p-2 text-left transition-colors ${inMonth ? 'border-neutral-border bg-white text-neutral-textMain' : 'border-transparent bg-neutral-base text-neutral-textHelper/50'} ${selectedDate === key ? 'ring-2 ring-brand' : 'hover:border-brand/50'}`}><span className="text-[13px] font-semibold">{day.getDate()}</span>{count > 0 && <span className="absolute right-1.5 top-1.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">{count}</span>}</button>; })}</div>
      </section>
      {dayModalOpen && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label="Detalle de actividades del día"><section className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-neutral-border bg-white p-4 shadow-2xl sm:p-6"><div className="mb-4 flex items-start justify-between gap-3"><div><p className="eyebrow">{selectedDate === today ? 'Hoy' : 'Día seleccionado'}</p><h2 className="text-[20px] font-semibold capitalize text-neutral-textMain">{new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(parseKey(selectedDate))}</h2></div><button type="button" onClick={() => setDayModalOpen(false)} aria-label="Cerrar detalle" className="h-9 w-9 rounded-lg border border-neutral-border text-lg text-neutral-textHelper">×</button></div>{selectedActivities.length === 0 ? <div className="rounded-xl border border-dashed border-neutral-border p-8 text-center text-[13px] text-neutral-textHelper">No hay actividades para este día.</div> : <div className="space-y-3">{selectedActivities.map(item => <article key={item.id} className="flex items-start gap-3 rounded-xl border border-neutral-border p-3"><time className="min-w-12 pt-0.5 text-[13px] font-semibold text-neutral-textMain">{item.time}</time><div className="min-w-0 flex-1"><h3 className="text-[14px] font-semibold text-neutral-textMain">{item.title}</h3><p className="mt-1 text-[14px] leading-snug text-neutral-textHelper">{item.description || 'Sin descripción'}</p></div><button type="button" onClick={() => remove(item.id)} className="text-[12px] text-neutral-textHelper hover:text-[#9E3B2B]">Eliminar</button></article>)}</div>}<button type="button" onClick={openAdd} className="mt-5 min-h-11 w-full rounded-lg bg-brand px-3 text-[13px] font-semibold text-white">Añadir otra actividad</button></section></div>}
    </div>
    {formOpen && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label="Añadir actividad"><form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"><div className="mb-4 flex items-center justify-between"><h2 className="text-[18px] font-bold text-neutral-textMain">Añadir actividad</h2><button type="button" onClick={() => setFormOpen(false)} aria-label="Cerrar">×</button></div><p className="mb-3 text-[13px] text-neutral-textHelper">Fecha: {selectedDate}</p><div className="space-y-3"><input required autoFocus value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Nombre de la actividad" className="w-full rounded-lg border border-neutral-border px-3 py-2.5 text-[14px]" /><input required type="time" value={form.time} onChange={event => setForm({ ...form, time: event.target.value })} className="w-full rounded-lg border border-neutral-border px-3 py-2.5 text-[14px]" /><textarea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="Descripción breve (opcional)" rows={3} className="w-full resize-none rounded-lg border border-neutral-border px-3 py-2.5 text-[14px]" /></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setFormOpen(false)} className="rounded-lg px-3 py-2 text-[13px] text-neutral-textHelper">Cancelar</button><button type="submit" className="rounded-lg bg-brand px-4 py-2 text-[13px] font-semibold text-white">Guardar</button></div></form></div>}
  </div>;
};
export default AgendaPage;
