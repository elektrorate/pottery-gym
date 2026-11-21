import React, { useEffect, useRef, useState } from 'react';
import type { ClassSession, Teacher, WorkshopScheduleDay, WorkshopScheduleException } from '../types';
import { getScheduleConflictReason } from '../utils/workshopSchedule';
import { findTeacherOverlaps } from '../utils/scheduleOverlap';
import { formatDate, formatTime } from '../utils/dateFormat';
import { presentPersonName } from '../utils/displayName';
import { compareEs } from '../utils/textSearch';
import { ConfirmModal } from './shared/ConfirmModal';
import DateField from './shared/DateField';
import TimeField from './shared/TimeField';

export default function SessionDetailsDialog({ session, mode, sessions = [], teachers, schedule, exceptions, readOnly, onSave, onClose }: {
  session: ClassSession; mode: 'teacher' | 'schedule'; sessions?: ClassSession[]; teachers: Teacher[]; schedule: WorkshopScheduleDay[]; exceptions: WorkshopScheduleException[]; readOnly: boolean;
  onSave: (id: string, updates: Partial<ClassSession>) => Promise<boolean | void>; onClose: () => void;
}) {
  const [form, setForm] = useState({ teacherId: session.teacherId || '', date: session.date, startTime: session.startTime, endTime: session.endTime });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const frozen = useRef<Partial<ClassSession> | null>(null);
  const [locked, setLocked] = useState(false); const busyRef = useRef(false);
  const [overlapText, setOverlapText] = useState('');
  const overlapAck = useRef(false);
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !overlapText) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, overlapText, onClose]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (busyRef.current || readOnly) return;
    if (!frozen.current) {
      if (!Number.isSafeInteger(session.revision)) { setError('Recarga la sesión antes de guardar.'); return; }
      if (mode === 'teacher' && !form.teacherId) { setError('Seleccione un profesor.'); return; }
      if (mode === 'schedule') {
        if (!form.date || !form.startTime || !form.endTime || form.startTime >= form.endTime) { setError('Indica una fecha y un horario válidos.'); return; }
        const changed = form.date !== session.date || form.startTime !== session.startTime || form.endTime !== session.endTime;
        const conflict = changed && getScheduleConflictReason({ ...session, ...form }, schedule, exceptions);
        if (conflict) { setError(conflict + '. Revisa el horario del taller.'); return; }
        const hits = findTeacherOverlaps({
          id: session.id, date: form.date, startTime: form.startTime, endTime: form.endTime,
          teacherId: session.teacherId, teacherSubstituteId: session.teacherSubstituteId,
          blockTeacherIds: (session.activityBlocks || []).map(block => block.teacherId).filter((id): id is string => !!id),
          label: 'Este horario'
        }, sessions.filter(item => item.id !== session.id && item.classType !== 'feriado').map(item => ({
          id: item.id, date: item.date, startTime: item.startTime, endTime: item.endTime,
          teacherId: item.teacherId, teacherSubstituteId: item.teacherSubstituteId,
          blockTeacherIds: (item.activityBlocks || []).map(block => block.teacherId).filter((id): id is string => !!id),
          label: `${formatTime(item.startTime)}–${formatTime(item.endTime)}`
        })));
        if (hits.length && !overlapAck.current) {
          setOverlapText(hits.map(hit => hit.label).join(', '));
          return;
        }
      }
      frozen.current = Object.freeze(mode === 'teacher' ? { teacherId: form.teacherId, revision: session.revision } : { date: form.date, startTime: form.startTime, endTime: form.endTime, revision: session.revision });
      setLocked(true);
    }
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await onSave(session.id, frozen.current);
      if (result === false) throw new Error('No se confirmó el guardado. Reintenta los mismos datos.');
      onClose();
    } catch (e: any) { setError(e.message || 'No se pudo confirmar el guardado. Reintenta los mismos datos.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const inputClass = 'mt-1 w-full rounded-lg border border-neutral-border bg-white px-3 py-2.5 text-sm text-neutral-textMain';
  return <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={mode === 'teacher' ? 'Asignar profesor' : 'Cambiar horario'}>
    <form noValidate onSubmit={submit} className="w-full max-w-md rounded-2xl border border-neutral-border bg-white p-5 shadow-xl">
      <h2 className="text-lg font-semibold text-neutral-textMain">{mode === 'teacher' ? 'Asignar profesor' : 'Cambiar horario'}</h2>
      <p className="my-3 text-sm text-neutral-textHelper">{formatDate(session.date)} · {formatTime(session.startTime)}–{formatTime(session.endTime)}. Los alumnos, el saldo y la asistencia se conservan.</p>
      <fieldset disabled={readOnly || busy || locked} className="space-y-3">
        {mode === 'teacher' ? <label className="block text-sm">Profesor *<select required value={form.teacherId} onChange={e => setForm({ ...form, teacherId: e.target.value })} className={inputClass}><option value="">Seleccione un profesor</option>{[...teachers].sort((a, b) => compareEs(presentPersonName(a.name, a.surname), presentPersonName(b.name, b.surname))).map(teacher => <option key={teacher.id} value={teacher.id}>{presentPersonName(teacher.name, teacher.surname)}</option>)}</select></label> : <>
          <label className="block text-sm">Fecha<DateField required aria-label="Fecha" value={form.date} onChange={date => setForm({ ...form, date })} className={inputClass}/></label>
          <div className="grid grid-cols-2 gap-3"><label className="text-sm">Inicio<TimeField required aria-label="Inicio" value={form.startTime} onChange={startTime => setForm({ ...form, startTime })} className={inputClass}/></label><label className="text-sm">Fin<TimeField required aria-label="Fin" value={form.endTime} onChange={endTime => setForm({ ...form, endTime })} className={inputClass}/></label></div>
        </>}
      </fieldset>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><button disabled={busy} type="button" onClick={onClose} className="min-h-10 rounded-lg border border-neutral-border px-3 text-sm">{locked ? 'Cerrar y conservar intento' : 'Cancelar'}</button><button disabled={busy || readOnly} type="submit" className="min-h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white">{busy ? 'Guardando…' : locked ? 'Reintentar el mismo guardado' : 'Guardar'}</button></div>
    </form>
    <ConfirmModal isOpen={!!overlapText} title="El profesor ya tiene clase" message={`Ese horario coincide con: ${overlapText}.`} confirmText="Guardar de todos modos" isDestructive={false} onCancel={() => { overlapAck.current = false; setOverlapText(''); }} onConfirm={() => { overlapAck.current = true; setOverlapText(''); void submit({ preventDefault() {} } as React.FormEvent); }} />
  </div>;
}
