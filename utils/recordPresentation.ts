import type { ClassSession, GiftCard } from '../types';

export const getStudentSessionStatus = (session: ClassSession, studentId: string, names: string[]) => {
  if (session.businessStateByStudentId?.[studentId]?.reservationState === 'cancelled') return 'Cancelada';
  const status = session.attendanceByStudentId?.[studentId]
    ?? (session.studentIds?.length ? 'pending' : names.map(name => session.attendance?.[name.toUpperCase()]).find(Boolean))
    ?? 'pending';
  if (status === 'pending') return 'Pendiente';
  if (!session.completedAt) return status === 'present' ? 'Asistencia provisional' : 'Falta provisional';
  return status === 'present' ? 'Asistió' : 'Faltó sin avisar';
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
  if (/No-credit exception cannot bypass available credit/i.test(message)) {
    const reason = message.split(':').slice(1).join(':').toLowerCase();
    if (reason.includes('payment is unpaid or unknown') || reason.includes('unpaid or unknown')) {
      return 'El alumno todavía tiene clases disponibles, pero el pago está pendiente. Confirme el pago o use «Descontar una clase».';
    }
    return 'El alumno aún tiene clases disponibles; use Descontar una clase.';
  }
  if (/Original scalar pack payment is unpaid or unknown/i.test(message)) {
    return 'El alumno todavía tiene clases disponibles, pero el pago está pendiente. Confirme el pago o use «Descontar una clase».';
  }
  if (/Membership override requires known original positive credit/i.test(message)) {
    return 'No se puede descontar la clase: la membresía no tiene un saldo positivo conocido. Revise el período o deje asistir sin descontar.';
  }
  if (/Session exception is stale/i.test(message)) {
    return 'La excepción quedó desactualizada. Vuelva a aprobarla de forma explícita antes de finalizar.';
  }
  if (message.startsWith('Presence requires valid original credit')) {
    return 'No se puede finalizar la asistencia: confirme el pago o apruebe una excepción para esta sesión.';
  }
  if (message.startsWith('Only this workshop owner may approve an exception when the original membership is unpaid, expired or does not cover the session')) {
    return 'Solo el propietario del taller puede aprobar esta excepción cuando la membresía está pendiente, vencida o no cubre la sesión.';
  }
  if (/session_business_exceptions/i.test(message) && /check constraint/i.test(message)) {
    return 'No se pudo aprobar la excepción. El descuento tiene que corresponder a la membresía o al bono de clases, sin mezclar un bono regalo. Elige el tipo que descuenta una clase y vuelve a intentarlo.';
  }
  return message;
};
