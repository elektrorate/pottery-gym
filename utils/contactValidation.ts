/** Empty is allowed here; required fields are enforced by the form. */
export const emailError = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) return 'Introduce un email válido.';
  return null;
};

/** Digits, an optional leading +, and spaces. At least 6 digits. */
export const phoneError = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\+?[\d\s]+$/.test(trimmed)) return 'El teléfono solo puede tener dígitos, + y espacios.';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6) return 'El teléfono es demasiado corto.';
  return null;
};

const negativeWord = (_label: string, gender?: 'f' | 'm') => (gender === 'f' ? 'negativa' : 'negativo');

/** Money and quantities that must be strictly positive. Negatives are not rewritten. */
export const positiveAmountError = (value: number, label: string, gender?: 'f' | 'm'): string | null => {
  if (!Number.isFinite(value)) return `${label} debe ser un número mayor que 0.`;
  if (value < 0) return `${label} no puede ser ${negativeWord(label, gender)}.`;
  if (value <= 0) return `${label} debe ser mayor que 0.`;
  return null;
};

/** Stock counts may be zero. Negatives are rejected and not rewritten as positives. */
export const nonNegativeAmountError = (value: number, label: string, gender?: 'f' | 'm'): string | null => {
  if (!Number.isFinite(value)) return `${label} debe ser un número igual o mayor que 0.`;
  if (value < 0) return `${label} no puede ser ${negativeWord(label, gender)}.`;
  return null;
};
