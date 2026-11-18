import type { GiftCardData } from '../types';
import { DEFAULT_VALIDITY_TEXT, giftCardCopyDefaults } from './giftCardDefaults.js';

/**
 * Payload for pottery-gym `bonos-write` (action "create").
 * The same voucher code is used as `code` and `externalReference`, so the bono
 * has one identity in both apps. Without `recipientStudentId`, pottery-gym
 * creates a NEW temporal student for the recipient (never matched by name).
 * `buyerPhone` is the internal contact phone: stored in pottery-gym, never on the PDF.
 */
export const BONOS_VALIDITY_MONTHS = [3, 6, 8, 12] as const;
export const DEFAULT_VALIDITY_MONTHS = 12;

/** «Validez de la tarjeta: 12 meses» -> 12. Unknown text -> Casa Rosier default (12). */
export const parseValidityMonths = (validityText?: string | null): number => {
  const match = (validityText || DEFAULT_VALIDITY_TEXT).match(/(\d{1,2})\s*mes/i);
  const months = match ? Number.parseInt(match[1], 10) : DEFAULT_VALIDITY_MONTHS;
  return Number.isInteger(months) && months > 0 ? months : DEFAULT_VALIDITY_MONTHS;
};

/** «18/11/2026» (es-ES) or ISO -> «2026-11-18»; anything else -> undefined (server uses today). */
export const toIsoDate = (value?: string | null): string | undefined => {
  const text = (value || '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const es = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : es ? [es[3], es[2], es[1]] : [];
  if (!y) return undefined;
  const result = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result ? undefined : result;
};

/** Class duration in hours as a number («2,5» -> 2.5), or undefined. */
export const parseSessionHours = (value?: string | null): number | undefined => {
  const n = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The custom text on the card is the dedication; the stock quote is not. */
export const dedicationFrom = (mainQuote?: string | null): string | undefined => {
  const text = (mainQuote || '').trim();
  if (!text || text === giftCardCopyDefaults.mainQuote.trim()) return undefined;
  return text;
};

export interface BonosCreateOptions {
  voucherCode: string;
  fileName?: string;
  paymentStatus?: 'pending' | 'paid' | 'refunded';
  recipientPhone?: string;
  source: 'gift-card-bot-api' | 'gift-card-designer';
}

export const buildBonosCreatePayload = (data: GiftCardData, options: BonosCreateOptions): Record<string, unknown> => {
  const code = options.voucherCode.trim().toUpperCase();
  const hours = parseSessionHours(data.sessionDuration);
  const payload: Record<string, unknown> = {
    buyer: data.buyerName?.trim() || data.donorName?.trim() || 'Casa Rosier',
    recipient: data.recipientName?.trim() || 'Sin destinatario',
    numClasses: data.numberOfClasses,
    type: 'modelado',
    // pottery-gym only accepts pending/paid on create.
    paymentStatus: options.paymentStatus === 'paid' ? 'paid' : 'pending',
    validityMonths: parseValidityMonths(data.validityText),
    code,
    externalReference: code,
    metadata: {
      source: options.source,
      voucherCode: code,
      ...(options.fileName ? { fileName: options.fileName } : {}),
      ...(data.donorName ? { donorName: data.donorName } : {}),
      ...(data.creationDate ? { creationDate: data.creationDate } : {}),
      ...(hours !== undefined ? { classDurationHours: hours } : {}),
      ...(data.subtitle ? { subtitle: data.subtitle } : {}),
      ...(data.subtitle2 ? { subtitle2: data.subtitle2 } : {}),
      ...(options.paymentStatus === 'refunded' ? { originalPaymentStatus: 'refunded' } : {})
    }
  };
  if (hours !== undefined) payload.extraCommentary = `Duración de la clase: ${String(hours).replace('.', ',')} h`;
  const activatedAt = toIsoDate(data.creationDate);
  if (activatedAt) payload.activatedAt = activatedAt;
  const buyerPhone = data.internalContactPhone?.trim();
  if (buyerPhone) payload.buyerPhone = buyerPhone;
  const recipientPhone = options.recipientPhone?.trim();
  if (recipientPhone) payload.recipientPhone = recipientPhone;
  const dedication = dedicationFrom(data.mainQuote);
  if (dedication) payload.dedication = dedication;
  return payload;
};
