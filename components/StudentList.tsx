import { showError } from '../context/toast';
import React, { useState, useMemo, useEffect } from 'react';
import { Student, AssignedClass, inferMembershipTier, MEMBERSHIP_PLANS, MembershipTier } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';
import { getStudentLifecycle, getStudentLifecycleCounts, getStudentLifecycleReason, getStudentPaymentStatus, getWorkshopDate, isStudentArchived } from '../utils/studentLifecycle';
import { useWorkshopDate } from '../utils/useWorkshopDate';

interface StudentListProps {
  students: Student[];
  onAddStudent: (student: Omit<Student, 'id'>) => Promise<void>;
  onRenew: (id: string, numClasses: number, membershipTier?: MembershipTier) => Promise<void>;
  onUpdate: (id: string, updates: Partial<Student>) => Promise<void>;
  onDeleteStudent: (id: string) => Promise<void>;
  selectedStudentId?: string | null;
  onClearSelectedStudent?: () => void;
}

type TabType = 'all' | 'active' | 'pending' | 'temporary' | 'archived';
type CategoryFilter = 'todos' | 'membresia' | 'temporal';
type MembershipTierFilter = 'todos' | MembershipTier;

const TAB_LABELS: Record<TabType, string> = {
  all: 'Todos', active: 'Activos', pending: 'Pendientes', temporary: 'Temporales', archived: 'Inactivos'
};

const TAB_EMPTY_LABELS: Record<TabType, string> = {
  all: 'No hay alumnos registrados', active: 'No hay membresías activas', pending: 'No hay membresías pendientes', temporary: 'No hay alumnos temporales', archived: 'No hay alumnos inactivos'
};

const RESULT_LABELS: Record<TabType, string> = {
  all: 'alumnos', active: 'alumnos activos', pending: 'alumnos pendientes', temporary: 'alumnos temporales', archived: 'alumnos inactivos'
};

const getMonthKey = (date: string) => date.slice(0, 7);

const formatMonthLabel = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
};

const getMonthCalendarDays = (monthKey: string): Array<number | null> => {
  const [year, month] = monthKey.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  return [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1)
  ];
};

