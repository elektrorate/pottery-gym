import type { GiftCardData } from '../types';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const countWords = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;

export const validateGiftCard = (data: GiftCardData): string[] => {
  const errors: string[] = [];

  if (!data.buyerName.trim()) {
    errors.push('Indica el nombre del comprador.');
  }

  if (!data.recipientName.trim()) {
    errors.push('Indica el nombre del destinatario.');
  }

  if (!data.donorName.trim()) {
    errors.push('Indica quién entrega el regalo.');
  }

  if (!Number.isInteger(data.numberOfClasses) || data.numberOfClasses < 1 || data.numberOfClasses > 100) {
    errors.push('El número de clases debe estar entre 1 y 100.');
  }

  const duration = Number.parseFloat(data.sessionDuration.replace(',', '.'));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24) {
    errors.push('La duración debe ser un número de horas mayor que 0 y menor o igual a 24.');
  }

  if (!data.creationDate.trim()) {
    errors.push('Indica la fecha de emisión.');
  }

  if (countWords(data.mainQuote) > 160) {
    errors.push('La dedicatoria no puede superar las 160 palabras.');
  }

  if (data.email.trim() && !emailPattern.test(data.email.trim())) {
    errors.push('El email de contacto no tiene un formato válido.');
  }

  const textLimits: Array<[keyof GiftCardData, string, number]> = [
    ['buyerName', 'El nombre del comprador', 80],
    ['recipientName', 'El nombre del destinatario', 80],
    ['donorName', 'El nombre del remitente', 80],
    ['mainQuote', 'El mensaje central', 500],
    ['experienceIntro', 'La instrucción de reserva', 180],
    ['experienceLocation', 'La instrucción de presentación', 180],
    ['includesDetails', 'El detalle de la experiencia', 180],
    ['experienceBullet4', 'La cuarta instrucción', 180],
    ['website', 'El sitio web', 120],
  ];

  for (const [field, label, maxLength] of textLimits) {
    const value = data[field];
    if (typeof value === 'string' && value.length > maxLength) {
      errors.push(`${label} no puede superar los ${maxLength} caracteres.`);
    }
  }

  return errors;
};
