export const LIMITS = {
  name: 100,
  note: 500,
  cuota: 10_000,
  manualCredit: 100,
  inventoryCode: 40
} as const;

export const lengthError = (value: string, max: number, label: string) =>
  value.trim().length > max ? `${label} admite como máximo ${max} caracteres.` : null;

export const cuotaCeilingError = (value: number) =>
  Number.isFinite(value) && value > LIMITS.cuota ? `La cuota no puede superar ${LIMITS.cuota.toLocaleString('es-ES')} €.` : null;

export const manualCreditCeilingError = (value: number) =>
  Number.isFinite(value) && value > LIMITS.manualCredit ? `Puede añadir como máximo ${LIMITS.manualCredit} clases.` : null;
