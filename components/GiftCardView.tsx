import React, { useEffect, useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { showError } from '../context/toast';
import { GiftCard, Student } from '../types';
import { ConfirmModal } from './shared/ConfirmModal';
import DiagonalPattern from './shared/DiagonalPattern';

interface GiftCardViewProps {
  giftCards: GiftCard[];
  students?: Student[];
  onAddGiftCard: (card: Omit<GiftCard, 'id' | 'createdAt'> & { recipientStudentId: string }) => Promise<void>;
  onUpdateGiftCard: (id: string, updates: Partial<GiftCard>) => Promise<void>;
  onConsumeGiftCard: (id: string, consumedAt?: string) => Promise<void>;
  onCancelGiftCard: (id: string) => Promise<void>;
  onDeleteGiftCard: (id: string) => Promise<void>;
  onConfirmGiftCardPayment?: (id: string) => Promise<void>;
}

type GiftCardForm = {
  code: string;
  buyer: string;
  buyerPhone: string;
  buyerEmail: string;
  recipient: string;
  recipientStudentId: string;
  recipientEmail: string;
  type: GiftCard['type'];
  numClasses: number;
  dedication: string;
  deliveryFormat: NonNullable<GiftCard['deliveryFormat']>;
  validityMonths: NonNullable<GiftCard['validityMonths']> | '';
  activatedAt: string;
  expiryDate: string;
  price: number;
  paymentStatus: NonNullable<GiftCard['paymentStatus']>;
  status: NonNullable<GiftCard['status']>;
  sessionsUsed: number;
  issuedDate: string;
  internalNotes: string;
};

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const addMonths = (dateValue: string, months: number) => {
  const [year, month, day] = dateValue.split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return '';
  const result = new Date(year, month - 1, day);
  result.setMonth(result.getMonth() + months);
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
};

const formatDateOnly = (value?: string) => {
  if (!value) return 'Sin fecha';
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return value;
  return new Date(year, month - 1, day).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const typeLabel = (type: GiftCard['type']) => type === 'torno' ? 'Torno' : 'Modelado';
const movementLabel = (type: NonNullable<GiftCard['movements']>[number]['type']) => ({ redeem: 'Asistencia validada', reverse: 'Asistencia corregida', manual: 'Ajuste manual', cancel: 'Anulación' }[type]);

const statusMeta: Record<NonNullable<GiftCard['status']>, { label: string; className: string }> = {
  pending: { label: 'Pendiente', className: 'bg-[#F5E8D4] text-[#916438]' },
  active: { label: 'Activo', className: 'bg-[#E7F0E8] text-[#47704D]' },
  exhausted: { label: 'Agotado', className: 'bg-[#EEE8E3] text-[#6E5145]' },
  consumed: { label: 'Consumido', className: 'bg-[#E3EDF6] text-[#2B5C86]' },
  expired: { label: 'Caducado', className: 'bg-[#F7E3DF] text-[#9C4235]' },
  cancelled: { label: 'Anulado', className: 'bg-[#F7E3DF] text-[#9C4235]' }
};

type GiftCardTab = 'active' | 'archived';
type GiftCardLifecycle = 'active' | 'consumed' | 'expired' | 'cancelled';
type DurationFilter = 'all' | 'missing' | number;

const lifecycleMeta: Record<GiftCardLifecycle, { label: string; className: string }> = {
  active: { label: 'Activo', className: 'bg-[#E7F0E8] text-[#47704D]' },
  consumed: { label: 'Consumido', className: 'bg-[#E3EDF6] text-[#2B5C86]' },
  expired: { label: 'Caducado', className: 'bg-[#F7E3DF] text-[#9C4235]' },
  cancelled: { label: 'Anulado', className: 'bg-[#F7E3DF] text-[#9C4235]' }
};

const normalizeSearchValue = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const getEffectiveExpiryDate = (card: GiftCard) => {
  const explicitExpiry = card.expiryDate?.slice(0, 10);
  if (explicitExpiry) return explicitExpiry;
  const baseDate = card.activatedAt?.slice(0, 10);
  return baseDate && card.validityMonths ? addMonths(baseDate, card.validityMonths) : undefined;
};

const getLifecycleStatus = (card: GiftCard, today: string): GiftCardLifecycle => {
  if (card.status === 'consumed' || card.consumedAt) return 'consumed';
  if (card.status === 'cancelled') return 'cancelled';
  const redeemedSessions = (card.movements || [])
    .reduce((total, movement) => total + (movement.type === 'redeem' ? movement.sessionsDelta : 0), 0);
  const hasFullConsumption = card.status === 'exhausted'
    || (card.sessionsUsed || 0) >= card.numClasses
    || redeemedSessions >= card.numClasses;
  if (hasFullConsumption) return 'consumed';
  const expiryDate = getEffectiveExpiryDate(card);
  return card.status === 'expired' || (expiryDate ? expiryDate < today : false) ? 'expired' : 'active';
};

const getFirstConsumptionDate = (card: GiftCard) => card.consumedAt || card.movements
  ?.filter(movement => movement.type === 'redeem' && movement.sessionsDelta > 0)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.createdAt;

const createInitialForm = (): GiftCardForm => {
  const activatedAt = todayKey();
  return {
    code: '', buyer: '', buyerPhone: '', buyerEmail: '', recipient: '', recipientStudentId: '', recipientEmail: '',
    type: 'modelado', numClasses: 1, dedication: '', deliveryFormat: 'digital',
    validityMonths: 6, activatedAt, expiryDate: addMonths(activatedAt, 6), price: 0,
    paymentStatus: 'pending', status: 'pending', sessionsUsed: 0, issuedDate: activatedAt,
    internalNotes: ''
  };
};

const GiftCardQr: React.FC<{ value: string }> = ({ value }) => {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value || 'CR-PENDIENTE', { width: 180, margin: 1, color: { dark: '#FF5300', light: '#FFFFFF' } })
      .then(dataUrl => { if (active) setSrc(dataUrl); })
      .catch(() => { if (active) setSrc(''); });
    return () => { active = false; };
  }, [value]);
  return src ? <img src={src} alt="Código QR del bono" className="h-28 w-28 rounded-lg border border-[#E8D9CC] bg-[#FFFCF8] p-1" /> : <div className="h-28 w-28 rounded-lg border border-dashed border-[#DDBFA4]" />;
};

