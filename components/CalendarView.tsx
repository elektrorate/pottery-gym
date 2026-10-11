import { showError, showWarning } from '../context/toast';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ClassSession, GiftCard, Student, Teacher, WorkshopScheduleDay, WorkshopScheduleException, WorkshopCapacityDefault, getDefaultSessionCapacity } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';
import { getStudentLifecycle, isStudentArchived } from '../utils/studentLifecycle';
import { useWorkshopDate } from '../utils/useWorkshopDate';
import { capacityDefaultsToMap, getSessionOccupancy } from '../utils/sessionCapacity';
import { getScheduleConflictReason, madridDateKey } from '../utils/workshopSchedule';
interface CalendarViewProps {
  sessions: ClassSession[];
  onAddSession: (session: Omit<ClassSession, 'id'>) => Promise<void>;
  onUpdateSession: (id: string, updates: Partial<ClassSession>) => Promise<boolean | void>;
  onDeleteSession: (id: string) => Promise<void>;
  onUpdateStudent: (id: string, updates: Partial<Student>) => Promise<void>;
  onRedeemGiftCardSession: (giftCardId: string, sessionId: string, studentId?: string) => Promise<void>;
  onReverseGiftCardSession: (giftCardId: string | undefined, sessionId: string, studentId?: string) => Promise<boolean | void>;
  giftCards: GiftCard[];
  students: Student[];
  teachers: Teacher[];
  workshopSchedule: WorkshopScheduleDay[];
  workshopScheduleExceptions: WorkshopScheduleException[];
  capacityDefaults: WorkshopCapacityDefault[];
}

type CalendarMode = 'day' | 'month';
type AttendanceStatus = 'present' | 'absent' | 'pending';

const getAttendanceStatus = (attendance: ClassSession['attendance'] | undefined, studentName: string): AttendanceStatus => {
  const directStatus = attendance?.[studentName];
  if (directStatus) return directStatus;
  const matchingEntry = Object.entries(attendance || {}).find(([name]) => name.toUpperCase() === studentName.toUpperCase());
  return matchingEntry?.[1] || 'pending';
};

