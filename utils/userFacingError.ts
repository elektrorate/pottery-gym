import { businessReasonLabel } from './businessReasonLabels';

const PENDING_PAYMENT = 'El alumno todavía tiene clases disponibles, pero el pago está pendiente. Confirme el pago o use «Descontar una clase».';
const CREDIT_STILL_AVAILABLE = 'El alumno aún tiene clases disponibles; use Descontar una clase.';

/** The suffix after «No-credit exception cannot bypass available credit» decides the sentence. */
export const noCreditExceptionMessage = (message: string): string | null => {
  const match = /No-credit exception cannot bypass available credit(?::\s*([\s\S]*))?/i.exec(message);
  if (!match) return null;
  const reason = (match[1] || '').toLowerCase();
  if (reason.includes('payment is unpaid or unknown') || reason.includes('unpaid or unknown')) return PENDING_PAYMENT;
  return CREDIT_STILL_AVAILABLE;
};

const EXACT: Array<[RegExp, string]> = [
  [/Original scalar pack payment is unpaid or unknown/i,
    'El alumno todavía tiene clases del bono disponibles, pero el pago del bono está pendiente. Confirme el pago o use «Descontar una clase».'],
  [/Membership override requires known original positive credit/i,
    'No se puede descontar la clase: la membresía no tiene un saldo positivo conocido. Revise el período o elija dejar asistir sin descontar.'],
  [/Session exception is stale; explicit reapproval required/i,
    'La excepción quedó desactualizada. Vuelva a aprobarla de forma explícita antes de finalizar.'],
  [/Presence requires valid original credit/i,
    'No se puede finalizar la asistencia: confirme el pago o apruebe una excepción para esta sesión.'],
  [/Only this workshop owner may approve an exception/i,
    'Solo el propietario del taller puede aprobar esta excepción cuando la membresía está pendiente, vencida o no cubre la sesión.'],
  [/violates check constraint/i,
    'No se pudo guardar: los datos no cumplen una regla del taller. Revise la selección e inténtelo de nuevo.'],
  [/duplicate key|unique constraint|already exists/i,
    'Ya existe un registro con esos datos. Revise el listado antes de crearlo otra vez.'],
  [/foreign key|violates foreign key/i,
    'No se puede completar la acción porque el registro todavía está vinculado a otras clases o fichas.'],
  [/permission denied|row-level security|42501/i,
    'No tiene permiso para esta acción en el taller.'],
  [/JWT|invalid claim|session expired/i,
    'La sesión ha caducado. Vuelva a iniciar sesión.']
];

const looksTechnical = (message: string) =>
  /[A-Z]{2,}_|::|select |insert |update |delete |sqlstate|postgres|pgrst|violat|constraint|exception|cannot |requires |unknown/i.test(message);

/**
 * Turn an RPC or database error into Spanish. Known phrases are explained.
 * Anything that still looks like English or SQL becomes a generic sentence.
 * Messages that are already Spanish pass through.
 */
export const mapUserFacingError = (error: unknown, fallback = 'No se pudo completar la acción. Inténtelo de nuevo.'): string => {
  const message = (error instanceof Error ? error.message : String((error as { message?: string })?.message || error || '')).trim();
  if (!message) return fallback;
  const noCredit = noCreditExceptionMessage(message);
  if (noCredit) return noCredit;
  for (const [pattern, spanish] of EXACT) {
    if (pattern.test(message)) return spanish;
  }
  const labeled = businessReasonLabel(message);
  if (labeled && labeled !== message) return labeled;
  if (looksTechnical(message)) return fallback;
  return message;
};
