
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Student, ClassSession, CeramicPiece, GiftCard } from '../types';

interface HistoryViewProps {
  students: Student[];
  sessions: ClassSession[];
  pieces: CeramicPiece[];
  giftCards: GiftCard[];
}

// Constantes de categorías
const CATEGORY_LABELS: Record<string, string> = {
  membresia: 'Membresía',
  temporal: 'Bonos temporales'
};

const CATEGORY_COLORS: Record<string, string> = {
  membresia: 'bg-brand text-white',
  temporal: 'bg-amber-500 text-white'
};

type CategoryFilter = 'todos' | 'membresia' | 'temporal';
const SEARCH_DEBOUNCE_MS = 250;
const SIDEBAR_PAGE_SIZE = 80;
const SIDEBAR_WINDOW_SIZE = 24;
const SIDEBAR_OVERSCAN = 8;
const APPROX_ROW_HEIGHT = 92;
const isTemporaryCategory = (category?: string) =>
  category === 'temporal';
const getDisplayCategory = (category?: string) => (isTemporaryCategory(category) ? 'temporal' : (category || 'membresia'));

type ExtendedCategoryFilter = 'todos' | 'membresia' | 'temporal' | 'bonos_especiales';

const HistoryView: React.FC<HistoryViewProps> = ({ students, sessions, pieces, giftCards }) => {
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<ExtendedCategoryFilter>('todos');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_PAGE_SIZE);
  const [listScrollTop, setListScrollTop] = useState(0);
  const studentListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim().toLowerCase());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchQuery]);

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

  const normalizeIdentity = (value?: string) => {
    if (!value) return '';
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  };

  const formatGiftCardDate = (dateValue?: string) => {
    if (!dateValue) return 'Sin fecha';
    return new Date(dateValue).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  const formatExpiryDate = (dateStr?: string) => {
    if (!dateStr) return 'Sin fecha';
    const date = new Date(dateStr);
    return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const isExpired = (dateStr?: string) => {
    if (!dateStr) return false;
    return new Date(dateStr) < new Date();
  };

  const studentDetails = useMemo(() => {
    if (!selectedStudentId) return null;
    const student = students.find(s => s.id === selectedStudentId);
    if (!student) return null;

    const fullName = `${student.name} ${student.surname || ''}`.trim();
    const upperFullName = fullName.toUpperCase();
    const upperNameOnly = student.name.toUpperCase();
    const normalizedFullName = normalizeIdentity(fullName);
    const normalizedNameOnly = normalizeIdentity(student.name);
    const normalizedSurname = normalizeIdentity(student.surname);
    const studentIsTemporary = isTemporaryCategory(student.studentCategory);

    // Filtrar sesiones donde el alumno participó (coincidencia de nombre)
    const studentSessions = sessions.filter(s =>
      s.students.some(name => {
        const key = name.toUpperCase();
        return key === upperFullName || key === upperNameOnly;
      })
    ).sort((a, b) => b.date.localeCompare(a.date));

    // Filtrar piezas del alumno
    const studentPieces = pieces.filter(p =>
      p.owner.toUpperCase() === upperFullName
    ).sort((a, b) => (b.deliveryDate || '').localeCompare(a.deliveryDate || ''));

    const studentGiftCards = giftCards
      .filter(card => {
        if (!studentIsTemporary) return false;
        if (card.recipientStudentId) {
          return card.recipientStudentId === student.id;
        }
        const recipient = normalizeIdentity(card.recipient);
        if (!recipient) return false;
        if (recipient === normalizedFullName || recipient === normalizedNameOnly) return true;
        if (recipient.includes(normalizedFullName) || normalizedFullName.includes(recipient)) return true;
        if (normalizedSurname && recipient.includes(normalizedNameOnly) && recipient.includes(normalizedSurname)) return true;
        return false;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    const activeGiftCards = studentGiftCards.filter(card => !isExpired(card.expiryDate));
    return {
      student,
      fullName,
      isTemporary: studentIsTemporary,
      sessions: studentSessions,
      pieces: studentPieces,
      giftCards: studentGiftCards,
      activeGiftCards
    };
  }, [selectedStudentId, students, sessions, pieces, giftCards]);

  const bonusSpecialStudentIds = useMemo(() => {
    const ids = new Set<string>();
    const temporaryStudents = students.filter(s => isTemporaryCategory(s.studentCategory)).map(s => ({
      id: s.id,
      normalizedFullName: normalizeIdentity(`${s.name} ${s.surname || ''}`),
      normalizedNameOnly: normalizeIdentity(s.name),
      normalizedSurname: normalizeIdentity(s.surname)
    }));

    giftCards.forEach(card => {
      if (card.recipientStudentId) {
        const matchedStudent = students.find(s => s.id === card.recipientStudentId);
        if (matchedStudent && isTemporaryCategory(matchedStudent.studentCategory)) {
          ids.add(matchedStudent.id);
        }
        return;
      }

      const recipient = normalizeIdentity(card.recipient);
      if (!recipient) return;
      const matched = temporaryStudents.filter(s => {
        if (recipient === s.normalizedFullName || recipient === s.normalizedNameOnly) return true;
        if (recipient.includes(s.normalizedFullName) || s.normalizedFullName.includes(recipient)) return true;
        if (s.normalizedSurname && recipient.includes(s.normalizedNameOnly) && recipient.includes(s.normalizedSurname)) return true;
        return false;
      });
      if (matched.length === 1) ids.add(matched[0].id);
    });

    return ids;
  }, [giftCards, students]);

  // Filtrar alumnos por categoría y búsqueda
  const filteredStudents = useMemo(() => {
    return students.filter(s => {
      const cat = s.studentCategory || 'membresia';
      const isTemporary = isTemporaryCategory(cat);
      const matchesCategory = categoryFilter === 'todos'
        || (categoryFilter === 'membresia' && cat === 'membresia')
        || (categoryFilter === 'temporal' && isTemporary)
        || (categoryFilter === 'bonos_especiales' && isTemporary && bonusSpecialStudentIds.has(s.id));
      const fullName = `${s.name} ${s.surname || ''}`.trim().toLowerCase();
      const matchesSearch = !debouncedSearchQuery
        || fullName.includes(debouncedSearchQuery)
        || (s.groupName && s.groupName.toLowerCase().includes(debouncedSearchQuery));
      return matchesCategory && matchesSearch;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [students, categoryFilter, debouncedSearchQuery, bonusSpecialStudentIds]);

  useEffect(() => {
    if (!selectedStudentId) return;
    const stillVisible = filteredStudents.some(s => s.id === selectedStudentId);
    if (!stillVisible) {
      setSelectedStudentId(filteredStudents.length ? filteredStudents[0].id : null);
    }
  }, [filteredStudents, selectedStudentId]);

  useEffect(() => {
    setVisibleCount(SIDEBAR_PAGE_SIZE);
    setListScrollTop(0);
    if (studentListRef.current) {
      studentListRef.current.scrollTop = 0;
    }
  }, [categoryFilter, debouncedSearchQuery, students.length]);

  const canLoadMore = visibleCount < filteredStudents.length;
  const visibleStudents = useMemo(
    () => filteredStudents.slice(0, visibleCount),
    [filteredStudents, visibleCount]
  );

  const loadMoreStudents = useCallback(() => {
    if (!canLoadMore) return;
    setVisibleCount(prev => Math.min(prev + SIDEBAR_PAGE_SIZE, filteredStudents.length));
  }, [canLoadMore, filteredStudents.length]);

  const handleSidebarScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setListScrollTop(target.scrollTop);

    const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 220;
    if (nearBottom) {
      loadMoreStudents();
    }
  }, [loadMoreStudents]);

  const virtualStartIndex = Math.max(0, Math.floor(listScrollTop / APPROX_ROW_HEIGHT) - SIDEBAR_OVERSCAN);
  const virtualEndIndex = Math.min(
    visibleStudents.length,
    virtualStartIndex + SIDEBAR_WINDOW_SIZE + SIDEBAR_OVERSCAN * 2
  );
  const virtualTopSpacer = virtualStartIndex * APPROX_ROW_HEIGHT;
  const virtualBottomSpacer = Math.max(0, (visibleStudents.length - virtualEndIndex) * APPROX_ROW_HEIGHT);
  const virtualStudents = visibleStudents.slice(virtualStartIndex, virtualEndIndex);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-neutral-base px-6 py-4">
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row gap-6 pb-6">
        {/* BARRA LATERAL DE ALUMNOS */}
        <aside className="w-full lg:w-96 flex flex-col shrink-0 bg-white rounded-2xl border border-neutral-border soft-shadow overflow-hidden">
          <div className="p-4 border-b border-neutral-border bg-neutral-sec/40 space-y-3">
            <h3 className="text-[15px] font-bold text-neutral-textMain">Listado de Alumnos</h3>
            {/* Búsqueda */}
            <input
              type="text"
              placeholder="Buscar por nombre o grupo..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none placeholder:text-neutral-textHelper transition-all"
            />
            {/* Filtros por categoría */}
            <div className="flex flex-wrap gap-1.5">
              {(['todos', 'membresia', 'temporal', 'bonos_especiales'] as ExtendedCategoryFilter[]).map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1.5 rounded-[10px] text-[12px] font-semibold border transition-all ${categoryFilter === cat
                    ? (cat === 'todos'
                      ? 'bg-neutral-textMain text-white border-neutral-textMain'
                      : cat === 'bonos_especiales'
                        ? 'bg-brand text-white border-transparent'
                        : CATEGORY_COLORS[cat] + ' border-transparent')
                    : 'bg-white text-neutral-textHelper border-neutral-border hover:border-arena'
                    }`}
                >
                  {cat === 'todos' ? 'Todos' : cat === 'bonos_especiales' ? 'Bonos especiales' : CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>
          <div
            ref={studentListRef}
            onScroll={handleSidebarScroll}
            className="flex-1 overflow-y-auto custom-scrollbar p-4"
          >
            {filteredStudents.length === 0 ? (
              <p className="text-center py-8 text-[13px] text-neutral-textHelper italic">Sin resultados</p>
            ) : (
              <>
                <div style={{ height: virtualTopSpacer }} />
                <div className="space-y-2">
                  {virtualStudents.map(s => {
                    const cat = s.studentCategory || 'membresia';
                    const displayCat = getDisplayCategory(cat);
                    const isTemporary = isTemporaryCategory(cat);
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedStudentId(s.id)}
                        className={`w-full text-left p-4 rounded-2xl transition-all border flex items-center justify-between group ${selectedStudentId === s.id ? (isTemporary ? 'bg-amber-500 text-white border-amber-500' : 'bg-brand text-white border-brand') + ' soft-shadow' : 'bg-transparent border-transparent text-neutral-textSec hover:bg-neutral-alt'}`}
                      >
                        <div className="overflow-hidden flex-1">
                          <p className={`font-semibold text-[14px] truncate ${selectedStudentId === s.id ? 'text-white' : 'text-neutral-textMain'}`}>{s.name} {s.surname || ''}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[11px] font-semibold ${selectedStudentId === s.id ? 'text-white/80' : 'text-neutral-textHelper'}`}>
                              {CATEGORY_LABELS[displayCat]}
                            </span>
                            {s.groupName && (
                              <span className={`text-[11px] ${selectedStudentId === s.id ? 'text-white/70' : 'text-neutral-textSec'}`}>
                                • {s.groupName}
                              </span>
                            )}
                          </div>
                          {/* Info rápida para temporales */}
                          {isTemporary && (
                            <div className={`flex items-center gap-2 mt-1 text-[11px] ${selectedStudentId === s.id ? 'text-white/70' : 'text-neutral-textSec'}`}>
                              <span>{s.classesRemaining} clases</span>
                              {s.expiryDate && (
                                <span className={isExpired(s.expiryDate) ? 'text-[#9E3B2B] font-semibold' : ''}>
                                  • Exp: {formatExpiryDate(s.expiryDate)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <svg className={`w-5 h-5 shrink-0 ${selectedStudentId === s.id ? 'text-white' : 'text-neutral-border group-hover:text-brand'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7" /></svg>
                      </button>
                    );
                  })}
                </div>
                <div style={{ height: virtualBottomSpacer }} />
                {canLoadMore && (
                  <div className="py-3 text-center text-[11px] font-semibold text-neutral-textHelper">
                    Cargando más alumnos...
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        {/* CONTENIDO DEL HISTORIAL */}
        <main className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-6">
          {studentDetails ? (
            <div className="animate-fade-in space-y-6">
              {/* CABECERA ALUMNO */}
              {(() => {
                const cat = studentDetails.student.studentCategory || 'membresia';
                const displayCat = getDisplayCategory(cat);
                const isTemporary = studentDetails.isTemporary;
                const expired = isExpired(studentDetails.student.expiryDate);
                return (
                  <div className="bg-white p-4 md:p-6 rounded-2xl border border-neutral-border soft-shadow">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
                      <div>
                        <span className="eyebrow mb-2 block">Registro integral</span>
                         <h3 className="ui-section-title text-neutral-textMain">{studentDetails.fullName}</h3>
                        <div className="flex flex-wrap gap-2 mt-3">
                          <span className={`px-3 py-1.5 rounded-[10px] text-[12px] font-semibold ${CATEGORY_COLORS[displayCat]}`}>
                            {CATEGORY_LABELS[displayCat]}
                          </span>
                          {studentDetails.student.groupName && (
                            <span className="px-3 py-1.5 bg-neutral-sec border border-neutral-border rounded-[10px] text-[12px] font-semibold text-neutral-textSec">
                              {studentDetails.student.groupName}
                            </span>
                          )}
                          <span className="px-3 py-1.5 bg-neutral-sec border border-neutral-border rounded-[10px] text-[12px] font-semibold text-neutral-textSec">
                            {studentDetails.student.classType || 'General'}
                          </span>
                        </div>
                      </div>
                      {/* KPIs principales */}
                      <div className={`grid grid-cols-2 ${isTemporary ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-3 w-full md:w-auto`}>
                        <div className={`p-3 rounded-2xl border text-center min-w-[100px] ${studentDetails.student.classesRemaining <= 1 ? 'bg-[#F8E1DA] border-[#EFC9BE]' : 'bg-neutral-sec border-neutral-border'}`}>
                          <p className={`text-[24px] font-bold ${studentDetails.student.classesRemaining <= 1 ? 'text-[#9E3B2B]' : 'text-neutral-textMain'}`}>{studentDetails.student.classesRemaining}</p>
                          <p className="text-[12px] font-semibold text-neutral-textSec">Clases Rest.</p>
                        </div>
                        <div className="bg-neutral-sec p-3 rounded-2xl border border-neutral-border text-center min-w-[100px]">
                          <p className="text-[24px] font-bold text-neutral-textMain">{studentDetails.sessions.length}</p>
                          <p className="text-[12px] font-semibold text-neutral-textSec">Sesiones</p>
                        </div>
                        <div className="bg-neutral-sec p-3 rounded-2xl border border-neutral-border text-center min-w-[100px]">
                          <p className="text-[24px] font-bold text-neutral-textMain">{studentDetails.pieces.length}</p>
                          <p className="text-[12px] font-semibold text-neutral-textSec">Piezas</p>
                        </div>
                        {isTemporary && (
                          <div className="bg-neutral-sec p-3 rounded-2xl border border-neutral-border text-center min-w-[100px]">
                            <p className="text-[24px] font-bold text-neutral-textMain">{studentDetails.giftCards.length}</p>
                            <p className="text-[12px] font-semibold text-neutral-textSec">Bonos</p>
                            {studentDetails.giftCards.length > 0 && (
                              <p className="text-[11px] font-semibold text-[#20663B] mt-1">
                                {studentDetails.activeGiftCards.length} vig.
                              </p>
                            )}
                          </div>
                        )}
                        {studentDetails.student.expiryDate && (
                          <div className={`p-3 rounded-2xl border text-center min-w-[100px] ${expired ? 'bg-[#F8E1DA] border-[#EFC9BE]' : 'bg-[#DFF0E4] border-[#BFDECB]'}`}>
                            <p className={`text-[13px] font-bold ${expired ? 'text-[#9E3B2B]' : 'text-[#20663B]'}`}>
                              {formatExpiryDate(studentDetails.student.expiryDate)}
                            </p>
                            <p className="text-[12px] font-semibold text-neutral-textSec">
                              {expired ? 'Expirado' : 'Expira'}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Info adicional para temporales */}
                    {isTemporary && studentDetails.student.price && (
                      <div className="pt-4 border-t border-neutral-border flex flex-wrap gap-6">
                        <div>
                          <span className="text-[12px] font-semibold text-neutral-textSec">Precio Bono</span>
                          <p className="text-[16px] font-bold text-neutral-textMain">{studentDetails.student.price}€</p>
                        </div>
                        {studentDetails.student.paymentMethod && (
                          <div>
                            <span className="text-[12px] font-semibold text-neutral-textSec">Método Pago</span>
                            <p className="text-[16px] font-bold text-neutral-textMain">{studentDetails.student.paymentMethod}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {studentDetails.isTemporary && (
                <section className="space-y-4">
                  <div className="flex items-center gap-3 px-1">
                    <div className="w-1.5 h-5 bg-caramelo rounded-full"></div>
                    <h4 className="text-[16px] font-bold text-neutral-textMain">Bonos de Regalo</h4>
                  </div>
                  {studentDetails.giftCards.length === 0 ? (
                    <div className="bg-neutral-sec/60 p-6 rounded-2xl border border-dashed border-neutral-border text-center">
                      <p className="text-neutral-textHelper text-[14px]">Sin bonos asociados a este perfil</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {studentDetails.giftCards.map(card => {
                        const expiredCard = isExpired(card.expiryDate);
                        return (
                          <div key={card.id} className="bg-white p-4 rounded-2xl border border-neutral-border soft-shadow flex items-start justify-between gap-4">
                            <div className="space-y-1">
                              <p className="text-[14px] font-bold text-neutral-textMain">
                                {card.type} · {card.numClasses} clases
                              </p>
                              <p className="text-[12px] font-semibold text-neutral-textSec">
                                Emitido: <span className="text-neutral-textMain">{formatGiftCardDate(card.createdAt)}</span>
                              </p>
                              {card.issuedDate && (
                                <p className="text-[12px] font-semibold text-neutral-textSec">
                                  Emitido: <span className="text-neutral-textMain">{formatGiftCardDate(card.issuedDate)}</span>
                                </p>
                              )}
                            </div>
                            <div className="text-right">
                              <p className={`text-[12px] font-semibold ${expiredCard ? 'text-[#9E3B2B]' : 'text-[#20663B]'}`}>
                                {expiredCard ? 'Expirado' : 'Vigente'}
                              </p>
                              <p className={`text-[12px] font-bold ${expiredCard ? 'text-[#9E3B2B]' : 'text-neutral-textMain'}`}>
                                {formatGiftCardDate(card.expiryDate)}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                {/* COLUMNA SESIONES (TIMELINE) */}
                <section className="space-y-4">
                  <div className="flex items-center gap-3 px-1">
                    <div className="w-1.5 h-5 bg-brand rounded-full"></div>
                    <h4 className="text-[16px] font-bold text-neutral-textMain">Historial de Clases</h4>
                  </div>
                  <div className="space-y-3">
                    {studentDetails.sessions.length === 0 ? (
                      <div className="bg-neutral-sec/60 p-6 rounded-2xl border border-dashed border-neutral-border text-center">
                        <p className="text-neutral-textHelper text-[14px]">No se registran asistencias aún</p>
                      </div>
                    ) : (
                      studentDetails.sessions.map(s => {
                        const attendanceKey = studentDetails.fullName.toUpperCase();
                        const nameKey = studentDetails.student.name.toUpperCase();
                        const status = s.attendance?.[attendanceKey] || s.attendance?.[nameKey] || 'pending';
                        return (
                          <div key={s.id} className="bg-white p-4 rounded-2xl border border-neutral-border flex justify-between items-center gap-3 group hover:border-arena transition-all">
                            <div className="flex flex-col">
                              <p className="text-[15px] font-semibold text-neutral-textMain">{formatSessionDate(s.date)}</p>
                              <p className="text-[13px] text-neutral-textSec mt-0.5">{s.startTime} - {s.endTime} • {s.classType}</p>
                            </div>
                            <div className={`px-3 py-1.5 rounded-[10px] text-[12px] font-semibold shrink-0 ${status === 'present' ? 'bg-[#DFF0E4] text-[#20663B] border border-[#BFDECB]' : status === 'absent' ? 'bg-[#F8E1DA] text-[#9E3B2B] border border-[#EFC9BE]' : 'bg-neutral-alt text-neutral-textHelper border border-neutral-border'}`}>
                              {status === 'present' ? 'Asistió' : status === 'absent' ? 'Faltó' : 'Pendiente'}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>

                {/* COLUMNA PIEZAS (PORTFOLIO) */}
                <section className="space-y-4">
                  <div className="flex items-center gap-3 px-1">
                    <div className="w-1.5 h-5 bg-neutral-textMain rounded-full"></div>
                    <h4 className="text-[16px] font-bold text-neutral-textMain">Catálogo de Producción</h4>
                  </div>
                  <div className="space-y-3">
                    {studentDetails.pieces.length === 0 ? (
                      <div className="bg-neutral-sec/60 p-6 rounded-2xl border border-dashed border-neutral-border text-center">
                        <p className="text-neutral-textHelper text-[14px]">No hay piezas registradas</p>
                      </div>
                    ) : (
                      studentDetails.pieces.map(p => (
                        <div key={p.id} className="bg-white p-4 rounded-2xl border border-neutral-border flex flex-col gap-3 group hover:border-arena transition-all">
                          <div className="flex justify-between items-start gap-3">
                            <p className="text-[15px] font-bold text-neutral-textMain leading-tight">{p.description}</p>
                            <span className={`shrink-0 px-2.5 py-1 rounded-[8px] text-[11px] font-semibold text-white ${p.status === 'entregado' ? 'bg-neutral-textHelper' : 'bg-brand'}`}>
                              {p.status.replace('_', ' ')}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-[13px] text-neutral-textSec border-t border-neutral-alt pt-3">
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-caramelo"></div>
                              <span>{p.glazeType || 'Sin esmalte'}</span>
                            </div>
                            {p.status === 'entregado' && (
                              <span className="text-[#20663B] font-semibold">✓ Entregada</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 md:p-12 bg-white rounded-2xl border border-dashed border-neutral-border">
              <div className="w-20 h-20 bg-neutral-sec rounded-full flex items-center justify-center mb-6">
                <svg className="w-10 h-10 text-neutral-textHelper" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
              </div>
              <h3 className="text-[24px] font-bold text-neutral-textMain mb-2">Selecciona un Perfil</h3>
              <p className="text-neutral-textSec text-[15px] max-w-xs mx-auto">Explora el registro histórico de clases y piezas de cada alumno del taller.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default HistoryView;
