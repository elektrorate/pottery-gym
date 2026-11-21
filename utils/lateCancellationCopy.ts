import type { Student } from '../types';
import { isPaymentPendingToday } from './paymentPending';

type BusinessSlice = {
  cancellationKind?: 'timely' | 'late';
  penaltyState?: string;
  billingState?: string;
};

/**
 * What a late cancellation actually does for this student, before and after
 * the attendance is finalized. A pending bono payment is not discounted.
 */
export const lateCancellationOutcome = (student: Student | undefined, business: BusinessSlice | undefined, today: string) => {
  const paymentPending = !!student && isPaymentPendingToday(student, today);
  const resolved = business?.penaltyState === 'charged' || business?.billingState === 'charged';
  const waiting = business?.penaltyState === 'pending' || business?.billingState === 'incident';
  if (paymentPending && !resolved) {
    return waiting
      ? 'Penalización pendiente de resolución: el pago está pendiente, así que no se ha descontado ninguna clase. Confirme el pago del bono o elija «Descontar una clase» en la ficha.'
      : 'Cancelación tardía: el pago está pendiente, así que no se descontará una clase al finalizar. Confirme el pago o use «Descontar una clase» si quiere consumirla.';
  }
  if (resolved) return 'Cancelación tardía: se descontó una clase.';
  if (waiting) return 'Penalización pendiente de resolución. Confirme el descuento o exímalo desde la ficha del alumno.';
  return 'Cancelación tardía: se descuenta una clase al finalizar el control de asistencia.';
};

export const cancellationPreview = (hoursUntilStart: number | null) => {
  if (hoursUntilStart == null) return 'Indique la hora de la sesión para saber si se descuenta una clase.';
  if (hoursUntilStart >= 8) return 'Faltan 8 horas o más: no se descontará ninguna clase.';
  return 'Faltan menos de 8 horas: se descontará una clase al finalizar, salvo que el pago del bono esté pendiente.';
};
