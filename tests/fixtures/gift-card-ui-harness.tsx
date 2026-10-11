import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import GiftCardView from '../../components/GiftCardView';
import type { GiftCard, Student } from '../../types';

const memberId = '20000000-0000-0000-0000-000000000001';
const temporaryId = '20000000-0000-0000-0000-000000000002';
const authorizedStudents: Student[] = [
  { id: memberId, name: 'Alex', surname: 'Perez', email: 'member@example.test', phone: '111', studentCategory: 'membresia', status: 'membresia', classesRemaining: 0 },
  { id: temporaryId, name: 'Alex', surname: 'Perez', email: 'temporary@example.test', phone: '222', studentCategory: 'temporal', status: 'new', classesRemaining: 0 }
];
const base: GiftCard = { id: '', code: '', buyer: 'Comprador local', buyerPhone: '555', buyerEmail: 'buyer@example.test',
  recipient: 'Etiqueta conservada', recipientStudentId: temporaryId, numClasses: 2, type: 'modelado', validityMonths: 6,
  activatedAt: '2026-01-31', expiryDate: '2027-04-30', paymentStatus: 'paid', status: 'active', sessionsUsed: 0,
  createdAt: '2026-01-31T10:00:00Z' };
const cycle: GiftCard = { ...base, id: 'cycle', code: 'CR-CYCLE', recipient: 'Bono con ciclo', sessionsUsed: 1, sessionsRemaining: 1,
  movements: [
    { id: 'cycle-redeem-1', giftCardId: 'cycle', sessionId: 'cycle-session', studentId: temporaryId, type: 'redeem', sessionsDelta: 1, createdAt: '2026-10-08T12:00:00Z' },
    { id: 'cycle-reverse', giftCardId: 'cycle', sessionId: 'cycle-session', studentId: temporaryId, type: 'reverse', sessionsDelta: -1, createdAt: '2026-10-09T12:00:00Z' },
    { id: 'cycle-redeem-2', giftCardId: 'cycle', sessionId: 'cycle-session', studentId: temporaryId, type: 'redeem', sessionsDelta: 1, createdAt: '2026-10-10T12:00:00Z' }
  ] };
const duplicateHistory: GiftCard = { ...cycle, id: 'duplicate-history', code: 'CR-DUPLICATE', recipient: 'Bono con duplicados',
  movements: [...cycle.movements!, { ...cycle.movements![2], id: 'duplicate-redeem' }]
    .map(movement => ({ ...movement, giftCardId: 'duplicate-history' })) };
const fixtures: GiftCard[] = [
  { ...base, id: 'linked', code: 'CR-LINKED' },
  { ...base, id: 'pending', code: 'CR-PENDING', recipient: 'Pago pendiente', status: 'pending', paymentStatus: 'pending' },
  { ...base, id: 'legacy', code: 'CR-LEGACY', recipient: 'Bono antiguo', recipientStudentId: undefined, validityMonths: undefined, expiryDate: undefined },
  { ...base, id: 'missing', code: 'CR-MISSING', recipient: 'Vinculo fuera de lista', recipientStudentId: '20000000-0000-0000-0000-000000000003' },
  { ...base, id: 'used', code: 'CR-USED', recipient: 'Bono con historial', numClasses: 3, sessionsUsed: 1,
    movements: [{ id: 'movement', giftCardId: 'used', sessionId: 'session', studentId: temporaryId, type: 'redeem', sessionsDelta: 1, createdAt: '2026-10-10T12:00:00Z' }] },
  { ...base, id: 'archived', code: 'CR-ARCHIVED', buyer: 'Comprador archivado', recipient: 'Bono archivado', status: 'consumed', sessionsUsed: 2, consumedAt: '2026-10-10' },
  cycle,
  duplicateHistory,
  { ...duplicateHistory, id: 'unknown-balance', code: 'CR-UNKNOWN', recipient: 'Historial sin saldo', status: undefined, sessionsUsed: undefined, sessionsRemaining: undefined,
    movements: duplicateHistory.movements!.map(movement => ({ ...movement, giftCardId: 'unknown-balance' })) },
  { ...cycle, id: 'manual-cycle', code: 'CR-MANUAL', recipient: 'Consumo manual corregido', status: 'consumed', consumedAt: '2026-10-09',
    movements: [cycle.movements![0],
      { id: 'manual-consumption', giftCardId: 'manual-cycle', type: 'manual' as const, sessionsDelta: 1, createdAt: '2026-10-09T11:00:00Z' },
      cycle.movements![1]].map(movement => ({ ...movement, giftCardId: 'manual-cycle' })) },
  { ...base, id: 'legacy-consumed', code: 'CR-LEGACY-CONSUMED', recipient: 'Consumo antiguo fechado', status: undefined, sessionsUsed: undefined, consumedAt: '2026-10-09' },
  { ...base, id: 'exhausted', code: 'CR-EXHAUSTED', recipient: 'Agotado antiguo', status: 'exhausted', sessionsUsed: undefined },
  { ...cycle, id: 'cancelled-cycle', code: 'CR-CANCELLED', recipient: 'Ciclo anulado', status: 'cancelled',
    movements: [...cycle.movements!, { id: 'cycle-cancel', giftCardId: 'cancelled-cycle', type: 'cancel' as const, sessionsDelta: 0, createdAt: '2026-10-11T12:00:00Z' }]
      .map(movement => ({ ...movement, giftCardId: 'cancelled-cycle' })) },
  { ...cycle, id: 'expired-cycle', code: 'CR-EXPIRED', recipient: 'Ciclo caducado', status: 'expired',
    movements: cycle.movements!.map(movement => ({ ...movement, giftCardId: 'expired-cycle' })) }
];

