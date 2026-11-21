import { showError, showWarning } from '../context/toast';
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Teacher, ClassSession } from '../types';
import { AdvancedDetails } from './shared/AdvancedDetails';
import { ConfirmModal } from './shared/ConfirmModal';
import { DangerZone } from './shared/DangerZone';
import { EmptyState } from './shared/EmptyState';
import { activityTypeLabel, sessionTypeLabel } from '../utils/classTypeLabels';
import { pluralize } from '../utils/pluralize';
import { teacherBlockActivities, teacherSessions } from '../utils/teacherCalendar';
import { formatDate, formatTime } from '../utils/dateFormat';

interface TeachersViewProps {
  teachers: Teacher[];
  sessions: ClassSession[];
  onAddTeacher: (teacher: Omit<Teacher, 'id'>) => Promise<void>;
  onUpdateTeacher: (id: string, updates: Partial<Teacher>) => Promise<void>;
  onDeleteTeacher: (id: string) => Promise<void>;
}

const TeachersView: React.FC<TeachersViewProps> = ({ teachers, sessions, onAddTeacher, onUpdateTeacher, onDeleteTeacher }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const [form, setForm] = useState({
    name: '',
    surname: '',
    specialty: '',
    email: '',
    phone: '',
    notes: ''
  });
  const [teacherToDelete, setTeacherToDelete] = useState<string | null>(null);
  const [expandedTeacherId, setExpandedTeacherId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const filteredTeachers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return teachers;
    return teachers.filter(t => {
      const full = `${t.name} ${t.surname || ''}`.toLowerCase();
      return full.includes(query) || (t.specialty || '').toLowerCase().includes(query);
    });
  }, [teachers, searchQuery]);

  const getTeacherName = (teacherId?: string) => {
    if (!teacherId) return 'Sin profesor';
    const teacher = teachers.find(t => t.id === teacherId);
    if (!teacher) return 'Sin profesor';
    return `${teacher.name} ${teacher.surname || ''}`.trim();
  };

  const formatSessionDate = (dateValue: string) => formatDate(dateValue, 'long');

  const handleOpenNew = () => {
    setEditingTeacher(null);
    setForm({ name: '', surname: '', specialty: '', email: '', phone: '', notes: '' });
    setShowModal(true);
  };

  const handleOpenEdit = (teacher: Teacher) => {
    setEditingTeacher(teacher);
    setForm({
      name: teacher.name,
      surname: teacher.surname || '',
      specialty: teacher.specialty || '',
      email: teacher.email || '',
      phone: teacher.phone || '',
      notes: teacher.notes || ''
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.name.trim()) {
      showError('El nombre es obligatorio.');
      return;
    }
    setIsSubmitting(true);
    // CRITICAL FIX: send empty strings (not undefined) for optional fields.
    // DataContext.updateTeacher converts '' to null so Supabase clears old values.
    const payload = {
      name: form.name.trim(),
      surname: form.surname.trim(),
      specialty: form.specialty.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      notes: form.notes.trim()
    };
    try {
      if (editingTeacher) await onUpdateTeacher(editingTeacher.id, payload);
      else await onAddTeacher(payload);
      setShowModal(false);
    } catch (error: any) {
      showError(error?.message || 'No se pudo guardar. Revisa los datos e inténtalo de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const teacherPendingName = (() => {
    const teacher = teachers.find(item => item.id === teacherToDelete);
    return teacher ? `${teacher.name} ${teacher.surname || ''}`.trim() : 'este profesor';
  })();

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-neutral-base">
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 md:px-8 lg:px-10 pt-4 md:pt-6 pb-20">
        <header className="mb-5 animate-fade-in">
          <div className="flex items-end justify-between gap-4 mb-4">
            <div>
              <p className="eyebrow mb-1">Equipo del estudio</p>
               <h1 className="ui-page-title text-neutral-textMain">Profesores</h1>
               <p className="ui-secondary mt-1">Especialidades, contacto, clases programadas e historial.</p>
            </div>
            <button onClick={handleOpenNew} className="min-h-[40px] px-4 py-2 bg-brand text-white rounded-[10px] text-[13px] font-semibold inline-flex items-center justify-center gap-2 hover:bg-brand-hover active:scale-[0.98] transition-all shrink-0"><span className="text-lg leading-none">+</span><span className="hidden sm:inline">Nuevo profesor</span><span className="sm:hidden">Nuevo</span></button>
          </div>
          <input
            type="text"
            placeholder="Buscar por nombre o especialidad..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
          />
        </header>

        <section className="bg-white border border-neutral-border rounded-2xl overflow-hidden animate-fade-in">
           <div className="hidden md:grid grid-cols-[minmax(220px,1.5fr)_minmax(150px,1fr)_minmax(180px,1.1fr)_128px_minmax(220px,260px)] gap-4 px-4 py-3 bg-neutral-sec border-b border-neutral-border text-[13px] font-semibold text-neutral-textSec">
            <span>Profesor</span><span>Especialidad</span><span>Contacto</span><span>Clases</span><span>Acciones</span>
          </div>
          {filteredTeachers.length === 0 ? (
            <EmptyState
              title={searchQuery.trim() ? 'Ningún profesor coincide con la búsqueda' : 'Todavía no hay profesores'}
              body={searchQuery.trim() ? 'Prueba con otro nombre o especialidad, o limpia la búsqueda.' : 'Añade quien da clase para asignarlo en el calendario.'}
              actionLabel={searchQuery.trim() ? undefined : 'Añadir el primer profesor'}
              onAction={searchQuery.trim() ? undefined : handleOpenNew}
            />
          ) : filteredTeachers.map(teacher => {
            const fullName = `${teacher.name} ${teacher.surname || ''}`.trim();
            const scheduledSessions = teacherSessions(sessions, teacher.id, false);
            const concludedSessions = teacherSessions(sessions, teacher.id, true);
            const isExpanded = expandedTeacherId === teacher.id;
            const calendarHref = `/calendar?teacher=${encodeURIComponent(teacher.id)}`;
            const studentLabel = (count: number) => pluralize(count, 'alumno', 'alumnos');
            return (
              <React.Fragment key={teacher.id}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(220px,1.5fr)_minmax(150px,1fr)_minmax(180px,1.1fr)_128px_minmax(220px,260px)] gap-3 md:gap-4 items-center px-3 md:px-4 py-3 border-b border-neutral-border hover:bg-neutral-base transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-brand-soft text-brand flex items-center justify-center font-bold text-[12px] shrink-0">{teacher.name.charAt(0)}</div>
                     <div className="min-w-0"><h3 className="ui-card-title text-neutral-textMain truncate">{fullName}</h3><p className="ui-meta truncate mt-0.5">{teacher.specialty || 'Sin especialidad'}{(teacher.phone || teacher.email) ? ` · ${teacher.phone || teacher.email}` : ''}</p></div>
                  </div>
                  <span className="hidden md:inline-flex justify-self-start px-2 py-1 rounded-md bg-neutral-sec text-neutral-textSec text-[12px] font-semibold truncate max-w-full">{teacher.specialty || 'Sin especialidad'}</span>
                   <div className="hidden md:block min-w-0 ui-data text-neutral-textSec truncate">{teacher.email || teacher.phone || 'Sin contacto'}</div>
                  <span className="justify-self-end md:justify-self-start text-[14px] font-semibold text-neutral-textMain leading-tight">
                    <span className="block">{pluralize(scheduledSessions.length, 'programada', 'programadas')}</span>
                    <span className="block text-[14px] font-medium text-neutral-textSec">{pluralize(concludedSessions.length, 'concluida', 'concluidas')}</span>
                  </span>
                  <div className="col-span-2 md:col-span-1 flex flex-wrap items-center justify-end gap-2 pt-2 md:pt-0 border-t border-neutral-border md:border-0">
                     <Link to={calendarHref} className="min-h-[32px] px-2.5 py-1.5 rounded-[8px] border border-neutral-border bg-white text-[12px] font-semibold text-neutral-textMain transition-colors hover:border-arena hover:text-brand" aria-label={`Calendario de ${fullName}`}>Calendario</Link>
                     <button type="button" aria-expanded={isExpanded} onClick={() => setExpandedTeacherId(isExpanded ? null : teacher.id)} className="min-h-[32px] px-2.5 py-1.5 rounded-[8px] text-[12px] font-semibold text-neutral-textSec border border-neutral-border hover:border-arena hover:text-brand transition-colors">Historial</button>
                     <button onClick={() => handleOpenEdit(teacher)} className="min-h-[32px] px-2.5 py-1.5 rounded-[8px] border border-neutral-border bg-white text-[12px] font-semibold text-neutral-textMain transition-colors hover:border-arena hover:text-brand">Editar</button>
                  </div>
                </div>
                {isExpanded && (
<div className="px-4 md:px-6 py-3 bg-neutral-sec border-b border-neutral-border animate-fade-in space-y-4">
                    <div>
                      <p className="text-[14px] font-semibold text-neutral-textSec mb-2">Clases programadas</p>
                      {scheduledSessions.length === 0 ? (
                        <p className="text-[14px] text-neutral-textSec">Sin clases programadas</p>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          {scheduledSessions.slice(0, 6).map(session => {
                            const blocks = teacherBlockActivities(session, teacher.id);
                            const isSub = session.teacherSubstituteId === teacher.id && session.teacherId !== teacher.id;
                            return (
                              <Link key={session.id} to={`${calendarHref}&date=${session.date}&sessionId=${encodeURIComponent(session.id)}`} className="p-3 bg-white rounded-xl border border-neutral-border hover:border-brand/40">
                                <p className="text-[13px] font-semibold text-neutral-textMain">{formatSessionDate(session.date)} · {formatTime(session.startTime)} - {formatTime(session.endTime)}</p>
                                <p className="text-[14px] text-neutral-textSec mt-1">{sessionTypeLabel(session.classType)}{blocks.length ? ` · ${blocks.map(activityTypeLabel).join(', ')}` : ''} · {studentLabel(session.students.length)}</p>
                                {isSub && <p className="text-[13px] font-semibold text-brand mt-1">Reemplazo de {getTeacherName(session.teacherId)}</p>}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                      {scheduledSessions.length > 6 && <Link to={calendarHref} className="mt-2 inline-block text-[13px] font-semibold text-brand">Ver las {scheduledSessions.length} en el calendario</Link>}
                    </div>
                    <div>
                      <p className="text-[14px] font-semibold text-neutral-textSec mb-2">Historial de clases concluidas</p>
                      {concludedSessions.length === 0 ? (
                        <p className="text-[14px] text-neutral-textSec">Sin clases concluidas</p>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          {concludedSessions.slice(0, 3).map(session => {
                            const blocks = teacherBlockActivities(session, teacher.id);
                            const isSub = session.teacherSubstituteId === teacher.id && session.teacherId !== teacher.id;
                            return <div key={session.id} className="p-3 bg-white rounded-xl border border-neutral-border"><p className="text-[13px] font-semibold text-neutral-textMain">{formatSessionDate(session.date)} · {formatTime(session.startTime)} - {formatTime(session.endTime)}</p><p className="text-[14px] text-neutral-textSec mt-1">{sessionTypeLabel(session.classType)}{blocks.length ? ` · ${blocks.map(activityTypeLabel).join(', ')}` : ''} · {studentLabel(session.students.length)}</p>{isSub && <p className="text-[13px] font-semibold text-brand mt-1">Reemplazo de {getTeacherName(session.teacherId)}</p>}</div>;
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </section>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[120] flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="teacher-dialog-title" className="bg-white w-full max-w-2xl rounded-2xl p-4 md:p-6 soft-shadow relative animate-fade-in border border-neutral-border max-h-[calc(100dvh-2rem)] overflow-y-auto custom-scrollbar">
             <h3 id="teacher-dialog-title" className="ui-section-title text-neutral-textMain mb-5">
              {editingTeacher ? 'Editar profesor' : 'Nuevo profesor'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Nombre"
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
                />
                <input
                  value={form.surname}
                  onChange={(e) => setForm({ ...form, surname: e.target.value })}
                  placeholder="Apellido"
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
                />
              </div>
              <input
                value={form.specialty}
                onChange={(e) => setForm({ ...form, specialty: e.target.value })}
                placeholder="Especialidad"
                className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="Email"
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
                />
                <input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="Teléfono"
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
                />
              </div>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Notas"
                className="w-full min-h-[120px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper resize-none"
              />
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] text-[14px] font-semibold hover:bg-brand-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {isSubmitting ? 'Guardando...' : 'Guardar'}
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => setShowModal(false)}
                  className="min-h-[44px] px-4 py-2.5 border border-neutral-border bg-white rounded-[10px] text-[14px] font-semibold text-neutral-textSec hover:border-arena transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Cancelar
                </button>
              </div>
            </form>
            {editingTeacher && <AdvancedDetails><p>Identificador del profesor: {editingTeacher.id}</p></AdvancedDetails>}
            {editingTeacher && (
              <DangerZone
                description={`Eliminar a ${`${editingTeacher.name} ${editingTeacher.surname || ''}`.trim()} borra su ficha. Las clases ya concluidas conservan el nombre, pero dejan de estar vinculadas.`}
                actionLabel="Eliminar profesor"
                onAction={() => setTeacherToDelete(editingTeacher.id)}
              />
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!teacherToDelete}
        title={`¿Eliminar a ${teacherPendingName}?`}
        message="Esta acción no se puede deshacer. Las clases concluidas seguirán mostrando su nombre, pero se desvincularán de su perfil."
        isDestructive={true}
        onConfirm={() => {
          if (teacherToDelete) {
            const id = teacherToDelete;
            setTeacherToDelete(null);
            onDeleteTeacher(id);
          }
        }}
        onCancel={() => setTeacherToDelete(null)}
      />
    </div>
  );
};

export default TeachersView;
