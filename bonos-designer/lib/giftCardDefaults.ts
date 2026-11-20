import type { GiftCardData } from '../types';
import { formatDate } from '../../utils/dateFormat';

/** Default copy for Casa Rosier gift cards (no browser-only assets). */
/** Default validity on every new card (web, designer and bot API). */
export const DEFAULT_VALIDITY_TEXT = 'Validez del bono regalo: 12 meses';
/** Old default; drafts that still carry it are moved to the new default. */
export const LEGACY_DEFAULT_VALIDITY_TEXT = 'Validez de la tarjeta: 6 meses';
/** Previous 12-month sentence, kept so saved drafts move to the current wording. */
export const PREVIOUS_DEFAULT_VALIDITY_TEXT = 'Validez de la tarjeta: 12 meses';
export const SIX_MONTH_VALIDITY_TEXT = 'Validez del bono regalo: 6 meses';
export const VALIDITY_OPTIONS = [DEFAULT_VALIDITY_TEXT, SIX_MONTH_VALIDITY_TEXT] as const;

export const giftCardCopyDefaults: Omit<
  GiftCardData,
  | 'buyerName'
  | 'donorName'
  | 'recipientName'
  | 'numberOfClasses'
  | 'sessionDuration'
  | 'creationDate'
  | 'voucherCode'
  | 'logoUrl'
  | 'internalContactPhone'
> = {
  title: 'BONO REGALO',
  subtitle: 'Clases de Cerámica',
  subtitle2: '',
  introText: '¡Felicidades!',
  mainQuote:
    '"En tus manos sostienes uno de los regalos más especiales que podrías recibir:\nUna invitación a un día lleno de inspiración y creatividad."',
  fromLabel: 'Este regalo tan significativo llega a ti gracias a:',
  experienceTitle: 'Instrucciones de Uso',
  experienceIntro: 'Contacta con nosotros para reservar tus clases',
  experienceLocation: 'Presenta este bono regalo al inicio de tu primera clase',
  experienceBullet4: '',
  includesLabel: 'Este bono regalo incluye:',
  includesDetails: 'Disfruta de la experiencia creativa',
  validityText: DEFAULT_VALIDITY_TEXT,
  contactTitle: 'Información de contacto',
  contactSubtitle: 'Cómo usar tu bono regalo',
  phone: '+34 633 788 860',
  email: 'info@casarosierceramica.com',
  website: 'www.casarosierceramica.com'
};

const LEGACY_VISIBLE_COPY: Record<string, Record<string, string>> = {
  title: { 'TARJETA DE REGALO': 'BONO REGALO' },
  experienceLocation: {
    'Presenta esta tarjeta al inicio de tu primera clase': 'Presenta este bono regalo al inicio de tu primera clase'
  },
  includesLabel: { 'Esta tarjeta incluye:': 'Este bono regalo incluye:' },
  contactSubtitle: {
    'Cómo usar tu tarjeta': 'Cómo usar tu bono regalo',
    'Como usar tu tarjeta': 'Cómo usar tu bono regalo'
  }
};

/** Shows the current gift-card wording when a draft or PDF still carries the old default phrases. */
export const presentGiftCardCopy = <T extends Partial<GiftCardData>>(data: T): T => {
  const next = { ...data };
  for (const [field, phrases] of Object.entries(LEGACY_VISIBLE_COPY)) {
    const value = next[field as keyof T];
    if (typeof value === 'string' && phrases[value]) (next as Record<string, unknown>)[field] = phrases[value];
  }
  if (typeof next.validityText === 'string') {
    next.validityText = next.validityText.replace(/^Validez de la tarjeta:/, 'Validez del bono regalo:') as T['validityText'];
  }
  return next;
};

/** Pack label on the card: «1 clase», «4 clases». */
export const classesCountLabel = (count: number): string =>
  `${count} ${count === 1 ? 'clase' : 'clases'}`;

export const todayEs = (now = new Date()): string => formatDate(now);

export const getSafeFileName = (donorName: string): string => {
  const safe = donorName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'Regalo';
  return `Bono-Casa-Rosier-${safe}.pdf`;
};