const CalendarView: React.FC<CalendarViewProps> = ({ sessions, onAddSession, onUpdateSession, onDeleteSession, onUpdateStudent, onRedeemGiftCardSession, onReverseGiftCardSession, giftCards, students, teachers, workshopSchedule, workshopScheduleExceptions, capacityDefaults }) => {
  const capacityMap = useMemo(() => capacityDefaultsToMap(capacityDefaults), [capacityDefaults]);
  const getSessionCapacity = (classType: ClassSession['classType']) => getDefaultSessionCapacity(classType, capacityMap);
  const location = useLocation();
  const deepLinkHandledRef = useRef('');
  const [viewMode, setViewMode] = useState<CalendarMode>('day');
  const today = useWorkshopDate();
  const [selectedDate, setSelectedDate] = useState(new Date());

  // Modales separados
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [attendanceSession, setAttendanceSession] = useState<ClassSession | null>(null);
  const [isEditingAttendance, setIsEditingAttendance] = useState(false);
  const [attendanceEditBaseline, setAttendanceEditBaseline] = useState<{ attendance: ClassSession['attendance']; substituteId: string } | null>(null);
  const [substituteId, setSubstituteId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [noBonosNames, setNoBonosNames] = useState<string[]>([]);
  const [studentSearchQuery, setStudentSearchQuery] = useState('');

  const HOUR_HEIGHT = 140;

  const [sessionForm, setSessionForm] = useState({
    date: '',
    startTime: '10:00',
    endTime: '12:00',
    classType: 'mesa' as ClassSession['classType'],
    capacity: getSessionCapacity('mesa'),
    selectedStudents: [] as string[],
    teacherId: '',
    workshopName: '',
    privateReason: '',
    sessionAudience: 'membresia' as 'membresia' | 'temporal' | 'ambos'
  });

  const getGiftCardIdForStudent = (session: ClassSession, student?: Student, forReverse = false) => {
    if (!student) return undefined;
    const today = madridDateKey();
    const isUsable = (card: GiftCard) => card.status === 'active'
      && !card.consumedAt
      && (card.sessionsRemaining || 0) > 0
      && (!card.expiryDate || card.expiryDate.slice(0, 10) >= today);
    const linkedId = session.giftCardIdByStudentId?.[student.id];
    const linkedCard = linkedId ? giftCards.find(card => card.id === linkedId) : undefined;
    if (linkedId && forReverse && linkedCard?.status !== 'cancelled') return linkedId;
    if (linkedId && linkedCard && isUsable(linkedCard)) return linkedId;
    return giftCards.find(card => card.recipientStudentId === student.id
      && (forReverse ? (card.status !== 'cancelled' && (card.sessionsUsed || 0) > 0) : isUsable(card)))?.id;
  };

  const formatDateKey = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const formatSessionDate = (dateValue: string) => {
    const parts = dateValue.split('-').map(Number);
    if (parts.length === 3 && parts.every(n => Number.isFinite(n))) {
      const [year, month, day] = parts;
      return new Date(year, month - 1, day).toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      });
    }
    return new Date(dateValue).toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
  };

  const getTeacherName = (teacherId?: string) => {
    if (!teacherId) return 'Sin profesor';
    const teacher = teachers.find(t => t.id === teacherId);
    if (!teacher) return 'Sin profesor';
    return `${teacher.name} ${teacher.surname || ''}`.trim();
  };

  const getTeacherSpecialty = (teacherId?: string) => {
    if (!teacherId) return '';
    const teacher = teachers.find(t => t.id === teacherId);
    return teacher?.specialty || '';
  };

  const getSessionLabel = (session: ClassSession) => {
    const map: Record<ClassSession['classType'], string> = {
      mesa: 'Mesa',
      torno: 'Torno',
      coworking: 'Coworking',
      workshop: 'Workshop',
      privada: 'Privadas',
      feriado: 'Feriados'
    };
    return map[session.classType];
  };

  const requiresTeacher = (type: ClassSession['classType']) => type === 'mesa';
  const requiresWorkshopName = (type: ClassSession['classType']) => type === 'workshop';
  const requiresPrivateReason = (type: ClassSession['classType']) => type === 'privada';

  const getSessionBadgeClasses = (type: ClassSession['classType']) => {
    switch (type) {
      case 'torno':
        return 'bg-[#20663B]';
      case 'coworking':
        return 'bg-green-500';
      case 'workshop':
        return 'bg-brand';
      case 'privada':
        return 'bg-orange-500';
      case 'feriado':
        return 'bg-neutral-textHelper';
      default:
        return 'bg-brand';
    }
  };

  // Abrir modal de Edición/Creación de Sesión
  const handleOpenSessionModal = (session?: ClassSession) => {
    setStudentSearchQuery(''); // Limpiar búsqueda al abrir modal
    if (session) {
      setEditingSessionId(session.id);
      setSessionForm({
        date: session.date,
        startTime: session.startTime,
        endTime: session.endTime,
        classType: session.classType,
        capacity: session.capacity ?? getSessionCapacity(session.classType),
        selectedStudents: [...session.students],
        teacherId: session.teacherId || '',
        workshopName: session.workshopName || '',
        privateReason: session.privateReason || '',
        sessionAudience: session.sessionAudience || 'membresia'
      });
    } else {
      setEditingSessionId(null);
      setSessionForm({
        date: formatDateKey(selectedDate),
        startTime: '10:00',
        endTime: '12:00',
        classType: 'mesa',
        capacity: getSessionCapacity('mesa'),
        selectedStudents: [],
        teacherId: '',
        workshopName: '',
        privateReason: '',
        sessionAudience: 'membresia'
      });
    }
    setShowSessionModal(true);
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedDate = params.get('date');
    const requestedSessionId = params.get('sessionId');
    if (!requestedDate && !requestedSessionId) return;
    const deepLinkKey = `${requestedDate || ''}:${requestedSessionId || ''}`;
    if (deepLinkHandledRef.current === deepLinkKey) return;
    if (requestedDate) setSelectedDate(new Date(`${requestedDate}T12:00:00`));
    if (requestedSessionId) {
      const requestedSession = sessions.find(session => session.id === requestedSessionId);
      if (!requestedSession) return;
      handleOpenSessionModal(requestedSession);
    }
    deepLinkHandledRef.current = deepLinkKey;
  }, [location.search, sessions]);

  // Abrir modal de Control de Asistencia (Nueva funcionalidad separada)
  const handleOpenAttendanceModal = (session: ClassSession) => {
    setAttendanceSession(session);
    setIsEditingAttendance(false);
    setAttendanceEditBaseline(null);
    setSubstituteId(session.teacherSubstituteId || '');
    setShowAttendanceModal(true);
  };

  const beginAttendanceEdit = () => {
    if (!attendanceSession) return;
    setAttendanceEditBaseline({
      attendance: { ...(attendanceSession.attendance || {}) },
      substituteId: substituteId
    });
    setIsEditingAttendance(true);
  };

  const cancelAttendanceEdit = () => {
    if (attendanceEditBaseline) {
      setAttendanceSession(prev => prev ? {
        ...prev,
        attendance: attendanceEditBaseline.attendance,
        teacherSubstituteId: attendanceEditBaseline.substituteId || undefined
      } : prev);
      setSubstituteId(attendanceEditBaseline.substituteId);
    }
    setIsEditingAttendance(false);
    setAttendanceEditBaseline(null);
  };

  const saveEditedAttendance = async () => {
    if (!attendanceSession || !attendanceEditBaseline || isSubmitting) return;
    const previousAttendance = attendanceEditBaseline.attendance || {};
    const nextAttendance = attendanceSession.attendance || {};

    setIsSubmitting(true);
    try {
      for (const studentName of attendanceSession.students) {
        const previousStatus = getAttendanceStatus(previousAttendance, studentName);
        const nextStatus = getAttendanceStatus(nextAttendance, studentName);
        if (previousStatus === nextStatus) continue;

        const student = students.find(item => {
          const fullName = `${item.name} ${item.surname || ''}`.trim().toUpperCase();
          return fullName === studentName.toUpperCase() || item.name.toUpperCase() === studentName.toUpperCase();
        });
        const category = student?.studentCategory || 'membresia';
        if (!student || (category !== 'membresia' && category !== 'temporal')) continue;

        const wasPresent = previousStatus === 'present';
        const isPresent = nextStatus === 'present';
        if (wasPresent === isPresent) continue;

        const giftCardId = getGiftCardIdForStudent(attendanceSession, student, wasPresent && !isPresent);
        if (wasPresent && !isPresent) {
          const reversed = await onReverseGiftCardSession(giftCardId, attendanceSession.id, student.id);
          if (reversed) continue;
        } else if (!wasPresent && isPresent && giftCardId) {
          await onRedeemGiftCardSession(giftCardId, attendanceSession.id, student.id);
          continue;
        }

        const maxBonuses = student.bonosAsignados ?? (category === 'temporal' ? 3 : 4);
        const nextClassesRemaining = isPresent
          ? Math.max(0, student.classesRemaining - 1)
          : Math.min(maxBonuses, student.classesRemaining + 1);
        const updates: Partial<Student> = { classesRemaining: nextClassesRemaining };

        await onUpdateStudent(student.id, updates);
      }

      await onUpdateSession(attendanceSession.id, {
        attendance: nextAttendance,
        teacherSubstituteId: substituteId
      });
      setAttendanceSession(prev => prev ? {
        ...prev,
        attendance: nextAttendance,
        teacherSubstituteId: substituteId || undefined
      } : prev);
      setIsEditingAttendance(false);
      setAttendanceEditBaseline(null);
      setShowAttendanceModal(false);
    } catch (err: any) {
      console.error('Error editando control de asistencia:', err);
      showError(`No se pudo guardar la corrección. ${err?.message || 'Error de conexión. Intenta de nuevo.'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const finalizeAttendance = async (allowNoBonos = false) => {
    if (!attendanceSession) return;
    if (attendanceSession.completedAt) {
      showError('Esta sesión ya fue finalizada.');
      return;
    }

    const finalAttendance = attendanceSession.attendance || {};

    // Check for membership students with 0 bonos
    const presentStudentNames = Object.entries(finalAttendance)
      .filter(([, status]) => status === 'present')
      .map(([name]) => name);

    const studentsWithNoBonos = presentStudentNames.filter(studentName => {
      const student = students.find(s => {
        const fullName = `${s.name} ${s.surname || ''}`.trim().toUpperCase();
        return fullName === studentName.toUpperCase() || fullName === studentName;
      });
      if (getGiftCardIdForStudent(attendanceSession, student)) return false;
      const category = student?.studentCategory || 'membresia';
      return student && (category === 'membresia' || category === 'temporal') && student.classesRemaining <= 0;
    });

    if (studentsWithNoBonos.length > 0) {
      if (!allowNoBonos) {
        setNoBonosNames(studentsWithNoBonos);
        return;
      }
    }

    setIsSubmitting(true);
    const completedAt = new Date().toISOString();

    try {
      // Student updates share an operation lock, so they must be persisted in sequence.
      // Present membership and temporary students consume one bonus.
      for (const studentName of presentStudentNames) {
        const student = students.find(s => {
          const fullName = `${s.name} ${s.surname || ''}`.trim().toUpperCase();
          return fullName === studentName.toUpperCase();
        });

        const category = student?.studentCategory || 'membresia';
        const giftCardId = getGiftCardIdForStudent(attendanceSession, student);
        if (giftCardId) {
          await onRedeemGiftCardSession(giftCardId, attendanceSession.id, student?.id);
          continue;
        }
        if (student && !isStudentArchived(student) && (category === 'membresia' || category === 'temporal') && student.classesRemaining > 0) {
          const nextClassesRemaining = student.classesRemaining - 1;
          const updates: Partial<Student> = {
            classesRemaining: nextClassesRemaining
          };
          await onUpdateStudent(student.id, {
            ...updates
          });
        }
      }

      await onUpdateSession(attendanceSession.id, {
        completedAt,
        attendance: finalAttendance,
        teacherSubstituteId: substituteId
      });

      setAttendanceSession(prev => prev ? { ...prev, completedAt, attendance: finalAttendance, teacherSubstituteId: substituteId || undefined } : prev);
      setIsEditingAttendance(false);
      setAttendanceEditBaseline(null);
      setShowAttendanceModal(false);
    } catch (err: any) {
      console.error('Error finalizando control de asistencia:', err);
      showError(`No se pudo finalizar el control de asistencia. ${err?.message || 'Error de conexión. Intenta de nuevo.'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ★ handleMarkAttendance: ONLY updates local state, does NOT call API
  // The actual save happens in finalizeAttendance to prevent race conditions
  const handleMarkAttendance = (studentName: string, status: 'present' | 'absent' | 'pending') => {
    if (!attendanceSession) return;

    const currentAttendance = { ...(attendanceSession.attendance || {}) };

    if (status === 'pending') {
      delete currentAttendance[studentName];
    } else {
      currentAttendance[studentName] = status;
    }

    const updatedSession = { ...attendanceSession, attendance: currentAttendance };
    setAttendanceSession(updatedSession); // Local state only — saved on finalize
  };

  const handleSessionSubmit = async () => {
    if (isSubmitting) return;
    if (!sessionForm.date) {
      showError("Selecciona un día en el calendario antes de guardar.");
      return;
    }
    if (requiresTeacher(sessionForm.classType) && !sessionForm.teacherId) {
      showError("Debes asignar un profesor.");
      return;
    }
    if (requiresWorkshopName(sessionForm.classType) && !sessionForm.workshopName.trim()) {
      showError("Debes indicar el nombre del workshop.");
      return;
    }
    if (requiresPrivateReason(sessionForm.classType) && !sessionForm.privateReason.trim()) {
      showError("Debes indicar el motivo de la sesion privada.");
      return;
    }
    if (sessionForm.startTime >= sessionForm.endTime) {
      showError("La hora de inicio debe ser anterior a la hora de fin.");
      return;
    }
    const capacity = Math.max(1, Math.min(100, Number(sessionForm.capacity) || 0));
    if (!capacity) {
      showError("Indica una capacidad válida para la sesión.");
      return;
    }
    if (sessionForm.selectedStudents.length > capacity) {
      showError(`La sesión admite como máximo ${capacity} alumnos.`);
      return;
    }
    if ((workshopSchedule.length > 0 || workshopScheduleExceptions.length > 0) && sessionForm.classType !== 'feriado') {
      const conflictReason = getScheduleConflictReason(
        { date: sessionForm.date, startTime: sessionForm.startTime, endTime: sessionForm.endTime, classType: sessionForm.classType },
        workshopSchedule,
        workshopScheduleExceptions
      );
      if (conflictReason) {
        showError(`${conflictReason}. Ajusta la sesión o cambia la disponibilidad desde Administración del taller.`);
        return;
      }
    }
    const duplicate = sessions.some(s => {
      if (editingSessionId && s.id === editingSessionId) return false;
      return s.date === sessionForm.date
        && s.startTime === sessionForm.startTime
        && s.endTime === sessionForm.endTime
        && s.classType === sessionForm.classType;
    });
    if (duplicate) {
      showError("Ya existe una sesión con el mismo horario y tipo.");
      return;
    }
    setIsSubmitting(true);
    const payload = {
      date: sessionForm.date,
      startTime: sessionForm.startTime,
      endTime: sessionForm.endTime,
      classType: sessionForm.classType,
      capacity,
      students: sessionForm.classType === 'feriado' ? [] : sessionForm.selectedStudents,
      teacherId: sessionForm.teacherId || undefined,
      workshopName: sessionForm.workshopName.trim() || undefined,
      privateReason: sessionForm.privateReason.trim() || undefined,
      sessionAudience: sessionForm.sessionAudience
    };
    // Close modal immediately — Supabase operations run in background
    setShowSessionModal(false);
    setIsSubmitting(false);
    if (editingSessionId) {
      onUpdateSession(editingSessionId, payload);
    } else {
      onAddSession(payload);
    }
  };

  const weekDays = useMemo(() => {
    const start = new Date(selectedDate);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [selectedDate]);

  const monthDays = useMemo(() => {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1;
    const days = [];
    for (let i = startOffset - 1; i >= 0; i--) days.push({ date: new Date(year, month, 1 - i - 1), currentMonth: false });
    for (let i = 1; i <= daysInMonth; i++) days.push({ date: new Date(year, month, i), currentMonth: true });
    while (days.length < 42) days.push({ date: new Date(year, month, daysInMonth + days.length - (daysInMonth + startOffset) + 1), currentMonth: false });
    return days;
  }, [selectedDate]);

  const sessionsByDate = useMemo(() => {
    const map: Record<string, ClassSession[]> = {};
    sessions.forEach(session => {
      if (!map[session.date]) map[session.date] = [];
      map[session.date].push(session);
    });
    return map;
  }, [sessions]);

  const getMonthlyDensity = (daySessions: ClassSession[]) => {
    if (daySessions.length === 0) return 'low' as const;
    if (daySessions.some(session => session.classType === 'feriado')) return 'full' as const;

    const capacity = daySessions.reduce((total, session) => total + getSessionCapacity(session.classType), 0);
    const occupied = daySessions.reduce((total, session) => total + new Set(session.students.map((student, index) => session.studentIds?.[index] || student.toUpperCase())).size, 0);
    const occupancy = capacity > 0 ? occupied / capacity : 0;

    if (occupancy >= 0.9 || daySessions.length >= 4) return 'full' as const;
    if (occupancy >= 0.55 || daySessions.length >= 3) return 'high' as const;
    return 'medium' as const;
  };

  const getMonthlyCalendarClass = (daySessions: ClassSession[]) => {
    if (daySessions.some(session => session.classType === 'feriado')) return 'full' as const;

    const hasTorno = daySessions.some(session => session.classType === 'torno');
    const hasOtherSession = daySessions.some(session => session.classType !== 'torno');

    if (hasTorno && hasOtherSession) return 'mixed' as const;
    if (hasTorno) return 'torno' as const;
    return getMonthlyDensity(daySessions);
  };

  const renderDayView = () => {
    const dateKey = formatDateKey(selectedDate);
    const daySessions = sessions.filter(s => s.date === dateKey);
    const dayLabel = selectedDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const dayTitle = `${dayLabel.charAt(0).toUpperCase()}${dayLabel.slice(1)}`;

    let startHour = 8;
    let endHour = 22;
    if (daySessions.length > 0) {
      const hoursInDay = daySessions.map(s => parseInt(s.startTime.split(':')[0]));
      const endHoursInDay = daySessions.map(s => {
        const parts = s.endTime.split(':');
        const h = parseInt(parts[0]);
        return parseInt(parts[1]) > 0 ? h + 1 : h;
      });
      startHour = Math.min(...hoursInDay);
      endHour = Math.max(...endHoursInDay, startHour + 6);
      if (endHour > 24) endHour = 24;
    }

    const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => i + startHour);
    const sortedSessions = [...daySessions].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const sessionsByTime: Record<string, ClassSession[]> = {};
    sortedSessions.forEach(s => {
      if (!sessionsByTime[s.startTime]) sessionsByTime[s.startTime] = [];
      sessionsByTime[s.startTime].push(s);
    });

    return (
      <div className="flex-1 flex flex-col h-full overflow-hidden animate-fade-in bg-neutral-base">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 px-4 md:px-10 pt-4 pb-3">
          <div>
            <p className="eyebrow text-brand">Agenda diaria</p>
            <h3 className="ui-page-title mt-1 text-neutral-textMain">{dayTitle}</h3>
          </div>
          <div className="flex items-center gap-3 md:gap-6">
            <div className="flex w-full rounded-[13px] border border-neutral-border bg-neutral-sec p-1 md:w-auto">
              <button onClick={() => setViewMode('day')} className={`flex-1 rounded-[10px] px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest transition-all md:flex-none ${viewMode === 'day' ? 'bg-brand text-white shadow-sm' : 'text-neutral-textHelper hover:text-brand'}`}>Día</button>
              <button onClick={() => setViewMode('month')} className={`flex-1 rounded-[10px] px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest transition-all md:flex-none ${viewMode === 'month' ? 'bg-brand text-white shadow-sm' : 'text-neutral-textHelper hover:text-brand'}`}>Mes</button>
            </div>
            <button onClick={() => handleOpenSessionModal()} className="whitespace-nowrap rounded-[12px] bg-brand px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest text-white shadow-sm transition-all hover:bg-brand-hover active:scale-95 md:px-6">Nueva sesión</button>
          </div>
        </div>

        <div className="flex items-center gap-2.5 px-4 md:px-10 mb-4 overflow-x-auto pb-2 no-scrollbar shrink-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-neutral-border bg-white text-neutral-textHelper">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          </div>
          {weekDays.map((date, i) => {
            const isSelected = date.toDateString() === selectedDate.toDateString();
            const dName = date.toLocaleDateString('es-ES', { weekday: 'long' });
            return (
              <button
                key={i}
                onClick={() => setSelectedDate(new Date(date))}
                className={`flex min-w-[70px] flex-col items-center rounded-[13px] border px-3 py-2.5 transition-all md:min-w-[82px] ${isSelected ? 'border-brand bg-brand text-white shadow-md' : 'border-neutral-border bg-white text-neutral-textMain hover:border-brand/50'}`}
              >
                <span className={`text-[12px] font-semibold capitalize mb-1 ${isSelected ? 'text-white/80' : 'text-neutral-textHelper'}`}>{dName}</span>
                <span className={`text-[14px] font-semibold leading-none ${isSelected ? 'text-white' : 'text-neutral-textMain'}`}>{date.getDate()}</span>
              </button>
            );
          })}
        </div>

        <div className="relative flex-1 overflow-hidden border-t border-neutral-border bg-neutral-sec">
          <div className="h-full overflow-y-auto custom-scrollbar px-6 md:px-10 pt-4 pb-32">
            <div className="relative pl-20" style={{ minHeight: `${hours.length * HOUR_HEIGHT}px` }}>
              {hours.map((hour) => (
                <div key={hour} className="relative flex h-[140px] items-start border-t border-neutral-border/60">
                  <span className="-ml-20 w-20 text-left text-[12px] font-medium text-neutral-textHelper -mt-2 uppercase tracking-wider">{hour === 24 ? '00' : hour}:00</span>
                </div>
              ))}

              {Object.keys(sessionsByTime).map(startTime => {
                const concurrentSessions = sessionsByTime[startTime];
                const widthPercent = 100 / concurrentSessions.length;
                return concurrentSessions.map((session, index) => {
                  const occupancy = getSessionOccupancy(session, capacityMap);
                  const [startH, startM] = session.startTime.split(':').map(Number);
                  const topOffset = ((startH * 60 + startM - startHour * 60) / 60) * HOUR_HEIGHT;
                  const leftOffset = index * widthPercent;
                  return (
                    <div
                      key={session.id}
                      className="group absolute z-10 flex cursor-pointer flex-col items-start overflow-hidden rounded-[16px] border border-neutral-border bg-white p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:border-brand/40 md:p-5"
                      style={{ top: `${topOffset}px`, left: `calc(${leftOffset}% + 80px)`, width: `calc(${widthPercent}% - 92px)`, minHeight: '152px' }}
                      onClick={() => handleOpenSessionModal(session)}
                    >
                         <div className="flex w-full flex-col items-start gap-2 pr-14 mb-4">
                           <span className="text-[14px] font-semibold text-neutral-textMain leading-none">{session.startTime} - {session.endTime}</span>
                           <span className={`px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-[0.14em] text-white ${getSessionBadgeClasses(session.classType)}`}>{getSessionLabel(session).toUpperCase()}</span>
                          {session.classType !== 'feriado' && <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-textHelper">{occupancy.enrolled}/{occupancy.capacity} cupos</span>}
                         </div>
                      <div className="text-[13.75px] font-medium text-neutral-textHelper uppercase tracking-widest mb-4">
                        <span>Profesor/a: </span>
                        <span className="text-[#B07D4E] font-semibold">{getTeacherName(session.teacherId)}</span>
                        {getTeacherSpecialty(session.teacherId) && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            {getTeacherSpecialty(session.teacherId)}
                          </span>
                        )}
                        {session.classType === 'workshop' && session.workshopName && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            {session.workshopName}
                          </span>
                        )}
                        {session.classType === 'privada' && session.privateReason && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            {session.privateReason}
                          </span>
                        )}
                        {session.classType === 'feriado' && (
                           <span className="block text-[12.5px] font-medium text-neutral-textSec uppercase tracking-widest mt-1">
                            Vacaciones
                          </span>
                        )}
                      </div>
                      <div className="w-full flex-1 space-y-2 overflow-hidden">
                        {session.students.map((studentName, idx) => {
                          const att = session.attendance?.[studentName];
                          // Buscar el alumno para obtener su categoría
                          const studentObj = students.find(st => {
                            const fullName = `${st.name} ${st.surname || ''}`.trim().toUpperCase();
                            return fullName === studentName.toUpperCase() || st.name.toUpperCase() === studentName.toUpperCase();
                          });
                          const cat = studentObj?.studentCategory || 'membresia';
                          const isTemporary = cat === 'temporal';
                          // Color de bolita: presente=verde, ausente=rojo, pendiente=según categoría
                          const dotColor = att === 'absent'
                            ? 'bg-red-500'
                            : att === 'present'
                              ? 'bg-green-500'
                              : isTemporary
                                ? 'bg-amber-500'
                                : 'bg-[#C88B6A]';
                          return (
                            <div key={idx} className="flex items-center gap-2.5">
                              <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`}></div>
                               <span className={`text-[15px] md:text-[16.25px] font-medium truncate ${att === 'absent' ? 'text-red-400 line-through opacity-60' : (att === 'present' ? 'text-green-600' : 'text-neutral-textMain')}`}>{studentName.toLowerCase()}</span>
                            </div>
                          );
                        })}
                      </div>
                      {/* Control de asistencia */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleOpenAttendanceModal(session); }}
                        className="absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-[13px] border-2 border-white/80 bg-brand text-white shadow-md transition-all hover:-translate-y-0.5 hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 active:translate-y-0"
                        title="Control de Asistencia"
                        aria-label="Abrir control de asistencia"
                      >
                        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.25" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4" /></svg>
                      </button>
                    </div>
                  );
                });
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-base">
      {viewMode === 'day' ? renderDayView() : (
        <div className="flex-1 overflow-y-auto px-3 pb-16 pt-3 custom-scrollbar md:px-6 md:pb-10 md:pt-5">
          <div className="calendar-month-stage mx-auto w-full max-w-5xl p-2 md:p-4">
            <div className="calendar-month-surface p-3 md:p-5 lg:p-7">
              <header className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3 md:gap-4">
                  <div className="calendar-black-icon shrink-0" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="3" /><path d="M8 2v4M16 2v4M3 9h18" /></svg>
                  </div>
                  <div>
                    <p className="eyebrow text-brand">Agenda del estudio</p>
                    <h3 className="ui-page-title mt-1 text-neutral-textMain">Calendario mensual</h3>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end md:self-auto">
                  <button type="button" onClick={() => handleOpenSessionModal()} className="inline-flex h-[38px] min-h-0 items-center justify-center whitespace-nowrap rounded-full bg-brand px-4 text-[11px] font-semibold leading-none text-white transition hover:bg-brand-hover sm:px-5">Nueva sesión</button>
                  <button type="button" onClick={() => setViewMode('day')} className="inline-flex h-[38px] min-h-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-neutral-sec px-4 text-[12px] font-semibold leading-none text-neutral-textMain transition hover:bg-brand-soft hover:text-brand" aria-label="Volver a la vista diaria">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 12H5m6-6-6 6 6 6" /></svg>
                    <span className="hidden sm:inline">Vista diaria</span><span className="sm:hidden">Día</span>
                  </button>
                  <button type="button" onClick={() => setSelectedDate(new Date())} className="inline-flex h-[38px] min-h-0 items-center justify-center whitespace-nowrap rounded-full bg-neutral-sec px-5 text-[12px] font-semibold leading-none text-neutral-textMain transition hover:bg-brand-soft hover:text-brand">Ver todo</button>
                  <button type="button" onClick={() => setSelectedDate(new Date())} aria-label="Volver a hoy" title="Volver a hoy" className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-neutral-sec leading-none text-neutral-textMain transition hover:bg-brand-soft hover:text-brand">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68M4 4v4.68h4.68" /></svg>
                  </button>
                </div>
              </header>

              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-border pb-4 md:gap-x-7">
                {[
                  ['low', 'Baja'],
                  ['medium', 'Media'],
                  ['high', 'Alta'],
                  ['full', 'Completa'],
                  ['torno', 'Torno'],
                  ['mixed', 'Mixto']
                ].map(([density, label]) => (
                  <div key={density} className="flex items-center gap-2 text-[13px] font-medium text-neutral-textSec">
                    <span className={`calendar-legend-dot calendar-legend-${density}`} />
                    {label}
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-3">
                <button type="button" aria-label="Mes anterior" onClick={() => setSelectedDate(current => { const next = new Date(current); next.setMonth(next.getMonth() - 1); return next; })} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-textSec transition hover:bg-brand-soft hover:text-brand"><svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m15 19-7-7 7-7" /></svg></button>
                  <h4 className="text-center text-[20px] font-semibold capitalize tracking-tight text-neutral-textMain">{selectedDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</h4>
                <button type="button" aria-label="Mes siguiente" onClick={() => setSelectedDate(current => { const next = new Date(current); next.setMonth(next.getMonth() + 1); return next; })} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-textSec transition hover:bg-brand-soft hover:text-brand"><svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m9 5 7 7-7 7" /></svg></button>
              </div>

              <div className="mt-3 grid grid-cols-7 gap-1 md:gap-2.5">
                {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <div key={day} className="pb-1 text-center text-[12px] font-semibold text-neutral-textSec">{day}</div>)}
                {monthDays.map((item, index) => {
                  const isSelected = item.date.toDateString() === selectedDate.toDateString();
                  const dayKey = formatDateKey(item.date);
                  const daySessions = sessionsByDate[dayKey] || [];
                   const density = getMonthlyCalendarClass(daySessions);
                  const densityClass = `calendar-density-${density}`;
                  const countLabel = daySessions.length === 1 ? '1 sesión' : `${daySessions.length} sesiones`;
                  return (
                    <button
                      type="button"
                      key={`${dayKey}-${index}`}
                      onClick={() => { setSelectedDate(new Date(item.date)); setViewMode('day'); }}
                      aria-label={`${item.date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}${daySessions.length ? `, ${countLabel}` : ', sin sesiones'}`}
                      className={`calendar-density-cell ${densityClass} ${!item.currentMonth ? 'calendar-density-muted' : ''} ${isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-brand' : ''}`}
                    >
                      <span className="text-[14px] font-semibold leading-none">{item.date.getDate()}</span>
                      {item.currentMonth && daySessions.length > 0 && <span className="calendar-density-count">{countLabel}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE CONTROL DE ASISTENCIA (EXCLUSIVO) */}
      {showAttendanceModal && attendanceSession && (
        <div
          className="fixed inset-0 z-[110] flex items-end bg-[#2F1E17]/45 font-['Inter'] backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-5"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !isSubmitting) setShowAttendanceModal(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="attendance-modal-title"
            className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#FFFCF8] text-[#2F211B] shadow-[0_24px_70px_rgba(59,35,24,0.2)] sm:h-auto sm:max-h-[92dvh] sm:max-w-2xl sm:rounded-[24px] sm:border sm:border-[#E8D9CC] animate-fade-in"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-[#E8D9CC] px-5 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:px-8 sm:py-4">
              <div className="min-w-0 pr-4 sm:flex sm:items-baseline sm:gap-4">
                <h3 id="attendance-modal-title" className="ui-section-title shrink-0 font-['Playfair_Display'] text-[#7B3F22]">Control de asistencia</h3>
                <p className="ui-meta mt-1.5 truncate first-letter:uppercase sm:mt-0">{formatSessionDate(attendanceSession.date)}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAttendanceModal(false)}
                disabled={isSubmitting}
                aria-label="Cerrar modal"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8B6B5E] transition-colors hover:bg-[#F3E7DC] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 18 18 6M6 6l12 12" /></svg>
              </button>
            </header>

            <div className="custom-scrollbar flex-1 overflow-y-auto px-5 py-4 sm:px-8 sm:py-5">
              <div className="mb-5 rounded-[12px] border border-[#E8D9CC] bg-[#F8EEE5] px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-semibold text-[#7B3F22]">{attendanceSession.startTime}–{attendanceSession.endTime}</span>
                  <span className="h-3 w-px bg-[#DDBFA4]" aria-hidden="true" />
                  <span className="text-[11px] font-semibold text-[#6E5145]">{getSessionLabel(attendanceSession)}</span>
                  <span className="text-[11px] text-[#8B6B5E]">{getTeacherName(attendanceSession.teacherId)}</span>
                  {attendanceSession.completedAt && (
                    <span className="ml-auto inline-flex items-center gap-1.5 rounded-[7px] bg-[#E7F0E8] px-2 py-1 text-[12px] font-semibold text-[#47704D]">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m5 13 4 4L19 7" /></svg>
                      Finalizada
                    </span>
                  )}
                </div>
                {(attendanceSession.workshopName || attendanceSession.privateReason || attendanceSession.classType === 'feriado') && (
                  <p className="ui-meta mt-1.5">
                    {attendanceSession.workshopName || attendanceSession.privateReason || 'Vacaciones'}
                  </p>
                )}
                {attendanceSession.completedAt && (
                  <p className="ui-meta mt-1.5 text-[#47704D]">Completada el {new Date(attendanceSession.completedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                )}
              </div>

              <div className="mb-5">
                <label htmlFor="attendance-substitute" className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">Reemplazo</label>
                <div className="relative">
                <select
                  id="attendance-substitute"
                  value={substituteId}
                  onChange={(e) => setSubstituteId(e.target.value)}
                   disabled={!!attendanceSession.completedAt && !isEditingAttendance}
                  className="h-11 w-full appearance-none rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 pr-10 text-[13px] text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <option value="">Sin reemplazo</option>
                  {teachers.map(t => (
                    <option key={t.id} value={t.id}>{`${t.name} ${t.surname || ''}`.trim()}</option>
                  ))}
                </select>
                  <svg className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m7 10 5 5 5-5" /></svg>
                </div>
              </div>

              <div className="mb-2 flex items-center justify-between gap-3">
                <h4 className="ui-label uppercase tracking-[0.14em] text-[#7B3F22]">Alumnos</h4>
                <span className="ui-meta">{attendanceSession.students.length} asignados</span>
              </div>

              <div className="overflow-hidden rounded-[12px] border border-[#E8D9CC] bg-white">
              {attendanceSession.students.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-[12px] text-[#8B6B5E]">No hay alumnos asignados</p>
                </div>
              ) : (
                attendanceSession.students.map((studentName, idx) => {
                  const status = getAttendanceStatus(attendanceSession.attendance, studentName);
                  // Find student object to show bonos info
                  const studentObj = students.find(s => {
                    const fullName = `${s.name} ${s.surname || ''}`.trim().toUpperCase();
                    return fullName === studentName.toUpperCase() || fullName === studentName;
                  });
                  const isBonusStudent = studentObj?.studentCategory === 'membresia' || studentObj?.studentCategory === 'temporal';
                  const bonos = studentObj?.classesRemaining ?? 0;
                  const bonosTotal = studentObj?.bonosAsignados ?? 4;
                  return (
                    <div key={idx} className="flex min-h-[62px] items-center justify-between gap-3 border-b border-[#EFE3D8] px-3 py-2.5 last:border-b-0 sm:px-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[14px] font-medium capitalize text-[#3F2E27]">{studentName.toLowerCase()}</p>
                          {isBonusStudent && (
                            <span className={`shrink-0 rounded-[6px] px-1.5 py-0.5 text-[12px] font-semibold ${bonos <= 0 ? 'bg-[#F7E3DF] text-[#9C4235]'
                              : bonos <= Math.ceil(bonosTotal * 0.25) ? 'bg-[#F5E8D4] text-[#916438]'
                                : 'bg-[#E7F0E8] text-[#47704D]'
                              }`}>
                              Bonos {bonos}/{bonosTotal}
                            </span>
                          )}
                        </div>
                        <span className={`ui-meta mt-1 block font-medium ${status === 'present' ? 'text-[#47704D]' : status === 'absent' ? 'text-[#9C4235]' : 'text-[#9B8175]'}`}>
                          {status === 'present' ? 'Asiste' : status === 'absent' ? 'No asiste' : 'Pendiente'}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleMarkAttendance(studentName, 'present')}
                           disabled={!!attendanceSession.completedAt && !isEditingAttendance}
                           className={`flex h-10 w-10 items-center justify-center rounded-[9px] border transition focus:outline-none focus:ring-2 focus:ring-[#6B876F] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${status === 'present' ? 'border-[#5F8065] bg-[#5F8065] text-white' : 'border-[#D8E4D9] bg-[#F4F8F4] text-[#5F8065] hover:bg-[#E7F0E8]'}`}
                           title={attendanceSession.completedAt && !isEditingAttendance ? "Sesión ya finalizada" : "Marcar Asistencia"}
                          aria-label={`Marcar asistencia de ${studentName}`}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m5 13 4 4L19 7" /></svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMarkAttendance(studentName, 'absent')}
                           disabled={!!attendanceSession.completedAt && !isEditingAttendance}
                           className={`flex h-10 w-10 items-center justify-center rounded-[9px] border transition focus:outline-none focus:ring-2 focus:ring-[#9C4235] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${status === 'absent' ? 'border-[#9C4235] bg-[#9C4235] text-white' : 'border-[#EBCFC9] bg-[#FCF4F2] text-[#9C4235] hover:bg-[#F7E3DF]'}`}
                           title={attendanceSession.completedAt && !isEditingAttendance ? "Sesión ya finalizada" : "Marcar Falta"}
                          aria-label={`Marcar falta de ${studentName}`}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18 18 6M6 6l12 12" /></svg>
                        </button>
                        {status !== 'pending' && (!attendanceSession.completedAt || isEditingAttendance) && (
                          <button
                            type="button"
                            onClick={() => handleMarkAttendance(studentName, 'pending')}
                            className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[#E8D9CC] bg-white text-[#8B6B5E] transition hover:bg-[#F8EEE5] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2"
                            title="Resetear Estado"
                            aria-label={`Dejar pendiente a ${studentName}`}
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15" /></svg>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              </div>
            </div>

            <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-[#E8D9CC] bg-white/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:py-4">
              {attendanceSession.completedAt ? (
                isEditingAttendance ? (
                  <>
                    <button type="button" onClick={cancelAttendanceEdit} disabled={isSubmitting} className="min-h-10 px-3 text-[12px] font-medium text-[#8B6B5E] transition hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50">Cancelar edición</button>
                    <button type="button" onClick={saveEditedAttendance} disabled={isSubmitting} className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:px-6">
                      {isSubmitting ? 'Guardando…' : 'Guardar cambios'}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={beginAttendanceEdit} className="h-11 rounded-[10px] border border-[#DDBFA4] bg-white px-5 text-[12px] font-semibold text-[#7B3F22] transition hover:bg-[#F8EEE5] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2">Editar asistencia</button>
                    <button type="button" onClick={() => setShowAttendanceModal(false)} className="h-11 rounded-[10px] bg-[#C68952] px-6 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2">Cerrar</button>
                  </>
                )
              ) : (
                <>
                  <button type="button" onClick={() => setShowAttendanceModal(false)} disabled={isSubmitting} className="min-h-10 px-3 text-[12px] font-medium text-[#8B6B5E] transition hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50">Cancelar</button>
                  <button
                    type="button"
                    onClick={finalizeAttendance}
                    disabled={isSubmitting}
                    className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 sm:px-6"
                  >
                    {isSubmitting ? 'Guardando…' : 'Finalizar control'}
                  </button>
                </>
              )}
            </footer>
          </section>
        </div>
      )}

      {/* MODAL DE EDICIÓN DE SESIÓN (SOLO CONFIGURACIÓN) */}
      {showSessionModal && (
        <div
          className="fixed inset-0 z-[100] flex items-end bg-[#2F1E17]/45 font-['Inter'] backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-5"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !isSubmitting) setShowSessionModal(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-modal-title"
            className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#FFFCF8] text-[#2F211B] shadow-[0_24px_70px_rgba(59,35,24,0.2)] sm:h-auto sm:max-h-[92dvh] sm:max-w-3xl sm:rounded-[24px] sm:border sm:border-[#E8D9CC] animate-fade-in"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-[#E8D9CC] px-5 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:px-8 sm:py-4">
              <div className="min-w-0 pr-4 sm:flex sm:items-baseline sm:gap-4">
                <h3 id="session-modal-title" className="ui-section-title shrink-0 font-['Playfair_Display'] text-[#7B3F22]">
                  {editingSessionId ? 'Editar sesión' : 'Nueva sesión'}
                </h3>
                <p className="ui-meta mt-1.5 truncate first-letter:uppercase sm:mt-0">
                  {sessionForm.date ? formatSessionDate(sessionForm.date) : 'Fecha no seleccionada'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSessionModal(false)}
                disabled={isSubmitting}
                aria-label="Cerrar modal"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8B6B5E] transition-colors hover:bg-[#F3E7DC] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </header>

            <div className="custom-scrollbar flex-1 overflow-y-auto px-5 py-4 sm:px-8 sm:py-5">
              <div className="grid gap-6 md:grid-cols-[0.9fr_1.1fr] md:gap-8">
                <div className="space-y-5">
                  <fieldset>
                    <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7B3F22]">Horario</legend>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="ui-label mb-1 block uppercase tracking-[0.12em] text-[#8B6B5E]">Inicio</span>
                        <input aria-label="Hora de inicio" type="time" value={sessionForm.startTime} onChange={(e) => setSessionForm({ ...sessionForm, startTime: e.target.value })} disabled={sessionForm.classType === 'feriado'} className={`h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 ${sessionForm.classType === 'feriado' ? 'cursor-not-allowed opacity-55' : ''}`} />
                      </label>
                      <label className="block">
                        <span className="ui-label mb-1 block uppercase tracking-[0.12em] text-[#8B6B5E]">Fin</span>
                        <input aria-label="Hora de fin" type="time" value={sessionForm.endTime} onChange={(e) => setSessionForm({ ...sessionForm, endTime: e.target.value })} disabled={sessionForm.classType === 'feriado'} className={`h-10 w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 ${sessionForm.classType === 'feriado' ? 'cursor-not-allowed opacity-55' : ''}`} />
                      </label>
                    </div>
                    {sessionForm.classType === 'feriado' && (
                      <p className="mt-2 text-[11px] leading-relaxed text-[#8B6B5E]">Día bloqueado por feriado (00:00–24:00).</p>
                    )}
                  </fieldset>

                  <div>
                    <label htmlFor="session-type" className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">Tipo de sesión</label>
                    <div className="relative">
                      <select
                        id="session-type"
                        value={sessionForm.classType}
                        onChange={(e) => {
                          const classType = e.target.value as ClassSession['classType'];
                          setSessionForm({
                             ...sessionForm,
                             classType,
                              capacity: getSessionCapacity(classType),
                             teacherId: (classType === 'mesa' || classType === 'torno') ? sessionForm.teacherId : '',
                            workshopName: classType === 'workshop' ? sessionForm.workshopName : '',
                            privateReason: classType === 'privada' ? sessionForm.privateReason : '',
                            selectedStudents: classType === 'feriado' ? [] : sessionForm.selectedStudents,
                            startTime: classType === 'feriado' ? '00:00' : sessionForm.startTime,
                            endTime: classType === 'feriado' ? '24:00' : sessionForm.endTime
                          });
                        }}
                        className="h-11 w-full appearance-none rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 pr-10 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                      >
                        <option value="mesa">Mesa</option>
                        <option value="torno">Torno</option>
                        <option value="coworking">Coworking</option>
                        <option value="workshop">Workshop</option>
                        <option value="privada">Privadas</option>
                        <option value="feriado">Feriados</option>
                      </select>
                      <svg className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m7 10 5 5 5-5" /></svg>
                   </div>
                  </div>

                  {sessionForm.classType !== 'feriado' && (
                    <label className="block">
                      <span className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">Cupo máximo</span>
                      <input
                        aria-label="Cupo máximo"
                        type="number"
                        min="1"
                        max="100"
                        value={sessionForm.capacity}
                        onChange={(e) => setSessionForm({ ...sessionForm, capacity: Number(e.target.value) })}
                        className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] font-medium text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                      />
                      <span className="mt-1 block text-[11px] text-[#8B6B5E]">{sessionForm.selectedStudents.length} de {sessionForm.capacity || 0} plazas ocupadas</span>
                    </label>
                  )}

                  {(sessionForm.classType === 'mesa' || sessionForm.classType === 'torno') && (
                    <div>
                      <label htmlFor="session-teacher" className="ui-label mb-2 block uppercase tracking-[0.14em] text-[#7B3F22]">
                        Profesor <span className="font-normal normal-case tracking-normal text-[#8B6B5E]">{sessionForm.classType === 'mesa' ? '(obligatorio)' : '(opcional)'}</span>
                      </label>
                  <select
                    id="session-teacher"
                    value={sessionForm.teacherId}
                    onChange={(e) => setSessionForm({ ...sessionForm, teacherId: e.target.value })}
                    className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                  >
                    <option value="">Sin asignar</option>
                    {teachers.map(t => (
                      <option key={t.id} value={t.id}>{`${t.name} ${t.surname || ''}`.trim()}</option>
                    ))}
                  </select>
                    </div>
                  )}
                  {sessionForm.classType === 'workshop' && (
                  <input
                    aria-label="Nombre del workshop"
                    value={sessionForm.workshopName}
                    onChange={(e) => setSessionForm({ ...sessionForm, workshopName: e.target.value })}
                    className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] text-[#2F211B] outline-none transition placeholder:text-[#8B6B5E] focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                    placeholder="Nombre del workshop"
                  />
                  )}
                  {sessionForm.classType === 'privada' && (
                  <input
                    aria-label="Motivo de la sesión privada"
                    value={sessionForm.privateReason}
                    onChange={(e) => setSessionForm({ ...sessionForm, privateReason: e.target.value })}
                    className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 text-[13px] text-[#2F211B] outline-none transition placeholder:text-[#8B6B5E] focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                    placeholder="Motivo de la sesión"
                  />
                  )}
                </div>

                {sessionForm.classType !== 'feriado' && (
                  <div className="space-y-6 border-t border-[#E8D9CC] pt-6 md:border-l md:border-t-0 md:pl-10 md:pt-0">
                    <fieldset>
                      <legend className="ui-label mb-3 uppercase tracking-[0.14em] text-[#7B3F22]">Tipo de alumnos</legend>
                       <div className="grid grid-cols-3 gap-2 rounded-[12px] bg-brand-soft p-1">
                      <button
                        type="button"
                        onClick={() => { setSessionForm({ ...sessionForm, sessionAudience: 'membresia' }); setStudentSearchQuery(''); }}
                         className={`min-h-10 rounded-[9px] px-2 text-[12.5px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand ${sessionForm.sessionAudience === 'membresia' ? 'bg-white font-bold text-neutral-textMain shadow-sm' : 'text-brand opacity-70 hover:opacity-100'}`}
                      >
                        Membresía
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSessionForm({ ...sessionForm, sessionAudience: 'temporal' }); setStudentSearchQuery(''); }}
                         className={`min-h-10 rounded-[9px] px-2 text-[12.5px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand ${sessionForm.sessionAudience === 'temporal' ? 'bg-white font-bold text-neutral-textMain shadow-sm' : 'text-brand opacity-70 hover:opacity-100'}`}
                      >
                        Temporales
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSessionForm({ ...sessionForm, sessionAudience: 'ambos' }); setStudentSearchQuery(''); }}
                         className={`min-h-10 rounded-[9px] px-2 text-[12.5px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand ${sessionForm.sessionAudience === 'ambos' ? 'bg-white font-bold text-neutral-textMain shadow-sm' : 'text-brand opacity-70 hover:opacity-100'}`}
                      >
                        Ambos
                      </button>
                      </div>
                    </fieldset>

                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <label htmlFor="student-search" className="ui-label uppercase tracking-[0.14em] text-[#7B3F22]">Alumnos</label>
                        <span className="ui-meta">{sessionForm.selectedStudents.length} seleccionados</span>
                      </div>
                      <div className="relative mb-2.5">
                        <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg>
                    <input
                      id="student-search"
                      type="text"
                      placeholder="Buscar por nombre o grupo"
                      value={studentSearchQuery}
                      onChange={(e) => setStudentSearchQuery(e.target.value)}
                      className="h-9 w-full rounded-[9px] border border-[#E1C9B5] bg-white pl-[2.125rem] pr-3 text-[12px] text-[#2F211B] outline-none transition placeholder:text-[#9B8175] focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20"
                    />
                      </div>
                    <div className="custom-scrollbar max-h-[230px] overflow-y-auto rounded-[10px] border border-[#E8D9CC] bg-white p-1.5">
                      {(() => {
                        const filtered = students
                          .filter(s => {
                            if (isStudentArchived(s, today)) return false;
                            const cat = s.studentCategory || 'membresia';
                            // Filtro por audiencia - 'ambos' muestra todos los tipos
                            const matchesAudience = sessionForm.sessionAudience === 'ambos'
                              ? true
                              : sessionForm.sessionAudience === 'membresia'
                                ? (cat === 'membresia')
                                : (cat === 'temporal');
                            // Filtro por búsqueda
                            const fullName = `${s.name} ${s.surname || ''}`.trim().toLowerCase();
                            const groupName = (s.groupName || '').toLowerCase();
                            const query = studentSearchQuery.trim().toLowerCase();
                            const matchesSearch = !query || fullName.includes(query) || groupName.includes(query);
                            return matchesAudience && matchesSearch;
                          });

                        if (filtered.length === 0) {
                          return <p className="w-full py-6 text-center text-[12px] text-[#8B6B5E]">
                            {studentSearchQuery ? 'No se encontraron alumnos con ese nombre' : 'No hay alumnos en esta categoría'}
                          </p>;
                        }

                        return filtered.map(s => {
                          const fullName = `${s.name} ${s.surname || ''}`.trim();
                          const studentKey = fullName.toUpperCase();
                           const isSelected = sessionForm.selectedStudents.includes(studentKey);
                           const cat = s.studentCategory || 'membresia';
                           const isTemporary = cat === 'temporal';
                           const capacityReached = !isSelected && sessionForm.selectedStudents.length >= sessionForm.capacity;
                           return (
                             <button type="button" key={s.id} disabled={capacityReached} onClick={() => {
                               const newList = isSelected
                                 ? sessionForm.selectedStudents.filter(n => n !== studentKey)
                                 : [...sessionForm.selectedStudents, studentKey];
                               setSessionForm({ ...sessionForm, selectedStudents: newList });
                             }} className={`mb-0.5 flex min-h-11 w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left transition last:mb-0 focus:outline-none focus:ring-2 focus:ring-[#C68952] ${isSelected ? 'bg-[#C68952] text-white' : capacityReached ? 'cursor-not-allowed opacity-45' : 'text-[#4E3A31] hover:bg-[#F8EEE5]'}`}>
                              <span className="min-w-0 truncate text-[13px] font-medium">
                                {fullName}
                                {s.groupName && <span className="ml-1.5 text-[10px] font-normal opacity-65">{s.groupName}</span>}
                              </span>
                              <span className={`shrink-0 rounded-[6px] px-2 py-1 text-[9px] font-semibold ${isSelected ? 'bg-white/18 text-white' : isTemporary ? 'bg-[#F4E2D2] text-[#8A5633]' : 'bg-[#EEE5DE] text-[#6E5145]'}`}>
                                {isTemporary ? 'Temporal' : getStudentLifecycle(s, today) === 'active' ? 'Activa' : 'Pendiente'}
                              </span>
                            </button>
                          );
                        });
                      })()}
                    </div>
                    {sessionForm.selectedStudents.length > 0 && (
                      <div className="mt-3 border-t border-[#E8D9CC] pt-3">
                        <p className="mb-2 text-[12px] font-semibold text-[#6E5145]">Alumnos seleccionados</p>
                        <div className="custom-scrollbar max-h-40 space-y-1.5 overflow-y-auto">
                          {sessionForm.selectedStudents.map(name => {
                            const studentObj = students.find(st => {
                              const fullName = `${st.name} ${st.surname || ''}`.trim().toUpperCase();
                              return fullName === name.toUpperCase() || st.name.toUpperCase() === name.toUpperCase();
                            });
                            const cat = studentObj?.studentCategory || 'membresia';
                            const isTemporary = cat === 'temporal';
                            const displayName = studentObj ? `${studentObj.name} ${studentObj.surname || ''}`.trim() : name;
                            return (
                              <div key={name} className="flex min-h-10 items-center gap-2 rounded-[9px] border border-[#E8D9CC] bg-white px-3 py-2">
                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#3F2E27]">{displayName}</span>
                                <span className={`shrink-0 rounded-[6px] px-2 py-1 text-[11px] font-semibold ${isTemporary ? 'bg-[#F4E2D2] text-[#8A5633]' : 'bg-[#EEE5DE] text-[#6E5145]'}`}>
                                  {isTemporary ? 'Temporal' : 'Membresía'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setSessionForm({ ...sessionForm, selectedStudents: sessionForm.selectedStudents.filter(selectedName => selectedName !== name) })}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#8B6B5E] transition hover:bg-[#F8EEE5] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952]"
                                  aria-label={`Quitar ${displayName}`}
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 6l12 12M18 6 6 18" /></svg>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[#E8D9CC] bg-white/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:py-4">
              {editingSessionId && (
                <button
                  type="button"
                  onClick={() => setSessionToDelete(editingSessionId)}
                  className="mr-auto min-h-10 px-2 text-[11px] font-semibold text-[#9C4235] transition hover:text-[#742F26] focus:outline-none focus:ring-2 focus:ring-[#9C4235] focus:ring-offset-2"
                >
                  Eliminar
                </button>
              )}
              <button type="button" onClick={() => setShowSessionModal(false)} disabled={isSubmitting} className={`${editingSessionId ? '' : 'ml-auto'} min-h-10 px-3 text-[12px] font-medium text-[#8B6B5E] transition hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 disabled:opacity-50`}>Cancelar</button>
              <button type="button" onClick={handleSessionSubmit} disabled={isSubmitting} className="h-11 rounded-[10px] bg-[#C68952] px-5 text-[12px] font-semibold text-white shadow-[0_5px_14px_rgba(123,63,34,0.16)] transition hover:bg-[#B87543] focus:outline-none focus:ring-2 focus:ring-[#C68952] focus:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 sm:px-6">{isSubmitting ? 'Guardando…' : editingSessionId ? 'Guardar cambios' : 'Crear sesión'}</button>
            </footer>
          </section>
        </div>
      )}

      <ConfirmModal
        isOpen={!!sessionToDelete}
        title="¿Eliminar sesión?"
        message="¿Estás seguro de que deseas eliminar esta sesión de la agenda? Esta acción no se puede deshacer."
        isDestructive={true}
        onConfirm={() => {
          if (sessionToDelete) {
            const id = sessionToDelete;
            setSessionToDelete(null);
            setShowSessionModal(false);
            onDeleteSession(id);
          }
        }}
        onCancel={() => setSessionToDelete(null)}
      />

      <ConfirmModal
        isOpen={noBonosNames.length > 0}
        title="Alumnos sin bonos disponibles"
        message={`${noBonosNames.join(', ')} no tiene bonos disponibles. ¿Deseas finalizar la sesión igualmente?`}
        isDestructive={false}
        onConfirm={() => {
          setNoBonosNames([]);
          void finalizeAttendance(true);
        }}
        onCancel={() => setNoBonosNames([])}
      />
    </div>
  );
};

export default CalendarView;