const Harness = () => {
  const [students, setStudents] = useState(authorizedStudents);
  const [cards, setCards] = useState(fixtures);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [mode, setMode] = useState('success');
  const [paymentConnected, setPaymentConnected] = useState(true);
  useEffect(() => {
    const remove = () => setStudents([]);
    window.addEventListener('gift-card-test-remove-students', remove);
    return () => window.removeEventListener('gift-card-test-remove-students', remove);
  }, []);
  const record = async (action: string, id?: string, data?: unknown) => {
    setCalls(current => [...current, { action, id, data }]);
    if (mode === 'failure') throw new Error('Fallo sintetico: no se guardo el bono.');
    if (mode === 'waiting') await new Promise<void>(resolve => window.addEventListener('gift-card-test-release', () => resolve(), { once: true }));
  };
  return <>
    <nav aria-label="Controles sinteticos">
      <button onClick={() => setMode('failure')}>Simular fallo</button>
      <button onClick={() => setMode('waiting')}>Simular espera</button>
      <button onClick={() => setPaymentConnected(false)}>Desconectar pago</button>
      <button onClick={() => setStudents([])}>Vaciar alumnos autorizados</button>
    </nav>
    <output data-testid="calls">{JSON.stringify(calls)}</output>
    <output data-testid="student-identities">{JSON.stringify(students.map(student => student.id))}</output>
    <output data-testid="gift-card-snapshots" hidden>{JSON.stringify(cards)}</output>
    <GiftCardView giftCards={cards} students={students}
      onAddGiftCard={async data => { await record('create', undefined, data); setCards(current => [...current, { ...data, id: 'created', createdAt: '2026-10-11T12:00:00Z', status: data.paymentStatus === 'paid' ? 'active' : 'pending', sessionsUsed: 0, expiryDate: '2027-04-11' }]); }}
      onUpdateGiftCard={async (id, data) => { await record('update', id, data); setCards(current => current.map(card => card.id === id ? { ...card, ...data } : card)); }}
      onConfirmGiftCardPayment={paymentConnected ? async id => { await record('confirm_gift_card_payment', id); setCards(current => current.map(card => card.id === id ? { ...card, paymentStatus: 'paid', status: 'active' } : card)); } : undefined}
      onConsumeGiftCard={async (id, consumedAt) => { await record('consume_gift_card', id, consumedAt); setCards(current => current.map(card => card.id === id ? { ...card, status: 'consumed', sessionsUsed: card.numClasses } : card)); }}
      onCancelGiftCard={async id => { await record('cancel_gift_card', id); setCards(current => current.map(card => card.id === id ? { ...card, status: 'cancelled' } : card)); }}
      onDeleteGiftCard={async () => { throw new Error('Deletion must use cancellation'); }} />
  </>;
};
createRoot(document.getElementById('root')!).render(<Harness />);
