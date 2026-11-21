/**
 * Spanish labels for internal billing / penalty / funding reason codes.
 * UI must never show raw English server strings or snake_case codes.
 */

const BILLING_KIND_LABELS: Record<string, string> = {
  attendance: 'Asistencia',
  no_show: 'Falta sin aviso',
  late_cancellation: 'Cancelación tardía',
  late_cancel: 'Cancelación tardía',
  timely_cancellation: 'Cancelación a tiempo',
  courtesy: 'Asistencia sin descuento'
};

const BILLING_STATE_LABELS: Record<string, string> = {
  unfinalized: 'Consumo sin finalizar',
  charged: 'Una clase consumida',
  no_charge: 'Sin consumo',
  incident: 'Incidencia pendiente de resolución administrativa',
  waived: 'Penalización eximida'
};

/** Exact server reason strings → Spanish (never fall through to English). */
const FUNDING_REASON_LABELS: Record<string, string> = {
  'One class: no_show': 'Una clase consumida · Falta sin aviso',
  'One class: late_cancellation': 'Una clase consumida · Cancelación tardía',
  'Original scalar pack is not usable': 'El bono de clases no se puede usar en esta sesión',
  'Original scalar pack has no known positive balance': 'El bono de clases no tiene saldo positivo conocido',
  'Original scalar pack student is archived': 'El alumno del bono de clases está archivado',
  'Original scalar pack is expired for the session': 'El bono de clases está vencido para esta sesión',
  'Original scalar pack payment is unpaid or unknown': 'El pago del bono de clases está pendiente o es desconocido',
  'Unsupported temporal/manual funding: legacy balance requires attributable funding or reconciliation':
    'Hay clases anteriores sin un bono o una membresía. Regístrelas antes de descontar.',
  'Explicit gift card has no valid available credit': 'El bono regalo no tiene crédito disponible válido',
  'Original membership source is unknown': 'La membresía original es desconocida',
  'Original membership balance is no longer current': 'El saldo de membresía ya no es el actual',
  'Queued successor is not an authorized funding source': 'El período sucesor en cola no autoriza el consumo',
  'Original membership has no known positive balance': 'La membresía no tiene saldo positivo conocido',
  'Original membership is unpaid, expired, archived or does not cover the session':
    'La membresía no está pagada, está vencida, archivada o no cubre la sesión'
};

const ONE_CLASS_PREFIX = /^One class:\s*(.+)$/i;
const UNSUPPORTED_TEMPORAL_PREFIX = /^Unsupported temporal\/manual funding:\s*(.+)$/i;
const ORIGINAL_SCALAR_PREFIX = /^Original scalar pack\s+(.+)$/i;
const ORIGINAL_MEMBERSHIP_PREFIX = /^Original membership\s+(.+)$/i;

const humanizeToken = (token: string) => {
  const key = token.trim().toLowerCase().replace(/\s+/g, '_');
  if (BILLING_KIND_LABELS[key]) return BILLING_KIND_LABELS[key];
  if (key === 'not_usable' || key === 'is_not_usable' || key === 'not usable') {
    return 'no utilizable';
  }
  return token
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
};

/**
 * Translate a stored penalty / funding reason for UI display.
 * Never returns raw English server phrases when a mapping exists;
 * unknown strings are lightly localized (codes → words) rather than shown as-is when they match known patterns.
 */
export const businessReasonLabel = (reason: string | null | undefined): string => {
  if (reason == null) return '';
  const trimmed = String(reason).trim();
  if (!trimmed) return '';

  const exact = FUNDING_REASON_LABELS[trimmed];
  if (exact) return exact;

  const oneClass = trimmed.match(ONE_CLASS_PREFIX);
  if (oneClass) {
    return `Una clase consumida · ${humanizeToken(oneClass[1])}`;
  }

  const unsupported = trimmed.match(UNSUPPORTED_TEMPORAL_PREFIX);
  if (unsupported) {
    const detail = unsupported[1].toLowerCase();
    if (detail.includes('legacy balance') || detail.includes('attributable')) {
      return 'Hay clases anteriores sin un bono o una membresía. Regístrelas antes de descontar.';
    }
    return `Financiación temporal/manual no admitida: ${humanizeToken(unsupported[1])}`;
  }

  const scalar = trimmed.match(ORIGINAL_SCALAR_PREFIX);
  if (scalar) {
    const rest = scalar[1].toLowerCase();
    // Cosmetic: server else-branch used to say "is not usable" even when usable=true.
    // Prefer a neutral Spanish phrase; never show the English "not usable" code.
    if (rest === 'is not usable' || rest.includes('not usable')) {
      return 'Estado del bono de clases: revisar condiciones de uso';
    }
    if (rest.includes('no known positive')) return FUNDING_REASON_LABELS['Original scalar pack has no known positive balance'];
    if (rest.includes('archived')) return FUNDING_REASON_LABELS['Original scalar pack student is archived'];
    if (rest.includes('expired')) return FUNDING_REASON_LABELS['Original scalar pack is expired for the session'];
    if (rest.includes('unpaid') || rest.includes('unknown')) {
      return FUNDING_REASON_LABELS['Original scalar pack payment is unpaid or unknown'];
    }
    return `Bono de clases: ${humanizeToken(scalar[1])}`;
  }

  const membership = trimmed.match(ORIGINAL_MEMBERSHIP_PREFIX);
  if (membership) {
    return `Membresía: ${humanizeToken(membership[1])}`;
  }

  // Bare codes that might appear alone
  if (BILLING_KIND_LABELS[trimmed]) return BILLING_KIND_LABELS[trimmed];
  if (BILLING_STATE_LABELS[trimmed]) return BILLING_STATE_LABELS[trimmed];

  // Soften remaining snake_case tokens without inventing meaning
  if (/^[a-z][a-z0-9_]*$/.test(trimmed)) return humanizeToken(trimmed);

  return trimmed;
};

export const billingKindLabel = (kind: string | null | undefined): string => {
  if (!kind) return '';
  return BILLING_KIND_LABELS[kind] || businessReasonLabel(kind);
};

export const billingStateLabel = (state: string | null | undefined): string => {
  if (!state) return '';
  return BILLING_STATE_LABELS[state] || businessReasonLabel(state);
};

export const penaltyKindLabel = (kind: string | null | undefined): string => {
  if (kind === 'no_show') return 'Falta sin aviso';
  if (kind === 'late_cancellation' || kind === 'late_cancel') return 'Cancelación tardía';
  return billingKindLabel(kind) || 'Incidencia';
};
