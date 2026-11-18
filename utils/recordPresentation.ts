import type { ClassSession, GiftCard } from '../types';

export const getStudentSessionStatus = (session: ClassSession, studentId: string, names: string[]) => {
  if (session.businessStateByStudentId?.[studentId]?.reservationState === 'cancelled') return 'Cancelada';
  const status = session.attendanceByStudentId?.[studentId]
    ?? (session.studentIds?.length ? 'pending' : names.map(name => session.attendance?.[name.toUpperCase()]).find(Boolean))
    ?? 'pending';
  if (status === 'pending') return 'Pendiente';
  if (!session.completedAt) return status === 'present' ? 'Asistencia provisional' : 'Falta provisional';
  return status === 'present' ? 'Asistió' : 'Faltó';
};

export type GiftCardLifecycle = 'pending' | 'active' | 'consumed' | 'expired' | 'cancelled';

export const getGiftCardLifecycle = (card: GiftCard, today: string, expiryDate?: string): GiftCardLifecycle => {
  if (card.status === 'cancelled') return 'cancelled';
  if (card.status === 'consumed' || card.consumedAt || card.status === 'exhausted'
    || (card.sessionsUsed || 0) >= card.numClasses) return 'consumed';
  if (card.status === 'expired' || (expiryDate && expiryDate < today)) return 'expired';
  if (card.status === 'pending' || card.paymentStatus !== 'paid') return 'pending';
  return 'active';
};

export const sessionBusinessErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String((error as any)?.message || error || 'No se pudo guardar la sesión.');
  if (message.startsWith('Presence requires valid original credit')) {
    return 'No se puede finalizar la asistencia: la membresía o el bono original no está pagado, está vencido, archivado o no cubre esta sesión. Confirma el pago correspondiente o solicita al propietario una excepción explícita para esta sesión.';
  }
  return message;
};