const StudentList: React.FC<StudentListProps> = ({
  students,
  onAddStudent,
  onRenew,
  onUpdate,
  onDeleteStudent,
  selectedStudentId,
  onClearSelectedStudent
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('todos');
  const [membershipTierFilter, setMembershipTierFilter] = useState<MembershipTierFilter>('todos');
  const [showModal, setShowModal] = useState(false);
  const [showPersonalInfo, setShowPersonalInfo] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [studentToDelete, setStudentToDelete] = useState<string | null>(null);
  const [studentToArchive, setStudentToArchive] = useState<string | null>(null);
  const [pendingCategory, setPendingCategory] = useState<'membresia' | 'temporal' | null>(null);
  const [pendingMembershipTier, setPendingMembershipTier] = useState<MembershipTier | null>(null);
  const today = useWorkshopDate();
  const currentMonthKey = getMonthKey(today);
  const [expandedAttendanceMonth, setExpandedAttendanceMonth] = useState(currentMonthKey);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [form, setForm] = useState({
    name: '',
    surname: '',
    email: '',
    phone: '',
    notes: '',
    observations: '',
    classesRemaining: 4,
    price: MEMBERSHIP_PLANS.gold.price,
    paymentStatus: 'paid' as 'paid' | 'pending' | '',
    classType: 'Modelado',
    expiryDate: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString().split('T')[0],
    assignedClasses: [] as AssignedClass[],
    studentCategory: 'membresia' as 'membresia' | 'temporal',
    membershipTier: 'gold' as MembershipTier,
    membershipActivatedAt: '',
    groupName: '',
    bonosAsignados: 4,
    repetirMensualmente: false
  });

  const [newSessionDate, setNewSessionDate] = useState('');
  const [newSessionTime, setNewSessionTime] = useState('10:00');

  useEffect(() => {
    if (!selectedStudentId) return;
    const student = students.find(s => s.id === selectedStudentId);
    if (!student) return;
    handleEditClick(student);
    if (onClearSelectedStudent) onClearSelectedStudent();
  }, [selectedStudentId, students, onClearSelectedStudent]);

  const getCalculatedStatus = (studentData: typeof form) => {
    if (studentData.studentCategory === 'temporal') return 'new';
    const payment = studentData.paymentStatus || (editingStudent ? getStudentPaymentStatus(editingStudent) : 'pending');
    if (!studentData.expiryDate || studentData.expiryDate < today || payment === 'pending') {
      return 'needs_renewal';
    }
    return 'membresia';
  };

  const handleEditClick = (student: Student) => {
    setEditingStudent(student);
    setShowPersonalInfo(false);
    const membershipTier = inferMembershipTier(student.membershipTier, student.price);
    const isTemporal = student.studentCategory === 'temporal';
    const studentCategory = isTemporal ? 'temporal' : 'membresia';
    const assignedBonuses = student.bonosAsignados ?? (isTemporal ? 1 : MEMBERSHIP_PLANS[membershipTier].bonuses);
    setForm({
      name: student.name,
      surname: student.surname || '',
      email: student.email || '',
      phone: student.phone,
      notes: student.notes || '',
      observations: student.observations || '',
      classesRemaining: student.classesRemaining,
      price: student.price ?? (isTemporal ? 0 : MEMBERSHIP_PLANS[membershipTier].price),
      paymentStatus: student.paymentStatus || '',
      classType: student.classType || 'Modelado',
      expiryDate: student.expiryDate || '',
      assignedClasses: student.assignedClasses || [],
      studentCategory,
      membershipTier,
      membershipActivatedAt: student.membershipActivatedAt || '',
      groupName: student.groupName || '',
      bonosAsignados: assignedBonuses,
      repetirMensualmente: isTemporal ? false : (student.repetirMensualmente ?? false)
    });
    setShowModal(true);
  };

  const handleCreateClick = () => {
    setEditingStudent(null);
    setShowPersonalInfo(false);
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    setForm({
      name: '', surname: '', email: '', phone: '', notes: '', observations: '',
      classesRemaining: MEMBERSHIP_PLANS.gold.bonuses, price: MEMBERSHIP_PLANS.gold.price, paymentStatus: 'paid', classType: 'Modelado',
      expiryDate: nextMonth.toISOString().split('T')[0], assignedClasses: [],
      studentCategory: 'membresia', membershipTier: 'gold', membershipActivatedAt: getWorkshopDate(), groupName: '', bonosAsignados: MEMBERSHIP_PLANS.gold.bonuses, repetirMensualmente: false
    });
    setShowModal(true);
  };

  const applyCategoryChange = (category: 'membresia' | 'temporal') => {
    const plan = MEMBERSHIP_PLANS[form.membershipTier];
    setForm(current => ({
      ...current,
      studentCategory: category,
      bonosAsignados: category === 'temporal' ? 1 : plan.bonuses,
      classesRemaining: category === 'temporal' ? Math.min(1, current.classesRemaining) : Math.min(plan.bonuses, current.classesRemaining),
      repetirMensualmente: category === 'membresia' ? current.repetirMensualmente : false
    }));
    setPendingCategory(null);
  };

  const requestCategoryChange = (category: 'membresia' | 'temporal') => {
    if (category === form.studentCategory) return;
    setPendingCategory(category);
  };

  const applyMembershipTierChange = (tier: MembershipTier) => {
    const plan = MEMBERSHIP_PLANS[tier];
    setForm(current => ({
      ...current,
      membershipTier: tier,
      price: plan.price,
      bonosAsignados: plan.bonuses,
      classesRemaining: editingStudent ? Math.min(current.classesRemaining, plan.bonuses) : plan.bonuses
    }));
    setPendingMembershipTier(null);
  };

  const requestMembershipTierChange = (tier: MembershipTier) => {
    if (tier === form.membershipTier) return;
    setPendingMembershipTier(tier);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.name.trim()) {
      showError('El nombre es obligatorio.');
      return;
    }
    const isMembership = form.studentCategory === 'membresia';
    const plan = MEMBERSHIP_PLANS[form.membershipTier];
    const membershipActivatedAt = form.membershipActivatedAt || editingStudent?.membershipActivatedAt || editingStudent?.createdAt?.split('T')[0] || getWorkshopDate();
    const shouldUnarchive = Boolean(editingStudent?.archivedAt) && isMembership && form.paymentStatus === 'paid' && form.expiryDate >= today;
    const { assignedClasses: _assignedClasses, ...studentForm } = form;
    const data = {
      ...studentForm,
      paymentStatus: form.paymentStatus || undefined,
      price: isMembership ? plan.price : form.price,
      bonosAsignados: isMembership ? form.bonosAsignados : Math.min(Math.max(1, editingStudent?.studentCategory === 'temporal' ? editingStudent.bonosAsignados ?? 1 : 1), Math.max(1, form.bonosAsignados)),
      classesRemaining: Math.max(0, form.classesRemaining),
      repetirMensualmente: isMembership ? form.repetirMensualmente : false,
      membershipTier: isMembership ? form.membershipTier : undefined,
      membershipActivatedAt: isMembership ? membershipActivatedAt : undefined,
      archivedAt: shouldUnarchive ? '' : editingStudent?.archivedAt,
      status: getCalculatedStatus(form) as Student['status'],
      groupName: ''
    };
    setShowModal(false);
    setEditingStudent(null);
    if (editingStudent?.id) onUpdate(editingStudent.id, data);
    else onAddStudent(data);
  };

  const handleRenewMembership = async () => {
    if (!editingStudent || isSubmitting) return;
    const plan = MEMBERSHIP_PLANS[form.membershipTier];
    setIsSubmitting(true);
    try {
      await onRenew(editingStudent.id, plan.bonuses, form.membershipTier);
      setShowModal(false);
      setEditingStudent(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddSession = () => {
    if (!newSessionDate) return;
    const [h, m] = newSessionTime.split(':').map(Number);
    const endTime = `${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    setForm(prev => ({
      ...prev,
      assignedClasses: [...prev.assignedClasses, { date: newSessionDate, startTime: newSessionTime, endTime, status: 'pending' }]
    }));
    setNewSessionDate('');
  };

  const attendanceByMonth = useMemo(() => {
    return form.assignedClasses.reduce<Record<string, AssignedClass[]>>((groups, attendance) => {
      const monthKey = getMonthKey(attendance.date);
      if (!groups[monthKey]) groups[monthKey] = [];
      groups[monthKey].push(attendance);
      return groups;
    }, {});
  }, [form.assignedClasses]);

  const attendanceMonths = Object.keys(attendanceByMonth).sort((a, b) => b.localeCompare(a));
  const previousAttendanceMonths = attendanceMonths.filter(month => month !== currentMonthKey).slice(0, 3);
  const currentMonthAttendance = attendanceByMonth[currentMonthKey] || [];
  const currentAttendanceByDate = currentMonthAttendance.reduce<Record<string, AssignedClass[]>>((groups, attendance) => {
    if (!groups[attendance.date]) groups[attendance.date] = [];
    groups[attendance.date].push(attendance);
    return groups;
  }, {});

  const lifecycleCounts = useMemo(() => getStudentLifecycleCounts(students, today), [students, today]);

  const filteredStudents = useMemo(() => {
    return students.filter(student => {
      const lifecycle = getStudentLifecycle(student, today);
      const category = student.studentCategory || 'membresia';
      const fullName = `${student.name} ${student.surname || ''}`.trim().toLowerCase();
      const matchesSearch = !searchQuery.trim() || fullName.includes(searchQuery.trim().toLowerCase());
      const matchesTab = activeTab === 'all' || lifecycle === activeTab;
      const usesCategoryFilter = activeTab === 'all' || activeTab === 'archived';
      const matchesCategory = !usesCategoryFilter || categoryFilter === 'todos' || category === categoryFilter;
      const usesTierFilter = activeTab === 'active' || activeTab === 'pending' || (usesCategoryFilter && categoryFilter === 'membresia');
      const membershipTier = inferMembershipTier(student.membershipTier, student.price);
      const matchesTier = !usesTierFilter || membershipTierFilter === 'todos' || (category === 'membresia' && membershipTier === membershipTierFilter);
      return matchesTab && matchesSearch && matchesCategory && matchesTier;
    }).sort((a, b) => `${a.name} ${a.surname || ''}`.localeCompare(`${b.name} ${b.surname || ''}`));
  }, [students, activeTab, searchQuery, categoryFilter, membershipTierFilter, today]);

  const suggestions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return students
      .map(s => `${s.name} ${s.surname || ''}`.trim())
      .filter(name => name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [students, searchQuery]);

  const clearFilters = () => {
    setSearchQuery('');
    setCategoryFilter('todos');
    setMembershipTierFilter('todos');
  };

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    if (tab === 'temporary') {
      setCategoryFilter('todos');
      setMembershipTierFilter('todos');
    }
    if (tab === 'active' || tab === 'pending') setCategoryFilter('todos');
    if ((tab === 'all' || tab === 'archived') && categoryFilter !== 'membresia') setMembershipTierFilter('todos');
  };

  const hasSecondaryFilters = categoryFilter !== 'todos' || membershipTierFilter !== 'todos';
  const isCategoryFilterVisible = activeTab === 'all' || activeTab === 'archived';
  const isTierFilterVisible = activeTab === 'active' || activeTab === 'pending' || (isCategoryFilterVisible && categoryFilter === 'membresia');
  const selectedTabTotal = activeTab === 'all' ? students.length : lifecycleCounts[activeTab];
  const hasSearchOrFilters = Boolean(searchQuery.trim()) || hasSecondaryFilters;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F7F3EF] text-neutral-textMain" style={{ fontFamily: "'Outfit', sans-serif" }}>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 sm:px-6 lg:px-10 pt-5 sm:pt-7 pb-24">
        <div className="max-w-[1280px] mx-auto">
           <header className="mb-4 flex flex-col gap-3 animate-fade-in sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-bold text-[#8B6B5E] uppercase tracking-[0.18em] mb-2">Comunidad del taller</p>
                 <h1 className="ui-page-title text-[#7B3F22]" style={{ fontFamily: "'Outfit', sans-serif" }}>Alumnos</h1>
                  <p className="ui-secondary mt-2">{students.length} alumnos registrados</p>
              </div>
              <button onClick={handleCreateClick} className="shrink-0 flex items-center gap-2 h-10 px-3 sm:px-4 bg-[#7B3F22] text-white rounded-lg text-[11px] font-bold uppercase tracking-[0.12em] hover:bg-[#63321C] focus:outline-none focus:ring-2 focus:ring-[#C68952]/50 transition-colors" aria-label="Crear nuevo alumno">
                <span className="text-lg leading-none">+</span><span className="hidden sm:inline">Nuevo alumno</span><span className="sm:hidden">Nuevo</span>
              </button>
            </div>
          </header>

           <section className="mb-4 space-y-3" aria-label="Filtros de alumnos">
             <div className="relative">
              <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
              <input value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true); }} onFocus={() => setShowSuggestions(true)} onBlur={() => setTimeout(() => setShowSuggestions(false), 150)} placeholder="Buscar por nombre o apellidos" aria-label="Buscar alumno por nombre o apellidos" className="w-full h-11 pl-10 pr-10 bg-white border border-[#DDBFA4] rounded-lg text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E]/70 outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15 transition-all" />
               {searchQuery && <button type="button" onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-[#8B6B5E] hover:text-[#7B3F22] focus:outline-none focus:ring-2 focus:ring-[#C68952]/50" aria-label="Limpiar búsqueda">×</button>}
              {showSuggestions && suggestions.length > 0 && <div className="absolute left-0 right-0 mt-1 bg-white border border-[#DDBFA4] rounded-lg shadow-[0_8px_24px_rgba(123,63,34,0.12)] z-20 overflow-hidden">{suggestions.map(name => <button key={name} onMouseDown={() => { setSearchQuery(name); setShowSuggestions(false); }} className="w-full text-left px-4 py-3 text-[13px] text-[#7B3F22] hover:bg-[#F7F1EB] border-b last:border-0 border-[#F0E5DB]">{name}</button>)}</div>}
            </div>
             <div className="flex flex-wrap gap-2 rounded-xl border border-[#DDBFA4]/70 bg-white/60 p-2" role="tablist" aria-label="Estado de alumnos">
               {(Object.keys(TAB_LABELS) as TabType[]).map(tab => {
                 const count = tab === 'all' ? students.length : lifecycleCounts[tab];
                 return <button key={tab} id={`students-tab-${tab}`} type="button" onClick={() => handleTabChange(tab)} role="tab" aria-selected={activeTab === tab} aria-controls="students-results" tabIndex={activeTab === tab ? 0 : -1} className={`min-h-10 flex-1 rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors focus:outline-none focus:ring-2 focus:ring-[#C68952]/50 sm:flex-none ${activeTab === tab ? 'bg-[#7B3F22] text-white shadow-sm' : 'text-[#8B6B5E] hover:bg-[#F0E2D6] hover:text-[#7B3F22]'}`}><span>{TAB_LABELS[tab]}</span><span className="ml-1.5 opacity-80">({count})</span></button>;
               })}
             </div>
             <div className="flex flex-wrap items-center gap-2">
               {isCategoryFilterVisible && <label className="flex min-h-9 items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8B6B5E]">Tipo<select value={categoryFilter} onChange={event => { const value = event.target.value as CategoryFilter; setCategoryFilter(value); if (value !== 'membresia') setMembershipTierFilter('todos'); }} aria-label="Filtrar por tipo" className="h-9 rounded-md border border-[#DDBFA4] bg-white px-2 text-[12px] font-semibold normal-case tracking-normal text-[#7B3F22] focus:border-[#C68952] focus:outline-none focus:ring-2 focus:ring-[#C68952]/20"><option value="todos">Todos</option><option value="membresia">Membresía</option><option value="temporal">Temporal</option></select></label>}
               {isTierFilterVisible && <label className="flex min-h-9 items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8B6B5E]">Plan<select value={membershipTierFilter} onChange={event => setMembershipTierFilter(event.target.value as MembershipTierFilter)} aria-label="Filtrar por plan" className="h-9 rounded-md border border-[#DDBFA4] bg-white px-2 text-[12px] font-semibold normal-case tracking-normal text-[#7B3F22] focus:border-[#C68952] focus:outline-none focus:ring-2 focus:ring-[#C68952]/20"><option value="todos">Todos</option>{(['plata', 'gold', 'platinum'] as MembershipTier[]).map(tier => <option key={tier} value={tier}>{MEMBERSHIP_PLANS[tier].label}</option>)}</select></label>}
               <p className="ml-auto text-[12px] font-medium text-[#8B6B5E]">Mostrando <strong className="text-[#7B3F22]">{filteredStudents.length}</strong> de {selectedTabTotal} {RESULT_LABELS[activeTab]}</p>
             </div>
             {hasSecondaryFilters && <p className="text-[11px] text-[#8B6B5E]">Filtros secundarios activos sobre la pestaña {TAB_LABELS[activeTab].toLowerCase()}.</p>}
          </section>

           <div id="students-results" role="tabpanel" aria-labelledby={`students-tab-${activeTab}`} className="bg-white border border-[#DDBFA4] rounded-xl overflow-hidden">
             <div className="hidden md:grid grid-cols-[minmax(260px,1.8fr)_1.15fr_1fr_145px_150px] gap-4 px-5 py-3 border-b border-[#EDE2D8] text-[12px] font-bold uppercase tracking-[0.1em] text-[#8B6B5E]"><span>Alumno</span><span>Tipo / plan</span><span>Actividad</span><span>Clases</span><span>Estado</span></div>
             {filteredStudents.length === 0 ? <div className="px-6 py-16 text-center"><p className="text-[15px] text-[#7B3F22]" style={{ fontFamily: "'Outfit', sans-serif" }}>{selectedTabTotal === 0 ? TAB_EMPTY_LABELS[activeTab] : 'No encontramos alumnos con estos filtros'}</p><p className="text-[12px] text-[#8B6B5E] mt-1">{selectedTabTotal === 0 ? 'Los registros eliminados no aparecen en esta vista.' : 'Prueba a cambiar la búsqueda o los filtros secundarios.'}</p>{selectedTabTotal > 0 && hasSearchOrFilters && <button type="button" onClick={clearFilters} className="mt-4 min-h-9 rounded-md border border-[#C68952] px-3 text-[11px] font-bold uppercase tracking-[0.08em] text-[#7B3F22] hover:bg-[#F0E2D6] focus:outline-none focus:ring-2 focus:ring-[#C68952]/50">Limpiar filtros</button>}</div> : filteredStudents.map(s => {
               const lifecycle = getStudentLifecycle(s, today);
               const cat = s.studentCategory || 'membresia';
               const membershipTier = inferMembershipTier(s.membershipTier, s.price);
               const typeLabel = cat === 'membresia' ? `Membresía · ${MEMBERSHIP_PLANS[membershipTier].label}` : cat === 'temporal' ? 'Temporal' : 'Tipo no reconocido';
               const statusLabel = lifecycle === 'active' ? 'Activo' : lifecycle === 'pending' ? 'Pendiente' : lifecycle === 'temporary' ? 'Temporal' : 'Inactivo';
               const statusReason = getStudentLifecycleReason(s, today);
               const initials = `${s.name.charAt(0)}${s.surname?.charAt(0) || ''}`.toUpperCase();
               const assignedClasses = s.bonosAsignados ?? (cat === 'temporal' ? 1 : cat === 'membresia' ? MEMBERSHIP_PLANS[membershipTier].bonuses : 0);
               const percentage = Math.min(100, Math.max(0, (s.classesRemaining / Math.max(1, assignedClasses)) * 100));
               const statusTone = lifecycle === 'active' ? 'bg-[#E7F0E8] text-[#47704D] border-[#BFDECB]' : lifecycle === 'pending' ? 'bg-[#FBF1EC] text-[#A85D3B] border-[#E8CABB]' : lifecycle === 'temporary' ? 'bg-[#F5E8D4] text-[#916438] border-[#EBD5AC]' : 'bg-[#F0E5DB] text-[#8B6B5E] border-[#DDBFA4]';
                return <button key={s.id} onClick={() => handleEditClick(s)} className="ui-list w-full text-left grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(260px,1.8fr)_1.15fr_1fr_145px_150px] gap-3 md:gap-4 items-center px-4 md:px-5 py-3.5 border-b last:border-0 border-[#EDE2D8] hover:bg-[#FCF8F4] focus:outline-none focus:bg-[#FCF8F4] focus:ring-inset focus:ring-2 focus:ring-[#C68952]/40 transition-colors group">
                   <div className="flex items-center gap-3 min-w-0"><span className="w-11 h-11 shrink-0 rounded-full bg-[#F0E2D6] text-[#7B3F22] flex items-center justify-center text-[12px] font-bold">{initials}</span><span className="min-w-0"><strong className="ui-card-title block text-[#7B3F22] truncate group-hover:text-[#C68952] transition-colors">{s.name} {s.surname}</strong><span className="ui-meta block truncate">{s.phone || s.email || 'Sin contacto añadido'}</span><span className="ui-meta md:hidden block mt-1 truncate">{typeLabel} · {s.classType || 'Sin actividad'}</span></span></div>
                   <div className="hidden md:block min-w-0"><span className="ui-data block truncate text-[#7B3F22]">{typeLabel}</span></div>
                   <div className="hidden md:block min-w-0"><span className="ui-data block truncate text-[#7B3F22]">{s.classType || 'Sin actividad'}</span></div>
                   <div className="text-right md:text-left"><strong className={`text-[14px] tabular-nums ${s.classesRemaining === 0 ? 'text-[#A85D3B]' : 'text-[#7B3F22]'}`}>{s.classesRemaining} <span className="ui-meta font-normal">disponibles</span></strong><span className="ui-meta block">{assignedClasses} asignadas</span><div className="w-20 h-1 bg-[#F0E5DB] rounded-full overflow-hidden mt-1 ml-auto md:ml-0"><span className={`block h-full ${s.classesRemaining === 0 ? 'bg-[#A85D3B]' : 'bg-[#7B3F22]'}`} style={{ width: `${percentage}%` }} /></div></div>
                   <div className="flex max-w-[170px] flex-col items-end gap-1 md:items-start"><span className={`inline-flex justify-center rounded px-2 py-1 text-[11px] font-bold uppercase tracking-[0.06em] border ${statusTone}`}>{statusLabel}</span><span className="ui-meta text-right md:text-left">{statusReason}</span></div>
                 </button>;
             })}
           </div>
        </div>
      </div>

      {showModal && <div className="fixed inset-0 bg-[#4B2A1D]/45 backdrop-blur-[2px] z-[100] flex items-end md:items-center justify-center overflow-hidden">
        <div className="bg-[#FDFBF9] w-full md:max-w-5xl h-[100dvh] md:h-auto md:max-h-[92dvh] md:rounded-xl shadow-[0_20px_60px_rgba(75,42,29,0.2)] relative flex flex-col overflow-hidden animate-fade-in">
          <div className="px-4 sm:px-7 py-4 border-b border-[#E6D8CB] flex items-center justify-between shrink-0 bg-[#FDFBF9]"><div className="flex items-center gap-3 min-w-0"><span className="hidden sm:flex w-10 h-10 rounded-full bg-[#F0E2D6] text-[#7B3F22] items-center justify-center text-[12px] font-bold">{editingStudent ? `${editingStudent.name.charAt(0)}${editingStudent.surname?.charAt(0) || ''}` : '+'}</span><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#8B6B5E]">{editingStudent ? 'Perfil del alumno' : 'Nuevo alumno'}</p><h3 className="text-[20px] text-[#7B3F22] truncate" style={{ fontFamily: "'Outfit', sans-serif" }}>{editingStudent ? `${editingStudent.name} ${editingStudent.surname || ''}`.trim() : 'Crear ficha'}</h3></div></div><button onClick={() => setShowModal(false)} className="w-9 h-9 rounded-md border border-[#DDBFA4] text-[#8B6B5E] flex items-center justify-center hover:bg-[#F0E2D6] hover:text-[#7B3F22] transition-colors" aria-label="Cerrar ficha"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 6l12 12M18 6 6 18" /></svg></button></div>

            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 pb-28 sm:px-7 md:pb-28"><form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 py-5 md:py-6 lg:grid-cols-[1.2fr_1fr] lg:gap-8">
              <div className="space-y-5">
               <section><button type="button" onClick={() => setShowPersonalInfo(value => !value)} aria-expanded={showPersonalInfo} className="w-full flex items-center justify-between gap-3 mb-3 text-left"><span><h4 className="text-[14px] font-bold text-[#7B3F22]">Información personal</h4><span className="text-[10px] text-[#8B6B5E]">Datos de contacto</span></span><span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#8B6B5E]">{showPersonalInfo ? 'Ocultar' : 'Mostrar'} <span className="ml-1">{showPersonalInfo ? '−' : '+'}</span></span></button>{showPersonalInfo && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre" aria-label="Nombre" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /><input value={form.surname} onChange={(e) => setForm({ ...form, surname: e.target.value })} placeholder="Apellidos" aria-label="Apellidos" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" aria-label="Email" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15 sm:col-span-2" /><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Teléfono" aria-label="Teléfono" className="h-11 px-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15 sm:col-span-2" /></div>}</section>
               <section className="border-t border-[#E6D8CB] pt-3"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-2">Actividad y categoría</h4><div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5"><select value={form.classType} onChange={(e) => setForm({ ...form, classType: e.target.value })} aria-label="Tipo de clase" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option>Modelado</option><option>Torno</option><option>Coworking</option><option>Iniciación</option></select><select value={form.studentCategory} onChange={(e) => requestCategoryChange(e.target.value as 'membresia' | 'temporal')} aria-label="Categoría del alumno" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option value="membresia">Membresía</option><option value="temporal">Temporal</option></select><select value={form.paymentStatus} onChange={(e) => setForm({ ...form, paymentStatus: e.target.value as 'paid' | 'pending' | '' })} aria-label="Estado del pago" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] outline-none focus:border-[#C68952]"><option value="" disabled>Sin confirmar (histórico)</option><option value="paid">Pago al día</option><option value="pending">Pago pendiente</option></select><input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: parseInt(e.target.value) })} placeholder="Cuota" aria-label="Cuota" className="h-10 px-2.5 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none focus:border-[#C68952]" /></div></section>
                {form.studentCategory === 'membresia' && <div className="grid grid-cols-3 gap-1.5 mt-2">
                    {(['plata', 'gold', 'platinum'] as MembershipTier[]).map(tier => <button key={tier} type="button" onClick={() => requestMembershipTierChange(tier)} className={`min-h-11 rounded-lg border px-2 text-[12px] font-bold uppercase tracking-[0.08em] transition-colors ${form.membershipTier === tier ? 'border-brand bg-brand text-white shadow-sm' : 'border-neutral-border bg-white text-neutral-textMain hover:border-brand hover:text-brand'}`}><span>{MEMBERSHIP_PLANS[tier].label}</span><span className={`block text-[11px] font-medium normal-case tracking-normal ${form.membershipTier === tier ? 'text-white/90' : 'text-neutral-textSec'}`}>{MEMBERSHIP_PLANS[tier].price}€ · {MEMBERSHIP_PLANS[tier].bonuses} bonos</span></button>)}
               </div>}

               <section className="border-t border-[#E6D8CB] pt-3">
                 <div className="flex items-baseline justify-between mb-2">
                  <h4 className="text-[14px] font-bold text-[#7B3F22]">Bonos</h4>
                </div>
                 <div className="grid grid-cols-2 gap-1.5">
                  <div>
                      <label className="block text-[16px] font-medium text-[#7B3F22] mb-1">Bonos contratados</label>
                     <div className="flex items-center bg-white border border-[#E7B899] rounded-md overflow-hidden h-10">
                       <button type="button" onClick={() => setForm(f => ({ ...f, bonosAsignados: Math.max(1, f.bonosAsignados - 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Reducir bonos">-</button>
                      <input type="number" readOnly value={form.bonosAsignados} aria-label="Bonos contratados" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                       <button type="button" onClick={() => setForm(f => ({ ...f, bonosAsignados: Math.min(f.studentCategory === 'temporal' ? Math.max(1, editingStudent?.studentCategory === 'temporal' ? editingStudent.bonosAsignados ?? 1 : 1) : MEMBERSHIP_PLANS[f.membershipTier].bonuses, f.bonosAsignados + 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Aumentar bonos">+</button>
                    </div>
                  </div>
                  <div>
                     <div className="flex items-center justify-between mb-1"><label className="block text-[16px] font-medium text-[#7B3F22]">Bonos restantes</label><span className="text-[11px] font-bold text-[#A85D3B]">{form.classesRemaining}/{form.bonosAsignados}</span></div>
                     <div className="flex items-center bg-white border border-[#E7B899] rounded-md overflow-hidden h-10">
                       <button type="button" onClick={() => setForm(f => ({ ...f, classesRemaining: Math.max(0, f.classesRemaining - 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Reducir clases restantes">-</button>
                      <input type="number" readOnly value={form.classesRemaining} aria-label="Bonos restantes" className="w-full min-w-0 text-center text-[14px] font-bold text-[#A85D3B] outline-none" />
                        <button type="button" onClick={() => setForm(f => ({ ...f, classesRemaining: Math.min(f.bonosAsignados, f.classesRemaining + 1) }))} className="w-9 h-10 shrink-0 text-[#A85D3B] hover:bg-[#F0E2D6]" aria-label="Aumentar clases restantes">+</button>
                    </div>
                  </div>
                </div>
                 <div className="h-1 bg-[#F0E5DB] rounded-full overflow-hidden mt-2"><div className={`h-full ${form.classesRemaining <= 0 ? 'bg-[#A85D3B]' : 'bg-[#7B3F22]'}`} style={{ width: `${Math.min(100, (form.classesRemaining / form.bonosAsignados) * 100)}%` }} /></div>
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2">
                   <input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} aria-label="Fecha de vencimiento de pago" className="h-10 px-2.5 bg-white border border-[#E7B899] rounded-md text-[12px] text-[#A85D3B] outline-none focus:border-[#C68952]" />
                    {form.studentCategory === 'membresia' && <p className="text-[12px] text-[#8B6B5E]">Vencimiento de pago: pendiente al vencer e inactivo desde el sexto día. Renovar confirma el pago.</p>}
                </div>
              </section>
            </div>

             <div id="student-attendance-panel" className="space-y-7">
               <style>{`#student-attendance-panel > section:first-of-type { display: none; }`}</style>
              <section><div className="flex items-baseline justify-between mb-3"><h4 className="text-[14px] font-bold text-[#7B3F22]">Asistencia</h4><span className="text-[10px] text-[#8B6B5E]">Registro de sesiones</span></div><div className="space-y-2 max-h-52 overflow-y-auto custom-scrollbar">{form.assignedClasses.length === 0 ? <p className="py-6 border border-dashed border-[#DDBFA4] rounded-md text-center text-[12px] text-[#8B6B5E]">No hay asistencias registradas aún.</p> : form.assignedClasses.map((ac, idx) => <div key={idx} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-white border border-[#E6D8CB] rounded-md"><div><p className="text-[13px] font-bold text-[#7B3F22]">{ac.date}</p><p className="text-[11px] text-[#8B6B5E]">{ac.startTime} - {ac.endTime}</p></div><div className="flex gap-1"><button type="button" onClick={() => { const updated = [...form.assignedClasses]; updated[idx].status = updated[idx].status === 'present' ? 'pending' : 'present'; setForm({ ...form, assignedClasses: updated }); }} className={`w-8 h-8 rounded-md flex items-center justify-center border ${ac.status === 'present' ? 'bg-[#7B3F22] text-white border-[#7B3F22]' : 'bg-white text-[#8B6B5E] border-[#DDBFA4]'}`} aria-label="Marcar presente">✓</button><button type="button" onClick={() => { const updated = [...form.assignedClasses]; updated[idx].status = updated[idx].status === 'absent' ? 'pending' : 'absent'; setForm({ ...form, assignedClasses: updated }); }} className={`w-8 h-8 rounded-md flex items-center justify-center border ${ac.status === 'absent' ? 'bg-[#A85D3B] text-white border-[#A85D3B]' : 'bg-white text-[#8B6B5E] border-[#DDBFA4]'}`} aria-label="Marcar ausente">×</button></div></div>)}</div><div className="grid grid-cols-[1fr_1fr_44px] gap-2 mt-3"><input type="date" value={newSessionDate} onChange={(e) => setNewSessionDate(e.target.value)} aria-label="Fecha de asistencia" className="h-10 px-2 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22]" /><input type="time" value={newSessionTime} onChange={(e) => setNewSessionTime(e.target.value)} aria-label="Hora de asistencia" className="h-10 px-2 bg-white border border-[#DDBFA4] rounded-md text-[12px] text-[#7B3F22]" /><button type="button" onClick={handleAddSession} className="h-10 rounded-md bg-[#F0E2D6] text-[#7B3F22] text-lg hover:bg-[#DDBFA4]" aria-label="Añadir asistencia">+</button></div></section>
                <section className="border-t border-[#E6D8CB] pt-6">
                  <div className="flex items-baseline justify-between mb-3">
                    <h4 className="text-[14px] font-bold text-[#7B3F22]">Asistencia de {formatMonthLabel(currentMonthKey)}</h4>
                    <span className="text-[10px] text-[#8B6B5E]">Desde el calendario</span>
                  </div>
                  <div className="grid grid-cols-7 gap-1 mb-1.5">
                    {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(day => <span key={day} className="text-center text-[9px] font-bold uppercase text-[#8B6B5E]">{day}</span>)}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {getMonthCalendarDays(currentMonthKey).map((day, index) => {
                      const dateKey = day ? `${currentMonthKey}-${String(day).padStart(2, '0')}` : '';
                      const records = dateKey ? currentAttendanceByDate[dateKey] || [] : [];
                      const hasPresent = records.some(record => record.status === 'present');
                      const hasAbsent = records.some(record => record.status === 'absent');
                       const dayStatus = hasPresent && hasAbsent ? 'calendar-attendance-mixed' : hasPresent ? 'calendar-attendance-present' : hasAbsent ? 'calendar-attendance-absent' : 'calendar-attendance-empty';
                       return <div key={`${dateKey || 'empty'}-${index}`} title={hasPresent && hasAbsent ? 'Presente y falta' : hasPresent ? 'Presente' : hasAbsent ? 'Falta' : undefined} className={`calendar-mini-cell ${day ? dayStatus : 'border-transparent'}`}>
                         {day && <span className="text-[10px] font-semibold">{day}</span>}
                      </div>;
                    })}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-[#8B6B5E]"><span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#5F8065]" />Presente</span><span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#9C4235]" />Falta</span><span>{currentMonthAttendance.length} registros</span></div>
                </section>
                <section className="border-t border-[#E6D8CB] pt-6">
                  <div className="flex items-baseline justify-between mb-3"><h4 className="text-[14px] font-bold text-[#7B3F22]">Historial por meses</h4><span className="text-[10px] text-[#8B6B5E]">{previousAttendanceMonths.length} meses anteriores</span></div>
                  {previousAttendanceMonths.length === 0 ? <p className="py-5 border border-dashed border-[#DDBFA4] rounded-md text-center text-[12px] text-[#8B6B5E]">No hay meses anteriores registrados.</p> : <div className="space-y-2">{previousAttendanceMonths.map(monthKey => {
                    const records = attendanceByMonth[monthKey];
                    const isExpanded = expandedAttendanceMonth === monthKey;
                    const presentCount = records.filter(record => record.status === 'present').length;
                    const absentCount = records.filter(record => record.status === 'absent').length;
                    return <div key={monthKey} className="rounded-md border border-[#E6D8CB] bg-white overflow-hidden"><button type="button" onClick={() => setExpandedAttendanceMonth(isExpanded ? currentMonthKey : monthKey)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[#FCF8F4]"><span className="text-[12px] font-bold capitalize text-[#7B3F22]">{formatMonthLabel(monthKey)}</span><span className="text-[10px] text-[#8B6B5E]">{presentCount} presentes · {absentCount} faltas <span className="ml-1">{isExpanded ? '−' : '+'}</span></span></button>{isExpanded && <div className="border-t border-[#E6D8CB] px-3 py-2 space-y-1.5">{records.map((record, index) => <div key={`${record.date}-${record.startTime}-${index}`} className="flex items-center justify-between text-[11px]"><span className="text-[#7B3F22]">{record.date} · {record.startTime} - {record.endTime}</span><span className={`font-bold ${record.status === 'present' ? 'text-[#47704D]' : 'text-[#9C4235]'}`}>{record.status === 'present' ? 'Presente' : 'Falta'}</span></div>)}</div>}</div>;
                  })}</div>}
                </section>
               <section className="border-t border-[#E6D8CB] pt-6"><h4 className="text-[14px] font-bold text-[#7B3F22] mb-3">Observaciones internas</h4><textarea value={form.observations} onChange={(e) => setForm({ ...form, observations: e.target.value })} placeholder="Preferencias, nivel o avisos relevantes" aria-label="Observaciones internas" className="w-full min-h-[120px] p-3 bg-white border border-[#DDBFA4] rounded-md text-[13px] text-[#7B3F22] placeholder:text-[#8B6B5E] outline-none resize-y focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/15" /></section>
               <div className="text-[11px] text-[#8B6B5E] border-t border-[#E6D8CB] pt-4">{editingStudent?.createdAt ? `Ficha creada el ${new Date(editingStudent.createdAt).toLocaleDateString('es-ES')}` : 'La ficha se registrará al guardar.'}</div>
               {editingStudent && form.studentCategory === 'membresia' && <button type="button" onClick={handleRenewMembership} disabled={isSubmitting} className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7B3F22] hover:text-[#C68952] disabled:opacity-50">Renovar {MEMBERSHIP_PLANS[form.membershipTier].label} · {MEMBERSHIP_PLANS[form.membershipTier].bonuses} bonos</button>}
               {editingStudent && !isStudentArchived(editingStudent) && <button type="button" onClick={() => setStudentToArchive(editingStudent.id)} className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7B3F22] hover:text-[#C68952]">Archivar alumno manualmente</button>}
               {editingStudent && <button type="button" onClick={() => setStudentToDelete(editingStudent.id)} className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#A85D3B] hover:text-[#7B3F22]">Eliminar alumno</button>}
            </div>
          </form></div>

          <div className="absolute bottom-0 left-0 right-0 px-4 sm:px-7 py-3 bg-[#FDFBF9]/95 backdrop-blur border-t border-[#E6D8CB] flex items-center justify-end gap-3 shrink-0 z-10"><button type="button" onClick={() => setShowModal(false)} className="h-10 px-3 text-[11px] font-bold uppercase tracking-[0.1em] text-[#8B6B5E] hover:text-[#7B3F22]">Cancelar</button><button onClick={handleSubmit} disabled={isSubmitting} className="h-10 px-4 sm:px-5 bg-[#7B3F22] text-white rounded-md text-[11px] font-bold uppercase tracking-[0.1em] hover:bg-[#63321C] transition-colors disabled:opacity-60 disabled:cursor-not-allowed">{isSubmitting ? 'Guardando...' : (editingStudent ? 'Guardar cambios' : 'Guardar alumno')}</button></div>
        </div>
      </div>}

        <ConfirmModal isOpen={!!pendingCategory} title="¿Cambiar categoría?" message={`Vas a cambiar este alumno a ${pendingCategory === 'temporal' ? 'Temporal' : 'Membresía'}. Se ajustarán sus bonos y la renovación automática.`} confirmText="Cambiar categoría" isDestructive={false} onConfirm={() => { if (pendingCategory) applyCategoryChange(pendingCategory); }} onCancel={() => setPendingCategory(null)} />
        <ConfirmModal isOpen={!!pendingMembershipTier} title="¿Cambiar nivel?" message={`Vas a cambiar la membresía a ${pendingMembershipTier ? MEMBERSHIP_PLANS[pendingMembershipTier].label : ''}. Se actualizarán el precio y los bonos contratados.`} confirmText="Cambiar nivel" isDestructive={false} onConfirm={() => { if (pendingMembershipTier) applyMembershipTierChange(pendingMembershipTier); }} onCancel={() => setPendingMembershipTier(null)} />
        <ConfirmModal isOpen={!!studentToArchive} title="¿Archivar alumno?" message="El alumno dejará de aparecer entre los activos. Las membresías se reactivan al confirmar el pago y actualizar su vencimiento." confirmText="Archivar" isDestructive={false} onConfirm={() => { if (studentToArchive) { const idToArchive = studentToArchive; setStudentToArchive(null); setShowModal(false); setEditingStudent(null); onUpdate(idToArchive, { archivedAt: getWorkshopDate() }); } }} onCancel={() => setStudentToArchive(null)} />
       <ConfirmModal isOpen={!!studentToDelete} title="¿Eliminar alumno?" message="¿Seguro que deseas eliminar el historial de este alumno? Esta acción no se puede deshacer." isDestructive={true} onConfirm={() => { if (studentToDelete) { const idToDelete = studentToDelete; setStudentToDelete(null); setShowModal(false); setEditingStudent(null); onDeleteStudent(idToDelete); } }} onCancel={() => setStudentToDelete(null)} />
    </div>
  );
};

export default StudentList;
