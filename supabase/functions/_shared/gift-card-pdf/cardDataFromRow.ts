import type { GiftCardData } from './types.ts';
import { DEFAULT_VALIDITY_TEXT, giftCardCopyDefaults } from './giftCardDefaults.ts';

/** Subset of public.gift_cards used to rebuild the design for the official PDF. */
export type GiftCardPdfRow = {
  code?: string | null;
  buyer?: string | null;
  recipient?: string | null;
  buyer_phone?: string | null;
  num_classes?: number | null;
  type?: string | null;
  dedication?: string | null;
  validity_months?: number | null;
  activated_at?: string | null;
  extra_commentary?: string | null;
  external_metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

const isoToEs = (iso?: string | null): string => {
  const match = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};

const hoursFromCommentary = (text?: string | null): string | undefined => {
  const match = (text || '').match(/(\d+(?:[.,]\d+)?)\s*h/i);
  return match ? match[1].replace(',', '.') : undefined;
};

/**
 * Rebuilds GiftCardData from a gift_cards row. If the designer stored
 * `external_metadata.cardData`, that wins (same preview that was printed).
 * Otherwise the official copy defaults fill any gap so Stripe/W1/form bonos
 * still get the Casa Rosier card, including singular «1 clase».
 */
export const cardDataFromGiftCardRow = (row: GiftCardPdfRow, nowEs?: string): GiftCardData => {
  const metadata = (row.external_metadata && typeof row.external_metadata === 'object')
    ? row.external_metadata
    : {};
  const stored = (metadata.cardData && typeof metadata.cardData === 'object')
    ? metadata.cardData as Partial<GiftCardData>
    : null;
  const voucherCode = row.code || String(metadata.voucherCode || '') || '';
  const hours = metadata.classDurationHours !== undefined
    ? String(metadata.classDurationHours)
    : hoursFromCommentary(row.extra_commentary);
  const derived: GiftCardData = {
    ...giftCardCopyDefaults,
    buyerName: row.buyer || '',
    donorName: String(metadata.donorName || row.buyer || ''),
    recipientName: row.recipient || '',
    numberOfClasses: row.num_classes || 1,
    classType: row.type === 'torno' || row.type === 'modelado' ? row.type : undefined,
    sessionDuration: hours || '2.5',
    creationDate: String(metadata.creationDate || isoToEs(row.activated_at) || isoToEs(row.created_at) || nowEs || ''),
    subtitle: String(metadata.subtitle || giftCardCopyDefaults.subtitle),
    subtitle2: String(metadata.subtitle2 || ''),
    mainQuote: row.dedication || giftCardCopyDefaults.mainQuote,
    validityText: row.validity_months ? `Validez de la tarjeta: ${row.validity_months} meses` : DEFAULT_VALIDITY_TEXT,
    internalContactPhone: row.buyer_phone || '',
    voucherCode,
    logoUrl: null
  };
  if (!stored) return derived;
  return {
    ...derived,
    ...stored,
    logoUrl: null,
    voucherCode: voucherCode || stored.voucherCode || ''
  };
};

export const pdfFileNameFromRow = (row: GiftCardPdfRow): string => {
  const metadata = (row.external_metadata && typeof row.external_metadata === 'object')
    ? row.external_metadata
    : {};
  if (typeof metadata.fileName === 'string' && metadata.fileName.trim()) return metadata.fileName.trim();
  const safe = (row.recipient || row.buyer || 'Regalo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'Regalo';
  return `Bono-Casa-Rosier-${safe}.pdf`;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};