const GiftCardItem: React.FC<{ card: GiftCard; lifecycleStatus: GiftCardLifecycle; onEdit: (card: GiftCard) => void }> = ({ card, lifecycleStatus, onEdit }) => {
  const status = lifecycleMeta[lifecycleStatus];
  const remaining = card.sessionsRemaining ?? Math.max(0, card.numClasses - (card.sessionsUsed || 0));
  const expiryDate = getEffectiveExpiryDate(card);
  const consumptionDate = getFirstConsumptionDate(card);
  return (
    <button type="button" onClick={() => onEdit(card)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#EDE2D8] bg-white px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-[#FCF8F4] md:grid-cols-[minmax(220px,1.6fr)_minmax(100px,.7fr)_minmax(120px,.8fr)_minmax(160px,.9fr)_auto] md:gap-4 md:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F3E7DC] text-[12px] font-bold text-[#7B3F22]">{(card.recipient || card.buyer || '?').charAt(0).toUpperCase()}</div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2"><p className="ui-card-title truncate text-[#3F2E27]">{card.recipient || 'Sin destinatario'}</p><span className="ui-meta hidden truncate font-semibold sm:inline">{card.code}</span></div>
          <p className="ui-meta truncate">Compra: {card.buyer || 'Sin comprador'}</p>
        </div>
      </div>
      <span className="hidden rounded-md bg-[#F8EEE5] px-2 py-1 text-[12px] font-semibold text-[#7B3F22] md:inline-flex">{typeLabel(card.type)}</span>
      <div className="text-right md:text-left"><strong className="text-[17px] tabular-nums text-[#3F2E27]">{remaining}</strong><span className="ui-meta ml-1">/{card.numClasses} sesiones</span></div>
        <div className="hidden min-w-0 md:block"><span className={`inline-flex rounded-full px-2 py-1 text-[12px] font-semibold ${status.className}`}>{status.label}</span><p className="ui-meta mt-1">{lifecycleStatus === 'consumed' ? `Consumida ${formatDateOnly(consumptionDate)}` : lifecycleStatus === 'cancelled' ? 'Archivada como anulada' : expiryDate ? `Caduca ${formatDateOnly(expiryDate)}` : 'Caducidad sin verificar'}</p></div>
      <span className="text-[#9B8175] md:px-2">›</span>
        <div className="col-span-2 flex items-center gap-2 border-t border-[#F0E5DB] pt-2 md:hidden"><span className="rounded-md bg-[#F8EEE5] px-2 py-1 text-[12px] font-semibold text-[#7B3F22]">{typeLabel(card.type)}</span><span className={`rounded-full px-2 py-1 text-[12px] font-semibold ${status.className}`}>{status.label}</span><span className="ui-meta ml-auto">{lifecycleStatus === 'consumed' ? `Consumida ${formatDateOnly(consumptionDate)}` : lifecycleStatus === 'cancelled' ? 'Anulada' : expiryDate ? formatDateOnly(expiryDate) : 'Sin fecha'}</span></div>
    </button>
  );
};

const GiftCardView: React.FC<GiftCardViewProps> = ({ giftCards, students = [], onAddGiftCard, onUpdateGiftCard, onConsumeGiftCard, onCancelGiftCard, onConfirmGiftCardPayment }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingCard, setEditingCard] = useState<GiftCard | null>(null);
  const [cardToDelete, setCardToDelete] = useState<string | null>(null);
  const [cardToConsume, setCardToConsume] = useState<string | null>(null);
  const [cardToConfirmPayment, setCardToConfirmPayment] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState<GiftCardForm>(createInitialForm);
  const [activeTab, setActiveTab] = useState<GiftCardTab>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('all');
  const [today, setToday] = useState(todayKey);

  const remaining = editingCard && form.numClasses === editingCard.numClasses ? editingCard.sessionsRemaining ?? Math.max(0, form.numClasses - form.sessionsUsed) : Math.max(0, form.numClasses - form.sessionsUsed);
  const termsLocked = Boolean(editingCard && (editingCard.movements?.length || editingCard.sessionsUsed || editingCard.consumedAt));
  const recipientChanged = form.recipientStudentId !== (editingCard?.recipientStudentId || '');
  const recipientAvailable = students.some(student => student.id === form.recipientStudentId);
  // An existing link remains selected even when it is absent from a refreshed student list.
  const recipientValid = Boolean(form.recipientStudentId && (recipientAvailable || (!recipientChanged && editingCard?.recipientStudentId)));
  const identityRequired = !editingCard || Boolean(editingCard.recipientStudentId) || form.recipient !== editingCard.recipient || recipientChanged;
  const matchingStudents = students.filter(student => student.id === form.recipientStudentId || normalizeSearchValue(`${student.name} ${student.surname || ''} ${student.email || ''} ${student.id}`).includes(normalizeSearchValue(recipientSearch)));

  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayKey()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting && !cardToDelete && !cardToConsume && !cardToConfirmPayment) setShowModal(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cardToConsume, cardToDelete, cardToConfirmPayment, isSubmitting, showModal]);

  const durationOptions = useMemo(() => {
    const durations = giftCards.map(card => card.validityMonths).filter((value): value is number => typeof value === 'number');
    return Array.from(new Set<number>(durations)).sort((a, b) => a - b);
  }, [giftCards]);

  const lifecycleByCard = useMemo(() => {
    const result: Record<string, GiftCardLifecycle> = {};
    giftCards.forEach(card => { result[card.id] = getLifecycleStatus(card, today); });
    return result;
  }, [giftCards, today]);

  const tabCounts = useMemo(() => {
    const counts: Record<GiftCardTab, number> = { active: 0, archived: 0 };
    giftCards.forEach(card => {
      if (lifecycleByCard[card.id] === 'active') counts.active += 1;
      else counts.archived += 1;
    });
    return counts;
  }, [giftCards, lifecycleByCard]);

  const filteredGiftCards = useMemo(() => {
    const query = normalizeSearchValue(searchQuery);
    return giftCards.filter(card => {
      const isActive = lifecycleByCard[card.id] === 'active';
      if (activeTab === 'active' ? !isActive : isActive) return false;
      if (query && !normalizeSearchValue(card.buyer || '').includes(query)) return false;
      if (durationFilter === 'missing' && card.validityMonths !== undefined) return false;
      if (typeof durationFilter === 'number' && card.validityMonths !== durationFilter) return false;
      return true;
    });
  }, [activeTab, durationFilter, giftCards, lifecycleByCard, searchQuery]);

  const handleEditClick = (card: GiftCard) => {
    const activatedAt = card.activatedAt?.slice(0, 10) || card.createdAt?.slice(0, 10) || todayKey();
    const validityMonths = card.validityMonths ?? 6;
    const lifecycleStatus = getLifecycleStatus(card, today);
    setEditingCard(card);
    setRecipientSearch('');
    setForm({
      code: card.code || '', buyer: card.buyer || '', buyerPhone: card.buyerPhone || '', buyerEmail: card.buyerEmail || '',
      recipient: card.recipient || '', recipientStudentId: card.recipientStudentId || '', recipientEmail: card.recipientEmail || '', type: card.type, numClasses: card.numClasses,
      dedication: card.dedication || '', deliveryFormat: card.deliveryFormat || 'digital', validityMonths,
      activatedAt, expiryDate: getEffectiveExpiryDate(card) || '', price: card.price || 0,
      paymentStatus: card.paymentStatus || 'pending', status: lifecycleStatus === 'consumed' ? 'consumed' : card.status || 'active', sessionsUsed: card.sessionsUsed || 0,
      issuedDate: card.issuedDate?.slice(0, 10) || '', internalNotes: card.extraCommentary || ''
    });
    setShowModal(true);
  };

  const handleCreateClick = () => { setEditingCard(null); setRecipientSearch(''); setForm(createInitialForm()); setShowModal(true); };

  const setField = <K extends keyof GiftCardForm>(key: K, value: GiftCardForm[K]) => setForm(current => {
    if (key === 'status' || key === 'sessionsUsed' || (editingCard && key === 'paymentStatus')) return current;
    if (termsLocked && (key === 'numClasses' || key === 'type')) return current;
    return { ...current, [key]: value };
  });

  const handleValidityChange = (value: NonNullable<GiftCard['validityMonths']>) => {
    if (termsLocked) return;
    setForm(current => ({ ...current, validityMonths: value, expiryDate: current.activatedAt ? addMonths(current.activatedAt, value) : '' }));
  };

  const handlePaymentChange = (value: GiftCardForm['paymentStatus']) => {
    if (editingCard || !['pending', 'paid'].includes(value)) return;
    setForm(current => ({ ...current, paymentStatus: value }));
  };

  const handleRecipientChange = (id: string) => {
    if (termsLocked) return;
    const student = students.find(candidate => candidate.id === id);
    if (id && !student) return;
    setForm(current => ({ ...current, recipientStudentId: id, ...(student ? {
      recipient: `${student.name} ${student.surname || ''}`.trim(), recipientEmail: student.email || ''
    } : {}) }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (identityRequired && !recipientValid) {
      showError('Selecciona un alumno autorizado como destinatario. El nombre no vincula una identidad ni crea alumnos.');
      return;
    }
    if (!form.buyer.trim() || !form.buyerPhone.trim() || !form.buyerEmail.trim() || !form.recipient.trim()) {
      showError('Completa comprador, teléfono, email y destinatario.');
      return;
    }
    if ((!editingCard && ![1, 2, 4].includes(form.numClasses)) || !form.validityMonths) {
      showError('Selecciona un número de sesiones válido y una vigencia para el bono.');
      return;
    }
    setIsSubmitting(true);
    const cardData: Omit<GiftCard, 'id' | 'createdAt'> = {
      code: form.code.trim() || undefined,
      buyer: form.buyer.trim(), buyerPhone: form.buyerPhone.trim(), buyerEmail: form.buyerEmail.trim(),
      recipient: form.recipient.trim(), recipientEmail: form.recipientEmail.trim(),
      type: form.type, numClasses: form.numClasses, dedication: form.dedication.trim(),
      deliveryFormat: form.deliveryFormat, price: form.price,
      extraCommentary: form.internalNotes.trim()
    };
    try {
      if (editingCard) {
        const updates: Partial<GiftCard> = {};
        for (const key of Object.keys(cardData) as (keyof typeof cardData)[]) {
          const previous = key === 'price' ? editingCard.price ?? 0 : key === 'deliveryFormat' ? editingCard.deliveryFormat || 'digital' : editingCard[key] ?? '';
          if ((cardData[key] ?? '') !== previous) Object.assign(updates, { [key]: cardData[key] });
        }
        if (recipientChanged) updates.recipientStudentId = form.recipientStudentId;
        if (form.validityMonths !== (editingCard.validityMonths ?? 6)) updates.validityMonths = form.validityMonths;
        if (Object.keys(updates).length) await onUpdateGiftCard(editingCard.id, updates);
      } else {
        await onAddGiftCard({ ...cardData, recipientStudentId: form.recipientStudentId, validityMonths: form.validityMonths, paymentStatus: form.paymentStatus });
      }
      setShowModal(false);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'No se pudo guardar el bono.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getPreviewCard = (): GiftCard => ({
    ...form, id: editingCard?.id || 'preview', code: form.code || 'CR-PENDIENTE', createdAt: editingCard?.createdAt || new Date().toISOString(),
    buyer: form.buyer || 'Casa Rosier', recipient: form.recipient || 'Destinatario'
  });

  const downloadPdf = async () => {
    const card = getPreviewCard();
    const code = card.code || card.id;
    const qr = await QRCode.toDataURL(code, { width: 260, margin: 1, color: { dark: '#FF5300', light: '#FFFFFF' } });
    const pdf = new jsPDF({ unit: 'mm', format: 'a5' });
    pdf.setFillColor(247, 244, 240); pdf.rect(0, 0, 148, 210, 'F');
    pdf.setTextColor(255, 83, 0); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(24); pdf.text('BARRO & CO.', 16, 25);
    pdf.setFontSize(10); pdf.setTextColor(92, 102, 119); pdf.text('BONO DE CLASE TEMPORAL', 16, 33);
    pdf.setTextColor(23, 35, 56); pdf.setFontSize(18); pdf.text(`Experiencia de ${typeLabel(card.type)}`, 16, 52);
    pdf.setFontSize(12); pdf.text(`${card.numClasses} ${card.numClasses === 1 ? 'sesión' : 'sesiones'} de cerámica`, 16, 62);
    pdf.setFontSize(11); pdf.setTextColor(92, 102, 119); pdf.text(`Para: ${card.recipient}`, 16, 76); pdf.text(`Válido hasta: ${formatDateOnly(card.expiryDate)}`, 16, 84);
    if (card.dedication) { pdf.setFont('helvetica', 'italic'); pdf.text(`“${card.dedication.slice(0, 70)}”`, 16, 98, { maxWidth: 95 }); }
    pdf.addImage(qr, 'PNG', 101, 112, 31, 31); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.setTextColor(255, 83, 0); pdf.text(code, 16, 128);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(92, 102, 119); pdf.text('Reserva posteriormente según disponibilidad.', 16, 164); pdf.text('Presenta este código al validar cada sesión.', 16, 171);
    pdf.save(`${code}.pdf`);
  };

  const sendByEmail = () => {
    const recipient = form.recipientEmail || form.buyerEmail;
    if (!recipient) { showError('Añade un email del comprador o destinatario.'); return; }
    const card = getPreviewCard();
    const subject = encodeURIComponent(`Tu bono de cerámica ${card.code}`);
    const body = encodeURIComponent(`Hola ${card.recipient},\n\nTu bono de ${typeLabel(card.type)} incluye ${card.numClasses} sesiones.\nCódigo: ${card.code}\nCaducidad: ${formatDateOnly(card.expiryDate)}\n\nReserva según disponibilidad en Casa Rosier.`);
    window.location.href = `mailto:${recipient}?subject=${subject}&body=${body}`;
  };

  const requestDelete = () => { if (editingCard) setCardToDelete(editingCard.id); };
  const requestConsume = () => {
    if (editingCard && lifecycleByCard[editingCard.id] === 'active') setCardToConsume(editingCard.id);
  };
  const confirmConsume = async () => {
    if (!cardToConsume) return;
    setIsSubmitting(true);
    try {
      await onConsumeGiftCard(cardToConsume);
      setCardToConsume(null);
      setShowModal(false);
      setEditingCard(null);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'No se pudo consumir el bono.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmPayment = async () => {
    if (!cardToConfirmPayment || !onConfirmGiftCardPayment || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirmGiftCardPayment(cardToConfirmPayment);
      setCardToConfirmPayment(null);
      setShowModal(false);
      setEditingCard(null);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'No se pudo confirmar el pago del bono.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-base">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-20 pt-4 custom-scrollbar md:px-8 md:pt-6 lg:px-10">
        <header className="relative mb-4 flex flex-col gap-3 overflow-hidden rounded-[20px] bg-brand-soft px-5 py-4 md:flex-row md:items-center md:justify-between md:px-6">
          <DiagonalPattern />
          <div className="relative z-10"><h1 className="ui-page-title text-neutral-textMain">Tarjetas de Regalo</h1><p className="mt-0.5 text-[13px] font-semibold text-brand">Gift Card Casa Rosier</p><p className="ui-meta mt-1">Bonos independientes de las membresías, con saldo y vigencia propios.</p></div>
          <button type="button" onClick={handleCreateClick} className="relative z-10 inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 self-start rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-brand-hover md:self-center"><span className="text-lg leading-none">+</span><span className="hidden sm:inline">Nueva tarjeta</span><span className="sm:hidden">Nueva</span></button>
        </header>
         <section className="mb-4 space-y-3" aria-label="Filtros de tarjetas de regalo">
           <div className="flex flex-col gap-2.5 md:flex-row md:items-center">
             <label className="relative min-w-0 flex-1">
               <span className="sr-only">Buscar por comprador</span>
               <svg className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0" /></svg>
               <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Buscar por nombre del comprador" aria-label="Buscar tarjeta por nombre del comprador" className="h-11 w-full rounded-[10px] border border-[#DDBFA4] bg-white pl-10 pr-4 text-[13px] text-[#3F2E27] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15" />
             </label>
             <label className="relative w-full md:w-[210px]">
               <span className="sr-only">Filtrar por duración</span>
               <select value={String(durationFilter)} onChange={event => setDurationFilter(event.target.value === 'all' ? 'all' : event.target.value === 'missing' ? 'missing' : Number(event.target.value))} aria-label="Filtrar por duración y caducidad" className="h-11 w-full appearance-none rounded-[10px] border border-[#DDBFA4] bg-white px-3.5 pr-9 text-[13px] text-[#3F2E27] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15">
                 <option value="all">Todas las duraciones</option>
                 {durationOptions.map(months => <option key={months} value={months}>{months} {months === 1 ? 'mes' : 'meses'}</option>)}
                 {giftCards.some(card => card.validityMonths === undefined) && <option value="missing">Sin duración registrada</option>}
               </select>
               <svg className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="m7 10 5 5 5-5" /></svg>
             </label>
           </div>
           <div className="flex gap-2 overflow-x-auto border-b border-[#DDBFA4] pb-0 no-scrollbar" role="tablist" aria-label="Estado de tarjetas">
              {(['active', 'archived'] as GiftCardTab[]).map(tab => <button key={tab} type="button" onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} className={`min-h-9 shrink-0 border-b-2 px-3 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${activeTab === tab ? 'border-brand text-brand' : 'border-transparent text-neutral-textHelper hover:text-brand'}`}>{tab === 'active' ? 'Activos' : 'Archivados'} <span className="ml-1 opacity-70">{tabCounts[tab]}</span></button>)}
           </div>
         </section>
         <section className="overflow-hidden rounded-[16px] border border-[#E8D9CC] bg-white"><div className="hidden grid-cols-[minmax(220px,1.6fr)_minmax(100px,.7fr)_minmax(120px,.8fr)_minmax(160px,.9fr)_auto] gap-4 border-b border-[#EDE2D8] bg-[#F8EEE5] px-5 py-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-[#8B6B5E] md:grid"><span>Comprador / destinatario</span><span>Experiencia</span><span>Saldo</span><span>Estado</span><span></span></div>{filteredGiftCards.length === 0 ? <div className="py-14 text-center"><p className="text-[14px] font-semibold text-[#3F2E27]">No hay tarjetas que coincidan</p><p className="ui-secondary mt-1">Prueba a cambiar la búsqueda, duración o pestaña activa.</p></div> : filteredGiftCards.map(card => <GiftCardItem key={card.id} card={card} lifecycleStatus={lifecycleByCard[card.id]} onEdit={handleEditClick} />)}</section>
      </div>

       {showModal && <div className="fixed inset-0 z-[100] flex items-end bg-[#2F1E17]/45 p-0 backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-5"><form onSubmit={handleSubmit} className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#FFFCF8] text-[#2F211B] shadow-[0_24px_70px_rgba(59,35,24,0.2)] sm:h-auto sm:max-h-[94dvh] sm:max-w-3xl sm:rounded-[24px] sm:border sm:border-[#E8D9CC]"><header className="flex shrink-0 items-start justify-between border-b border-[#E8D9CC] px-5 py-4 sm:px-8"><div><p className="ui-label uppercase tracking-[0.16em] text-[#B07D4E]">Gestión de gift card</p><h2 className="ui-section-title mt-1 font-['Playfair_Display'] text-[#7B3F22]">{editingCard ? 'Editar bono temporal' : 'Nuevo bono temporal'}</h2><p className="ui-meta mt-1">Sin reserva automática. El saldo se descuenta al validar asistencia.</p></div><button type="button" onClick={() => setShowModal(false)} className="flex h-10 w-10 items-center justify-center rounded-full text-[#8B6B5E] hover:bg-[#F3E7DC]" aria-label="Cerrar"><svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 18 18 6M6 6l12 12" /></svg></button></header><div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 custom-scrollbar sm:px-8">
          <fieldset className="rounded-[14px] border border-[#E8D9CC] bg-white p-4"><legend className="px-1 text-[11px] font-bold uppercase tracking-[0.15em] text-[#7B3F22]">01 · Comprador</legend><div className="grid gap-3 md:grid-cols-2"><Field label="Nombre del comprador" required value={form.buyer} onChange={value => setField('buyer', value)} placeholder="Nombre completo" /><Field label="Teléfono" required type="tel" value={form.buyerPhone} onChange={value => setField('buyerPhone', value)} placeholder="+34 600 000 000" /><Field label="Email" required type="email" value={form.buyerEmail} onChange={value => setField('buyerEmail', value)} placeholder="comprador@email.com" /></div></fieldset>
          <fieldset className="rounded-[14px] border border-[#E8D9CC] bg-white p-4">
            <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.15em] text-[#7B3F22]">02 · Destinatario</legend>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Buscar alumno destinatario" value={recipientSearch} onChange={setRecipientSearch} disabled={termsLocked} placeholder="Nombre, email o identidad" />
              <SelectField label="Alumno destinatario" value={form.recipientStudentId} onChange={handleRecipientChange} disabled={termsLocked} options={[
                ['', 'Selecciona un alumno existente'],
                ...(!recipientAvailable && form.recipientStudentId ? [[form.recipientStudentId, `Vinculo existente: ${form.recipientStudentId}`]] : []),
                ...matchingStudents.map(student => [student.id, `${student.name} ${student.surname || ''} | ${student.email || student.studentCategory || 'Alumno'} | ${student.id}`])
              ]} />
              <p className={`md:col-span-2 text-[12px] ${identityRequired && !recipientValid ? 'text-[#9C4235]' : 'text-[#6E5145]'}`} role="status">
                {identityRequired && !recipientValid ? 'Sin alumno seleccionado: no se puede guardar. Busca y selecciona una identidad autorizada.' : form.recipientStudentId ? `Identidad vinculada: ${form.recipientStudentId}. Editar el nombre no cambia el alumno.` : 'Bono antiguo sin identidad. Selecciona un alumno antes de cambiar el destinatario o confirmar su pago.'}
                {' '}No se crean alumnos ni se vinculan por coincidencia de nombre.
              </p>
              {termsLocked && <p className="md:col-span-2 text-[12px] text-[#6E5145]">El destinatario y las condiciones no se pueden cambiar tras un movimiento.</p>}
              <Field label="Nombre del destinatario" required value={form.recipient} onChange={value => setField('recipient', value)} placeholder="Nombre mostrado en el bono" />
              <Field label="Email del destinatario" type="email" value={form.recipientEmail} onChange={value => setField('recipientEmail', value)} placeholder="Opcional" />
              <label className="md:col-span-2"><span className="mb-1.5 block text-[11px] font-semibold text-[#6E5145]">Dedicatoria personalizada</span><textarea value={form.dedication} onChange={event => setField('dedication', event.target.value)} maxLength={180} rows={2} className="w-full resize-none rounded-[9px] border border-[#DDBFA4] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#C68952]" placeholder="Un mensaje breve para la experiencia..." /></label>
            </div>
          </fieldset>
           <fieldset className="rounded-[14px] border border-[#E8D9CC] bg-white p-4"><legend className="px-1 text-[11px] font-bold uppercase tracking-[0.15em] text-[#7B3F22]">03 · Bono temporal</legend><div className="grid gap-3 md:grid-cols-2"><SelectField label="Tipo de clase" value={form.type} disabled={termsLocked} onChange={value => setField('type', value as GiftCard['type'])} options={[['modelado', 'Modelado'], ['torno', 'Torno']]} /><SelectField label="Número de sesiones" value={String(form.numClasses)} disabled={termsLocked} onChange={value => setField('numClasses', Number(value))} options={[...(![1, 2, 4].includes(form.numClasses) ? [[String(form.numClasses), `${form.numClasses} sesiones (existente)`]] : []), ['1', '1 sesión'], ['2', '2 sesiones'], ['4', '4 sesiones']]} /><SelectField label="Formato de entrega" value={form.deliveryFormat} onChange={value => setField('deliveryFormat', value as NonNullable<GiftCard['deliveryFormat']>)} options={[['digital', 'Digital'], ['physical', 'Físico']]} /><Field label="Importe del bono (€)" type="number" value={String(form.price || '')} onChange={value => setField('price', Number(value) || 0)} placeholder="0" /><SelectField label="Vigencia" value={String(form.validityMonths)} disabled={termsLocked} onChange={value => handleValidityChange(Number(value) as NonNullable<GiftCard['validityMonths']>)} options={[['3', '3 meses'], ['6', '6 meses'], ['8', '8 meses']]} /><div className="flex items-end rounded-[10px] bg-[#F8EEE5] px-3 py-2"><div><span className="block text-[11px] uppercase tracking-[0.12em] text-[#9B8175]">Regla</span><strong className="text-[12px] text-[#7B3F22]">{editingCard ? `Caducidad guardada: ${formatDateOnly(editingCard.expiryDate)}` : 'Caducidad calculada por el servidor al guardar'}</strong></div></div></div></fieldset>
          <fieldset className="rounded-[14px] border border-[#E8D9CC] bg-white p-4">
            <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.15em] text-[#7B3F22]">04 · Control interno</legend>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Código de validación" value={form.code} onChange={value => setField('code', value.toUpperCase())} placeholder="Se genera automáticamente" />
              <SelectField label="Estado del pago" value={form.paymentStatus} disabled={Boolean(editingCard)} onChange={value => handlePaymentChange(value as GiftCardForm['paymentStatus'])} options={[['pending', 'Pendiente'], ['paid', 'Pagado'], ...(editingCard?.paymentStatus === 'refunded' ? [['refunded', 'Reembolsado']] : [])]} />
              <SelectField label="Estado del bono" value={form.status} disabled onChange={() => {}} options={Object.entries(statusMeta).map(([value, meta]) => [value, meta.label])} />
              <Field label="Sesiones utilizadas" type="number" value={String(form.sessionsUsed)} disabled onChange={() => {}} placeholder="0" />
              <p className="md:col-span-2 text-[12px] text-[#6E5145]">El servidor controla el pago de bonos existentes, la caducidad, el estado y el saldo.</p>
              {editingCard?.paymentStatus === 'pending' && editingCard.status === 'pending' && <div className="md:col-span-2">
                <button type="button" disabled={isSubmitting || !onConfirmGiftCardPayment || !editingCard.recipientStudentId} onClick={() => setCardToConfirmPayment(editingCard.id)} className="rounded-[9px] bg-[#47704D] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">Confirmar pago del bono</button>
                {!onConfirmGiftCardPayment && <p className="mt-1 text-[12px] text-[#6E5145]">Confirmación de pago no disponible hasta conectar la operación autorizada.</p>}
                {!editingCard.recipientStudentId && <p className="mt-1 text-[12px] text-[#9C4235]">Guarda primero la identidad del destinatario.</p>}
              </div>}
              <div className="rounded-[10px] border border-[#DDBFA4] bg-[#FFFCF8] px-3 py-2"><span className="block text-[11px] uppercase tracking-[0.12em] text-[#9B8175]">Sesiones restantes</span><strong className="text-[20px] text-[#7B3F22]">{remaining}</strong><span className="ml-1 text-[11px] text-[#8B6B5E]">de {form.numClasses}</span></div>
              <div className="rounded-[10px] border border-[#E8D9CC] bg-[#FFFCF8] px-3 py-2"><span className="block text-[11px] uppercase tracking-[0.12em] text-[#9B8175]">Fecha de creación</span><strong className="text-[12px] text-[#7B3F22]">{editingCard ? formatDateOnly(editingCard.createdAt) : 'Al guardar'}</strong></div>
              <label><span className="mb-1.5 block text-[11px] font-semibold text-[#6E5145]">Observaciones internas</span><textarea value={form.internalNotes} onChange={event => setField('internalNotes', event.target.value)} rows={2} className="w-full resize-none rounded-[9px] border border-[#DDBFA4] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#C68952]" placeholder="Notas administrativas..." /></label>
            </div>
            {editingCard?.movements && editingCard.movements.length > 0 && <div className="mt-4 rounded-[10px] border border-[#E8D9CC] bg-[#FFFCF8] p-3"><p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7B3F22]">Historial de uso</p><div className="mt-2 max-h-28 space-y-2 overflow-y-auto">{editingCard.movements.slice(0, 8).map(movement => <div key={movement.id} className="flex items-center justify-between gap-3 text-[11px]"><span className="text-[#6E5145]">{movementLabel(movement.type)}</span><span className={movement.sessionsDelta > 0 ? 'font-semibold text-[#9C4235]' : 'font-semibold text-[#47704D]'}>{movement.sessionsDelta > 0 ? `-${movement.sessionsDelta}` : `+${Math.abs(movement.sessionsDelta)}`} sesión · {formatDateOnly(movement.createdAt)}</span></div>)}</div></div>}
            <div className="mt-4 flex flex-col gap-3 rounded-[12px] bg-[#F8EEE5] p-3 sm:flex-row sm:items-center"><GiftCardQr value={form.code || 'CR-PENDIENTE'} /><div className="min-w-0"><p className="text-[11px] font-semibold text-[#7B3F22]">Código QR de validación</p><p className="mt-1 break-all text-[12px] text-[#8B6B5E]">{form.code || 'Se generará al guardar el bono'}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={downloadPdf} className="rounded-[8px] bg-[#7B3F22] px-3 py-2 text-[11px] font-semibold text-white hover:bg-[#5F301C]">Descargar PDF</button><button type="button" onClick={sendByEmail} className="rounded-[8px] border border-[#DDBFA4] bg-white px-3 py-2 text-[11px] font-semibold text-[#7B3F22] hover:bg-[#FFF9F4]">Preparar email</button></div></div></div>
          </fieldset>
         </div><footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#E8D9CC] bg-white px-5 py-4 sm:px-8">{editingCard && lifecycleByCard[editingCard.id] === 'active' && editingCard.paymentStatus === 'paid' && editingCard.recipientStudentId && <button type="button" disabled={isSubmitting} onClick={requestConsume} className="text-[12px] font-semibold text-[#2B5C86] hover:text-[#1D4768]">Bono consumido</button>}{editingCard ? <button type="button" disabled={isSubmitting} onClick={requestDelete} className="text-[11px] font-semibold text-[#9C4235] hover:text-[#7B3F22]">Anular / eliminar</button> : <span className="text-[11px] text-[#9B8175]">El código se genera al guardar</span>}<div className="ml-auto flex gap-2"><button type="button" disabled={isSubmitting} onClick={() => setShowModal(false)} className="rounded-[9px] px-4 py-2.5 text-[12px] font-semibold text-[#8B6B5E] hover:bg-[#F8EEE5]">Cancelar</button><button type="submit" disabled={isSubmitting || (identityRequired && !recipientValid)} className="rounded-[9px] bg-[#C68952] px-5 py-2.5 text-[12px] font-semibold text-white hover:bg-[#B87543] disabled:cursor-not-allowed disabled:opacity-60">{isSubmitting ? 'Guardando…' : editingCard ? 'Guardar cambios' : 'Crear bono'}</button></div></footer></form></div>}

        <ConfirmModal isOpen={!!cardToDelete} title="¿Anular este bono?" message="El bono quedará anulado y no podrá utilizarse. Sus movimientos históricos se conservarán." confirmText="Anular bono" isDestructive loading={isSubmitting} onConfirm={async () => { if (!cardToDelete) return; setIsSubmitting(true); try { await onCancelGiftCard(cardToDelete); setCardToDelete(null); setShowModal(false); } finally { setIsSubmitting(false); } }} onCancel={() => setCardToDelete(null)} />
       <ConfirmModal isOpen={!!cardToConsume} title="¿Marcar bono como consumido?" message="Se archivará como consumido y ya no podrá utilizarse. Toda la información y el historial se conservarán." confirmText="Bono consumido" isDestructive={false} loading={isSubmitting} loadingText="Guardando..." onConfirm={confirmConsume} onCancel={() => setCardToConsume(null)} />
       <ConfirmModal isOpen={!!cardToConfirmPayment} title="¿Confirmar pago del bono?" message="Se confirmará el pago del bono guardado mediante la operación autorizada. Los cambios sin guardar de este formulario no se aplicarán." confirmText="Confirmar pago" isDestructive={false} loading={isSubmitting} onConfirm={confirmPayment} onCancel={() => setCardToConfirmPayment(null)} />
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; disabled?: boolean; placeholder?: string }> = ({ label, value, onChange, type = 'text', required, disabled, placeholder }) => <label><span className="ui-label mb-1.5 block text-[#6E5145]">{label}{required && <span className="text-[#9C4235]"> *</span>}</span><input aria-label={label} required={required} disabled={disabled} type={type} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} className="ui-control w-full rounded-[9px] border border-[#DDBFA4] bg-white px-3 py-2 text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 disabled:opacity-60" /></label>;

const SelectField: React.FC<{ label: string; value: string; onChange: (value: string) => void; options: string[][]; disabled?: boolean }> = ({ label, value, onChange, options, disabled }) => (
  <label>
    <span className="ui-label mb-1.5 block text-[#6E5145]">{label}</span>
    <span className="relative block">
      <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} className="ui-control w-full appearance-none rounded-[9px] border border-[#DDBFA4] bg-white px-3 py-2 pr-9 text-[#2F211B] outline-none transition focus:border-[#C68952] focus:ring-2 focus:ring-[#C68952]/20 disabled:opacity-60">
        {options.map(([optionValue, labelValue]) => <option key={optionValue} value={optionValue}>{labelValue}</option>)}
      </select>
      <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B6B5E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m7 10 5 5 5-5" /></svg>
    </span>
  </label>
);

export default GiftCardView;
