import { showError, showWarning } from '../context/toast';
import React, { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { CeramicPiece, PieceStatus, Student } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';

// ─── Category visual helpers ───
const CATEGORY_LABELS: Record<string, string> = {
  membresia: 'Membresía',
  temporal: 'Bonos temporales'
};
const CATEGORY_BADGE: Record<string, string> = {
  membresia: 'bg-brand/10 text-brand border-brand/20',
  temporal: 'bg-amber-50 text-amber-700 border-amber-100'
};

// ─── PieceCard ───
interface PieceCardProps {
  piece: CeramicPiece;
  studentCategory?: string;
  groupName?: string;
  onEdit: (piece: CeramicPiece) => void;
  onUpdateStatus: (id: string, nextStatus: PieceStatus) => Promise<void>;
  getStatusAction: (status: PieceStatus) => { label: string; next: PieceStatus } | null;
  getStatusLabel: (status: PieceStatus) => string;
  getStatusColor: (status: PieceStatus) => string;
  getPercentage: (status: PieceStatus) => number;
  isHistory?: boolean;
}

const PieceCard: React.FC<PieceCardProps> = ({ piece, studentCategory, groupName, onEdit, onUpdateStatus, getStatusAction, getStatusLabel, getStatusColor, getPercentage, isHistory }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  // BOMBA 9 FIX: Guard against double-click on status update
  const [isUpdating, setIsUpdating] = useState(false);
  const action = getStatusAction(piece.status);

  const handleStatusUpdate = async () => {
    if (!action || isUpdating) return;
    setIsUpdating(true);
    try {
      await onUpdateStatus(piece.id, action.next);
    } finally {
      setIsUpdating(false);
    }
  };
  const COMMENT_LIMIT = 80;
  const hasLongComment = (piece.extraCommentary?.length || 0) > COMMENT_LIMIT;
  const displayText = isExpanded
    ? piece.extraCommentary
    : piece.extraCommentary?.slice(0, COMMENT_LIMIT) + (hasLongComment ? '...' : '');
  const progress = getPercentage(piece.status);
  const cat = studentCategory || 'membresia';

  return (
    <div className={`relative grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(210px,1.25fr)_minmax(220px,1.45fr)_minmax(120px,.75fr)_auto] gap-3 md:gap-4 items-center px-3 md:px-4 py-3 bg-white border-b border-neutral-border last:border-b-0 hover:bg-neutral-base transition-colors group overflow-hidden ${isHistory ? 'opacity-75' : ''}`}>
      <div className={`absolute top-0 left-0 h-1 transition-all duration-700 ease-out ${getStatusColor(piece.status)}`} style={{ width: `${progress}%` }} />

      <div className="min-w-0 flex items-center gap-3 pt-1">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[12px] shrink-0 ${getStatusColor(piece.status)}`}>
          {piece.owner.charAt(0)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-semibold text-neutral-textMain text-[14px] leading-tight truncate">{piece.owner}</h3>
             <span className="hidden sm:inline ui-meta font-semibold shrink-0">#ID-{piece.id.slice(-4).toUpperCase()}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1">
             <span className={`inline-flex px-2 py-0.5 rounded-md text-[12px] font-semibold border ${CATEGORY_BADGE[cat] || 'bg-neutral-alt text-neutral-textHelper border-neutral-border'}`}>
              {CATEGORY_LABELS[cat] || cat}
            </span>
             {groupName && <span className="hidden sm:inline-flex px-2 py-0.5 rounded-md text-[12px] font-semibold bg-neutral-sec text-neutral-textSec">{groupName}</span>}
          </div>
        </div>
      </div>

      <div className="min-w-0 hidden md:block">
        <p className="text-[14px] text-neutral-textMain truncate">{piece.description}</p>
        <div className="flex items-center gap-2 mt-1">
           {piece.glazeType && <span className="ui-meta text-neutral-textSec truncate"><span className="font-semibold text-brand">Esmalte:</span> {piece.glazeType}</span>}
           {isHistory && piece.deliveryDate && <span className="ui-meta shrink-0">· {new Date(piece.deliveryDate).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })}</span>}
        </div>
        {piece.extraCommentary && (
          <div className="flex items-center gap-2 mt-1">
             <p className="ui-meta italic truncate">"{displayText}"</p>
             {hasLongComment && <button onClick={() => setIsExpanded(!isExpanded)} className="ui-meta font-semibold text-brand hover:underline shrink-0">{isExpanded ? 'menos' : 'más'}</button>}
          </div>
        )}
      </div>

      <div className="hidden md:block min-w-0">
        <div className="flex justify-between items-center mb-1">
           <span className={`inline-flex px-2 py-1 rounded-md text-[12px] font-semibold ${getStatusColor(piece.status)} text-white`}>{getStatusLabel(piece.status)}</span>
           <span className="ui-meta font-semibold text-neutral-textMain">{progress}%</span>
        </div>
        <div className="w-full h-1.5 bg-neutral-alt rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${getStatusColor(piece.status)}`} style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="col-span-2 md:col-span-1 md:col-start-4 flex items-center justify-end gap-2 pt-2 md:pt-0 border-t border-neutral-border md:border-0">
        <p className="md:hidden flex-1 min-w-0 text-[13px] text-neutral-textMain truncate">{piece.description}</p>
        <div className="md:hidden flex flex-col items-end gap-1">
           <span className={`inline-flex px-2 py-1 rounded-md text-[12px] font-semibold ${getStatusColor(piece.status)} text-white`}>{progress}%</span>
           <span className="ui-meta">{getStatusLabel(piece.status)}</span>
        </div>
        <button onClick={() => onEdit(piece)} aria-label={`Editar pieza de ${piece.owner}`} className="w-8 h-8 flex items-center justify-center rounded-[8px] text-neutral-textHelper hover:text-brand hover:bg-brand-soft transition-colors shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
        </button>
        <button
          disabled={!action || isUpdating}
          onClick={handleStatusUpdate}
           className={`min-h-[36px] md:min-h-[40px] px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all ml-auto ${!action || isUpdating
            ? 'bg-neutral-sec text-neutral-textHelper cursor-not-allowed border border-neutral-border opacity-50'
            : 'bg-brand text-white hover:bg-brand-hover active:scale-[0.98]'
            }`}
        >
          {isUpdating ? 'Procesando...' : (action ? action.label : 'Finalizado')}
        </button>
      </div>
    </div>
  );
};

