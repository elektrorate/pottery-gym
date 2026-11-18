import type { GiftCardData } from '../types';
import { giftCardCopyDefaults, getSafeFileName, todayEs } from './giftCardDefaults.js';
import { generateVoucherCode } from './voucherCode.js';
import { validateGiftCard } from './validation.js';

export interface BotGiftCardInput {
  buyerName: string;
  recipientName: string;
  donorName?: string;
  numberOfClasses?: number;
  sessionDuration?: string;
  creationDate?: string;
  buyerPhone?: string;
  /** Optional recipient phone for the pottery-gym student record. Never printed on the PDF. */
  recipientPhone?: string;
  mainQuote?: string;
  subtitle?: string;
  subtitle2?: string;
  paymentStatus?: 'pending' | 'paid' | 'refunded';
  includePdf?: boolean;
}

export interface BuiltGiftCard {
  id: string;
  createdAt: string;
  fileName: string;
  voucherCode: string;
  status: 'created';
  paymentStatus: 'pending' | 'paid' | 'refunded';
  /** Internal only (pottery-gym sync). Never printed on the PDF. */
  recipientPhone?: string;
  data: GiftCardData;
}

const asTrimmedString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.trim() : fallback;

const asPositiveInt = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) ? n : fallback;
};

export const parseBotGiftCardInput = (body: unknown): BotGiftCardInput => {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    buyerName: asTrimmedString(raw.buyerName ?? raw.buyer),
    recipientName: asTrimmedString(raw.recipientName ?? raw.recipient),
    donorName: asTrimmedString(raw.donorName ?? raw.donor) || undefined,
    numberOfClasses: raw.numberOfClasses !== undefined || raw.numClasses !== undefined
      ? asPositiveInt(raw.numberOfClasses ?? raw.numClasses, 4)
      : undefined,
    sessionDuration: asTrimmedString(raw.sessionDuration) || undefined,
    creationDate: asTrimmedString(raw.creationDate) || undefined,
    buyerPhone: asTrimmedString(raw.buyerPhone ?? raw.phone ?? raw.internalContactPhone) || undefined,
    recipientPhone: asTrimmedString(raw.recipientPhone) || undefined,
    mainQuote: typeof raw.mainQuote === 'string' ? raw.mainQuote : undefined,
    subtitle: asTrimmedString(raw.subtitle) || undefined,
    subtitle2: asTrimmedString(raw.subtitle2) || undefined,
    paymentStatus:
      raw.paymentStatus === 'paid' || raw.paymentStatus === 'refunded' || raw.paymentStatus === 'pending'
        ? raw.paymentStatus
        : undefined,
    includePdf: raw.includePdf === true || raw.includePdf === 'true'
  };
};

export const buildGiftCardFromBotInput = (
  input: BotGiftCardInput,
  now = new Date()
): { card: BuiltGiftCard; errors: string[] } => {
  const creationDate = input.creationDate?.trim() || todayEs(now);
  const donorName = (input.donorName || input.buyerName || '').trim();
  const voucherCode = generateVoucherCode(donorName, input.recipientName, creationDate, now);

  const data: GiftCardData = {
    ...giftCardCopyDefaults,
    buyerName: input.buyerName.trim(),
    donorName,
    recipientName: input.recipientName.trim(),
    numberOfClasses: input.numberOfClasses ?? 4,
    sessionDuration: (input.sessionDuration || '2.5').replace(',', '.'),
    creationDate,
    voucherCode,
    logoUrl: null,
    internalContactPhone: input.buyerPhone || '',
    mainQuote: input.mainQuote?.trim() ? input.mainQuote : giftCardCopyDefaults.mainQuote,
    subtitle: input.subtitle || giftCardCopyDefaults.subtitle,
    subtitle2: input.subtitle2 || giftCardCopyDefaults.subtitle2
  };

  const errors = validateGiftCard(data);
  const id = `bot-${voucherCode.toLowerCase()}`;
  const card: BuiltGiftCard = {
    id,
    createdAt: now.toISOString(),
    fileName: getSafeFileName(donorName),
    voucherCode,
    status: 'created',
    paymentStatus: input.paymentStatus || 'pending',
    ...(input.recipientPhone ? { recipientPhone: input.recipientPhone } : {}),
    data
  };

  return { card, errors };
};

export const encodePrefillToken = (card: BuiltGiftCard): string => {
  const payload = {
    v: 1,
    voucherCode: card.voucherCode,
    data: {
      buyerName: card.data.buyerName,
      donorName: card.data.donorName,
      recipientName: card.data.recipientName,
      numberOfClasses: card.data.numberOfClasses,
      sessionDuration: card.data.sessionDuration,
      creationDate: card.data.creationDate,
      voucherCode: card.voucherCode,
      internalContactPhone: card.data.internalContactPhone,
      mainQuote: card.data.mainQuote,
      subtitle: card.data.subtitle,
      subtitle2: card.data.subtitle2
    }
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

export const decodePrefillToken = (token: string): Partial<GiftCardData> | null => {
  try {
    let json: string;
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(token, 'base64url').toString('utf8');
    } else {
      const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      json = atob(padded);
    }
    const parsed = JSON.parse(json) as { data?: Partial<GiftCardData> };
    if (!parsed?.data || typeof parsed.data !== 'object') return null;
    return parsed.data;
  } catch {
    return null;
  }
};