// ─── Main Component ───
interface PiecesToCollectProps {
  pieces: CeramicPiece[];
  students: Student[];
  onAddPiece: (piece: Omit<CeramicPiece, 'id'>) => Promise<void>;
  onUpdatePiece: (id: string, updates: Partial<CeramicPiece>) => Promise<void>;
  onDeletePiece: (id: string) => Promise<void>;
}

const PiecesToCollect: React.FC<PiecesToCollectProps> = ({ pieces, students, onAddPiece, onUpdatePiece, onDeletePiece }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingPiece, setEditingPiece] = useState<CeramicPiece | null>(null);
  const [filterStatus, setFilterStatus] = useState<PieceStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('todos');
  const [showHistory, setShowHistory] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [dateFilter, setDateFilter] = useState<'all' | 'day' | 'week'>('all');
  const [dateValue, setDateValue] = useState<string>(new Date().toISOString().split('T')[0]);
  const [groupFilter, setGroupFilter] = useState<string>('todos');
  const [pieceToDelete, setPieceToDelete] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);

  const [form, setForm] = useState({
    owner: '',
    description: '',
    status: '1era_quema' as PieceStatus,
    glazeType: '',
    deliveryDate: '',
    notes: '',
    extraCommentary: ''
  });

  const sortedStudents = useMemo(() => [...students].sort((a, b) => a.name.localeCompare(b.name)), [students]);

  // Map owner name → student for fast lookup
  const ownerStudentMap = useMemo(() => {
    const map: Record<string, Student> = {};
    students.forEach(s => {
      const fullName = `${s.name} ${s.surname || ''}`.trim().toUpperCase();
      map[fullName] = s;
    });
    return map;
  }, [students]);

  const getStudentForPiece = (piece: CeramicPiece): Student | undefined => {
    return ownerStudentMap[piece.owner.toUpperCase()];
  };

  // ─── Group names for filter ───
  const allGroupNames = useMemo(() => {
    const names = new Set<string>();
    students.forEach(s => { if (s.groupName) names.add(s.groupName); });
    return Array.from(names).sort();
  }, [students]);

  // ─── Date helpers ───
  const getWeekRange = (dateStr: string) => {
    const date = new Date(dateStr + 'T00:00:00');
    const day = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { start: monday.toISOString().split('T')[0], end: sunday.toISOString().split('T')[0] };
  };

  const pieceMatchesDateFilter = (piece: CeramicPiece): boolean => {
    if (dateFilter === 'all') return true;
    // Use created_at or deliveryDate for date matching
    const pieceDate = piece.deliveryDate || piece.createdAt;
    if (!pieceDate) return true; // No date = show always
    const pDate = pieceDate.split('T')[0];
    if (dateFilter === 'day') return pDate === dateValue;
    if (dateFilter === 'week') {
      const { start, end } = getWeekRange(dateValue);
      return pDate >= start && pDate <= end;
    }
    return true;
  };

  // ─── Status helpers ───
  const getStatusLabel = (status: PieceStatus) => {
    switch (status) {
      case '1era_quema': return '1ª QUEMA';
      case 'esmaltado': return 'ESMALTADO';
      case 'a_recogida': return 'A RECOGIDA';
      case 'entregado': return 'ENTREGADO';
      default: return '';
    }
  };
  const getStatusColor = (status: PieceStatus) => {
    switch (status) {
      case '1era_quema': return 'bg-orange-400';
      case 'esmaltado': return 'bg-brand';
      case 'a_recogida': return 'bg-green-500';
      case 'entregado': return 'bg-neutral-textHelper';
      default: return 'bg-neutral-border';
    }
  };
  const getStatusAction = (status: PieceStatus) => {
    switch (status) {
      case '1era_quema': return { label: 'PASAR A ESMALTADO', next: 'esmaltado' as const };
      case 'esmaltado': return { label: 'LISTA PARA RECOGER', next: 'a_recogida' as const };
      case 'a_recogida': return { label: 'MARCAR ENTREGADO', next: 'entregado' as const };
      default: return null;
    }
  };
  const getPercentage = (status: PieceStatus) => {
    switch (status) {
      case '1era_quema': return 25;
      case 'esmaltado': return 50;
      case 'a_recogida': return 75;
      case 'entregado': return 100;
      default: return 0;
    }
  };

  // ─── Handlers ───
  const handleEditClick = (piece: CeramicPiece) => {
    setEditingPiece(piece);
    setForm({ owner: piece.owner, description: piece.description, status: piece.status, glazeType: piece.glazeType || '', deliveryDate: piece.deliveryDate || '', notes: piece.notes || '', extraCommentary: piece.extraCommentary || '' });
    setShowModal(true);
  };
  const handleCreateClick = () => {
    setEditingPiece(null);
    const defaultOwner = selectedOwner || (sortedStudents.length > 0 ? `${sortedStudents[0].name} ${sortedStudents[0].surname || ''}`.trim() : '');
    setForm({ owner: defaultOwner, description: '', status: '1era_quema', glazeType: '', deliveryDate: '', notes: '', extraCommentary: '' });
    setShowModal(true);
  };
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.owner) { showError('Por favor selecciona un propietario.'); return; }
    setIsSubmitting(true);
    // Close modal immediately — Supabase operations run in background
    setShowModal(false);
    setIsSubmitting(false);
    if (editingPiece?.id) {
      onUpdatePiece(editingPiece.id, form);
    } else {
      onAddPiece(form);
    }
  };

  // ─── Search suggestions ───
  const ownerNames = useMemo(() => {
    const names = new Set<string>();
    pieces.forEach(p => names.add(p.owner));
    students.forEach(s => names.add(`${s.name} ${s.surname || ''}`.trim()));
    return Array.from(names).sort();
  }, [pieces, students]);

  const suggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return ownerNames.filter(n => n.toLowerCase().includes(q)).slice(0, 8);
  }, [ownerNames, searchQuery]);

  // ─── Separate active vs history pieces ───
  const activePieces = useMemo(() => pieces.filter(p => p.status !== 'entregado'), [pieces]);
  const historyPieces = useMemo(() => pieces.filter(p => p.status === 'entregado'), [pieces]);

  // ─── Filtered ACTIVE pieces (excludes 'entregado') ───
  const filteredPieces = useMemo(() => {
    return activePieces.filter(p => {
      if (filterStatus !== 'all' && p.status !== filterStatus) return false;
      if (selectedOwner && p.owner.toUpperCase() !== selectedOwner.toUpperCase()) return false;
      if (searchQuery.trim() && !selectedOwner) {
        const q = searchQuery.trim().toLowerCase();
        if (!p.owner.toLowerCase().includes(q)) return false;
      }
      if (categoryFilter !== 'todos') {
        const student = getStudentForPiece(p);
        const cat = student?.studentCategory || 'membresia';
        if (cat !== categoryFilter) return false;
      }
      if (groupFilter !== 'todos') {
        const student = getStudentForPiece(p);
        if (student?.groupName !== groupFilter) return false;
      }
      if (!pieceMatchesDateFilter(p)) return false;
      return true;
    });
  }, [activePieces, filterStatus, selectedOwner, searchQuery, categoryFilter, groupFilter, dateFilter, dateValue, ownerStudentMap]);

  // ─── Filtered HISTORY pieces ───
  const filteredHistoryPieces = useMemo(() => {
    return historyPieces.filter(p => {
      if (selectedOwner && p.owner.toUpperCase() !== selectedOwner.toUpperCase()) return false;
      if (searchQuery.trim() && !selectedOwner) {
        const q = searchQuery.trim().toLowerCase();
        if (!p.owner.toLowerCase().includes(q)) return false;
      }
      if (categoryFilter !== 'todos') {
        const student = getStudentForPiece(p);
        const cat = student?.studentCategory || 'membresia';
        if (cat !== categoryFilter) return false;
      }
      if (groupFilter !== 'todos') {
        const student = getStudentForPiece(p);
        if (student?.groupName !== groupFilter) return false;
      }
      if (!pieceMatchesDateFilter(p)) return false;
      return true;
    });
  }, [historyPieces, selectedOwner, searchQuery, categoryFilter, groupFilter, dateFilter, dateValue, ownerStudentMap]);

  // Group by status for section rendering (active only)
  const groupedPieces = useMemo(() => {
    const groups: Record<string, CeramicPiece[]> = { '1era_quema': [], 'esmaltado': [], 'a_recogida': [] };
    filteredPieces.forEach(p => {
      if (groups[p.status]) groups[p.status].push(p);
    });
    return groups;
  }, [filteredPieces]);

  // Selected owner's student info
  const selectedStudent = useMemo(() => {
    if (!selectedOwner) return null;
    return ownerStudentMap[selectedOwner.toUpperCase()] || null;
  }, [selectedOwner, ownerStudentMap]);

  const selectedOwnerPieceCount = useMemo(() => {
    if (!selectedOwner) return 0;
    return pieces.filter(p => p.owner.toUpperCase() === selectedOwner.toUpperCase()).length;
  }, [selectedOwner, pieces]);

  // Category counts for ACTIVE pieces only
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { todos: activePieces.length, membresia: 0, temporal: 0 };
    activePieces.forEach(p => {
      const student = getStudentForPiece(p);
      const cat = student?.studentCategory || 'membresia';
      if (counts[cat] !== undefined) counts[cat]++;
    });
    return counts;
  }, [activePieces, ownerStudentMap]);

  // Week label
  const weekLabel = useMemo(() => {
    if (dateFilter !== 'week') return '';
    const { start, end } = getWeekRange(dateValue);
    const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    return `${fmt(start)} – ${fmt(end)}`;
  }, [dateFilter, dateValue]);

  const activeFilterCount = [
    categoryFilter !== 'todos',
    groupFilter !== 'todos',
    dateFilter !== 'all',
    filterStatus !== 'all'
  ].filter(Boolean).length;

  useEffect(() => {
    setHeaderActions(document.getElementById('tallerista-header-actions'));
  }, []);

  const renderSearchControl = (className: string) => (
    <div className={`relative ${className}`}>
      <div className="flex items-center bg-white border border-neutral-border rounded-[8px] overflow-hidden">
        <svg className="w-4 h-4 text-neutral-textHelper ml-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        <input
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true); if (!e.target.value.trim()) setSelectedOwner(null); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="Buscar por nombre de alumno..."
          className="w-full min-h-[36px] px-3 bg-transparent text-[12px] text-neutral-textMain outline-none placeholder:text-neutral-textHelper"
        />
        {(searchQuery || selectedOwner) && (
          <button
            onClick={() => { setSearchQuery(''); setSelectedOwner(null); }}
            className="mr-2 text-neutral-textHelper hover:text-brand transition-colors shrink-0"
            aria-label="Limpiar búsqueda"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
      </div>
      {showSuggestions && suggestions.length > 0 && !selectedOwner && (
        <div className="absolute left-0 right-0 mt-1.5 bg-white border border-neutral-border rounded-xl soft-shadow z-50 overflow-hidden max-h-64 overflow-y-auto">
          {suggestions.map((name) => {
            const student = ownerStudentMap[name.toUpperCase()];
            const cat = student?.studentCategory || 'membresia';
            const pieceCount = pieces.filter(p => p.owner.toUpperCase() === name.toUpperCase()).length;
            return (
              <button
                key={name}
                onMouseDown={() => { setSelectedOwner(name); setSearchQuery(name); setShowSuggestions(false); }}
                className="w-full text-left px-3 py-2 hover:bg-neutral-sec transition-colors flex items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold text-neutral-textMain truncate">{name}</span>
                  <span className={`text-[11px] font-semibold ${cat === 'membresia' ? 'text-brand' : 'text-caramelo'}`}>{CATEGORY_LABELS[cat] || 'Regular'}</span>
                </span>
                <span className="text-[11px] font-semibold text-neutral-textHelper shrink-0">{pieceCount} pieza{pieceCount !== 1 ? 's' : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderFilterButton = () => (
    <button
      onClick={() => setShowFilters(!showFilters)}
      aria-expanded={showFilters}
      className={`min-h-[36px] px-3 rounded-[8px] text-[11px] font-semibold inline-flex items-center justify-center gap-1.5 border transition-colors shrink-0 ${showFilters || activeFilterCount > 0
        ? 'bg-brand text-white border-brand'
        : 'bg-white text-neutral-textSec border-neutral-border hover:border-arena hover:text-brand'
        }`}
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 6h18M6 12h12M10 18h4" /></svg>
      <span className="hidden sm:inline">Filtros</span>{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
    </button>
  );

  const renderCreateButton = () => (
    <button
      onClick={handleCreateClick}
      className="min-h-[36px] px-3 rounded-[8px] bg-brand text-white text-[11px] font-semibold inline-flex items-center justify-center gap-1.5 hover:bg-brand-hover active:scale-[0.98] transition-all shrink-0"
    >
      <span className="text-sm leading-none">+</span>
      <span className="hidden sm:inline">Nueva pieza</span>
      <span className="sm:hidden">Nueva</span>
    </button>
  );

  const piecesHeaderActions = headerActions ? createPortal(
    <div className="hidden sm:flex items-center gap-1.5 md:gap-2 min-w-0">
      {renderSearchControl('hidden sm:block w-[180px] md:w-[250px] lg:w-[295px]')}
      {renderFilterButton()}
      {renderCreateButton()}
    </div>,
    headerActions
  ) : null;

  return (
    <>
      {piecesHeaderActions}
    <div className="h-full min-h-0 flex flex-col overflow-hidden px-1.5 md:px-1.5 lg:px-1.5 bg-neutral-base">

      {/* ─── MOBILE TOOLS ─── */}
      <header className="pt-2 md:pt-3 shrink-0 space-y-3 mb-3">
        <div className="sm:hidden space-y-2">
          {renderSearchControl('w-full')}
          <div className="flex items-center justify-end gap-2">
            {renderFilterButton()}
            {renderCreateButton()}
          </div>
        </div>

        {/* Selected owner profile banner */}
        {selectedOwner && (
          <div className="bg-white rounded-2xl border border-neutral-border p-4 md:p-5 flex items-center justify-between animate-fade-in">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-brand flex items-center justify-center text-white font-bold text-xl shrink-0">
                {selectedOwner.charAt(0)}
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-neutral-textMain">{selectedOwner}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {selectedStudent && (
                    <span className={`inline-block px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${CATEGORY_BADGE[selectedStudent.studentCategory || 'membresia'] || 'bg-neutral-alt text-neutral-textHelper border-neutral-border'}`}>
                      {CATEGORY_LABELS[selectedStudent.studentCategory || 'membresia']}
                    </span>
                  )}
                  {selectedStudent?.groupName && (
                    <span className="inline-block px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-neutral-sec text-neutral-textSec border border-neutral-border">
                      {selectedStudent.groupName}
                    </span>
                  )}
                  <span className="text-[12px] font-semibold text-neutral-textHelper">
                    {selectedOwnerPieceCount} pieza{selectedOwnerPieceCount !== 1 ? 's' : ''} registrada{selectedOwnerPieceCount !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={() => { setSelectedOwner(null); setSearchQuery(''); }}
              className="min-h-[40px] px-4 py-2 bg-white border border-neutral-border text-neutral-textSec rounded-[10px] text-[13px] font-semibold hover:border-arena hover:text-brand transition-colors shrink-0"
            >
              VER TODAS
            </button>
          </div>
        )}

        {showFilters && (
          <div className="rounded-2xl bg-neutral-sec border border-neutral-border p-3 md:p-4 space-y-3 animate-fade-in">
        {/* Row 2: Category filter + Group filter */}
        <div className="flex flex-wrap gap-2 items-center">
          {(['todos', 'membresia', 'temporal'] as const).map(cat => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3.5 py-2 min-h-[40px] rounded-[10px] text-[13px] font-semibold border transition-all ${categoryFilter === cat
                ? 'bg-brand text-white border-brand'
                : 'bg-white text-neutral-textSec border-neutral-border hover:border-arena hover:text-brand'
                }`}
            >
              {cat === 'todos' ? 'Todas categorías' : CATEGORY_LABELS[cat]} ({categoryCounts[cat] || 0})
            </button>
          ))}

          {/* Group name filter (only if groups exist) */}
          {allGroupNames.length > 0 && (
            <>
              <div className="w-px h-6 bg-neutral-border mx-1"></div>
              <select
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                className={`px-3.5 py-2 min-h-[40px] rounded-[10px] text-[13px] font-semibold border appearance-none cursor-pointer transition-all ${groupFilter !== 'todos'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-white text-neutral-textSec border-neutral-border hover:border-arena'
                  }`}
              >
                <option value="todos">TODOS LOS GRUPOS</option>
                {allGroupNames.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </>
          )}
        </div>

        {/* Row 3: Date filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex bg-white p-1 rounded-[10px] border border-neutral-border">
            {([
              { key: 'all', label: 'SIN FILTRO' },
              { key: 'day', label: 'POR DÍA' },
              { key: 'week', label: 'POR SEMANA' }
            ] as const).map(opt => (
              <button
                key={opt.key}
                onClick={() => setDateFilter(opt.key)}
                className={`px-4 py-2 rounded-[10px] text-[13px] font-semibold transition-all ${dateFilter === opt.key ? 'bg-brand text-white' : 'text-neutral-textSec hover:text-brand'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {dateFilter !== 'all' && (
            <input
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              className="min-h-[40px] px-3.5 py-2 bg-white border border-neutral-border rounded-[10px] text-[14px] text-neutral-textMain outline-none focus:border-brand focus:ring-2 focus:ring-brand/15 cursor-pointer"
            />
          )}
          {dateFilter === 'week' && (
            <span className="text-[13px] font-semibold text-neutral-textSec">{weekLabel}</span>
          )}
        </div>

        {/* Row 4: Status filter + History toggle */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex bg-white p-1 rounded-[10px] border border-neutral-border overflow-x-auto no-scrollbar">
            {(['all', '1era_quema', 'esmaltado', 'a_recogida'] as const).map(s => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`px-4 md:px-6 py-2.5 rounded-[10px] text-[13px] font-semibold transition-all whitespace-nowrap ${filterStatus === s ? 'bg-brand text-white' : 'text-neutral-textSec hover:text-brand'}`}
              >
                {s === 'all' ? 'TODAS' : getStatusLabel(s as PieceStatus)}
              </button>
            ))}
          </div>

          {/* History toggle button */}
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-[10px] text-[13px] font-semibold transition-all border ${showHistory
              ? 'bg-brand text-white border-brand'
              : 'bg-white text-neutral-textSec border-neutral-border hover:border-arena hover:text-brand'
              }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            HISTORIAL ({historyPieces.length})
          </button>
        </div>
          </div>
        )}
      </header>

      {/* ─── PIECES GRID (Active) ─── */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pb-20">
        {filteredPieces.length === 0 && !showHistory ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <svg className="w-16 h-16 text-neutral-border mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
            <p className="text-[15px] font-semibold text-neutral-textSec mb-2">Sin piezas activas</p>
            <p className="text-[14px] text-neutral-textSec">
              {selectedOwner ? `${selectedOwner} no tiene piezas en proceso.` : 'No hay piezas que coincidan con los filtros.'}
            </p>
          </div>
        ) : (
          <div className="space-y-10">
            {(['1era_quema', 'esmaltado', 'a_recogida'] as const).map(statusKey => {
              if (filterStatus !== 'all' && filterStatus !== statusKey) return null;
              const currentGroup = groupedPieces[statusKey] || [];
              if (currentGroup.length === 0) return null;

              return (
                <section key={statusKey} className="animate-fade-in">
                  <div className="flex items-center gap-3 mb-3 sticky top-0 bg-neutral-base/95 backdrop-blur-md z-10 py-2">
                    <div className={`w-1.5 h-6 rounded-full ${getStatusColor(statusKey)}`}></div>
                    <h3 className="text-[19px] md:text-[21px] font-bold text-neutral-textMain">
                      {getStatusLabel(statusKey)}
                      <span className="ml-2 text-neutral-textHelper text-[13px] font-medium">({currentGroup.length})</span>
                    </h3>
                  </div>
                  <div className="bg-white border border-neutral-border rounded-2xl overflow-hidden">
                    {currentGroup.map(piece => {
                      const student = getStudentForPiece(piece);
                      return (
                        <PieceCard
                          key={piece.id}
                          piece={piece}
                          studentCategory={student?.studentCategory}
                          groupName={student?.groupName}
                          onEdit={handleEditClick}
                          onUpdateStatus={(id, next) => onUpdatePiece(id, { status: next })}
                          getStatusAction={getStatusAction}
                          getStatusLabel={getStatusLabel}
                          getStatusColor={getStatusColor}
                          getPercentage={getPercentage}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {/* ─── HISTORY SECTION (collapsible) ─── */}
            {showHistory && (
              <section className="animate-fade-in">
                <div className="flex items-center gap-3 mb-3 sticky top-0 bg-neutral-base/95 backdrop-blur-md z-10 py-2">
                  <div className="w-1.5 h-6 rounded-full bg-neutral-textHelper"></div>
                  <h3 className="text-[19px] md:text-[21px] font-bold text-neutral-textMain">
                    Historial de Piezas Entregadas
                    <span className="ml-2 text-neutral-textHelper text-[13px] font-medium">({filteredHistoryPieces.length})</span>
                  </h3>
                </div>
                {filteredHistoryPieces.length === 0 ? (
                  <div className="bg-white border border-dashed border-neutral-border p-10 rounded-2xl text-center">
                    <p className="text-[14px] text-neutral-textHelper">No hay piezas entregadas que coincidan con los filtros.</p>
                  </div>
                ) : (
                  <div className="bg-white border border-neutral-border rounded-2xl overflow-hidden">
                    {filteredHistoryPieces.map(piece => {
                      const student = getStudentForPiece(piece);
                      return (
                        <PieceCard
                          key={piece.id}
                          piece={piece}
                          studentCategory={student?.studentCategory}
                          groupName={student?.groupName}
                          onEdit={handleEditClick}
                          onUpdateStatus={(id, next) => onUpdatePiece(id, { status: next })}
                          getStatusAction={getStatusAction}
                          getStatusLabel={getStatusLabel}
                          getStatusColor={getStatusColor}
                          getPercentage={getPercentage}
                          isHistory
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      {/* ─── MODAL ─── */}
      {showModal && (
        <div className="fixed inset-0 bg-neutral-textMain/20 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-2xl soft-shadow relative animate-fade-in flex flex-col border border-neutral-border overflow-hidden">
            <button onClick={() => setShowModal(false)} aria-label="Cerrar modal" className="absolute top-5 right-5 text-neutral-textHelper hover:text-neutral-textMain transition-colors z-20">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <div className="p-6 md:p-8 lg:p-10 overflow-y-auto custom-scrollbar">
               <h3 className="ui-section-title text-neutral-textMain mb-2">
                {editingPiece ? 'EDITAR PIEZA' : 'REGISTRAR PIEZA'}
              </h3>
              <p className="text-neutral-textSec text-[14px] mb-6">Define los detalles para el seguimiento en el taller.</p>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">PROPIETARIO</label>
                    <select
                      required
                      value={form.owner}
                      onChange={(e) => setForm({ ...form, owner: e.target.value })}
                      className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] text-neutral-textMain appearance-none cursor-pointer focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none"
                    >
                      <option value="" disabled>Seleccionar Alumno</option>
                      {sortedStudents.map(student => (
                        <option key={student.id} value={`${student.name} ${student.surname || ''}`.trim()}>
                          {`${student.name} ${student.surname || ''}`.trim()} — {CATEGORY_LABELS[student.studentCategory || 'membresia']}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">ESTADO ACTUAL</label>
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as PieceStatus })}
                      className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] text-neutral-textMain appearance-none cursor-pointer focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none"
                    >
                      <option value="1era_quema">1ª QUEMA</option>
                      <option value="esmaltado">ESMALTADO</option>
                      <option value="a_recogida">A RECOGIDA</option>
                      <option value="entregado">ENTREGADO</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">DESCRIPCIÓN DE LA OBRA</label>
                  <input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none" placeholder="Ej: Jarrón con textura" />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">TIPO DE ESMALTE / ACABADO</label>
                  <input value={form.glazeType} onChange={(e) => setForm({ ...form, glazeType: e.target.value })} className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none" placeholder="Ej: Blanco Mate" />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">FECHA DE ENTREGA</label>
                  <input type="date" value={form.deliveryDate} onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })} className="w-full min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] text-neutral-textMain focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none" />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">NOTAS ADICIONALES</label>
                  <textarea value={form.extraCommentary} onChange={(e) => setForm({ ...form, extraCommentary: e.target.value })} className="w-full px-4 py-2.5 bg-white border border-neutral-border rounded-[10px] text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper min-h-[100px] resize-none focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none" placeholder="..." />
                </div>

                <div className="pt-4 flex gap-3">
                  {editingPiece && (
                    <button
                      type="button"
                      onClick={() => setPieceToDelete(editingPiece.id)}
                      className="min-h-[44px] px-4 py-2.5 rounded-[10px] text-[14px] font-semibold text-[#9E3B2B] hover:bg-[#F8E1DA] transition-colors"
                    >
                      Eliminar
                    </button>
                  )}
                  <button type="submit" disabled={isSubmitting} className="flex-1 min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] text-[14px] font-semibold hover:bg-brand-hover active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed">
                    {isSubmitting ? 'GUARDANDO...' : 'GUARDAR CAMBIOS'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!pieceToDelete}
        title="¿Eliminar pieza?"
        message="¿Estás seguro de que deseas eliminar este registro? Esta acción no se puede deshacer."
        isDestructive={true}
        onConfirm={() => {
          if (pieceToDelete) {
            const id = pieceToDelete;
            setPieceToDelete(null);
            setShowModal(false);
            onDeletePiece(id);
          }
        }}
        onCancel={() => setPieceToDelete(null)}
      />
    </div>
    </>
  );
};

export default PiecesToCollect;
