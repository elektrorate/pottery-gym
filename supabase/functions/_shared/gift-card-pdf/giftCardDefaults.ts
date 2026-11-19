import type { GiftCardData } from './types.ts';

/** Default copy for Casa Rosier gift cards (no browser-only assets). */
/** Default validity on every new card (web, designer and bot API). */
export const DEFAULT_VALIDITY_TEXT = 'Validez de la tarjeta: 12 meses';
/** Old default; drafts that still carry it are moved to the new default. */
export const LEGACY_DEFAULT_VALIDITY_TEXT = 'Validez de la tarjeta: 6 meses';
export const VALIDITY_OPTIONS = [DEFAULT_VALIDITY_TEXT, LEGACY_DEFAULT_VALIDITY_TEXT] as const;

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
  title: 'TARJETA DE REGALO',
  subtitle: 'Clases de Cerámica',
  subtitle2: '',
  introText: '¡Felicidades!',
  mainQuote:
    '"En tus manos sostienes uno de los regalos más especiales que podrías recibir:\nUna invitación a un día lleno de inspiración y creatividad."',
  fromLabel: 'Este regalo tan significativo llega a ti gracias a:',
  experienceTitle: 'Instrucciones de Uso',
  experienceIntro: 'Contacta con nosotros para reservar tus clases',
  experienceLocation: 'Presenta esta tarjeta al inicio de tu primera clase',
  experienceBullet4: '',
  includesLabel: 'Esta tarjeta incluye:',
  includesDetails: 'Disfruta de la experiencia creativa',
  validityText: DEFAULT_VALIDITY_TEXT,
  contactTitle: 'Información de contacto',
  contactSubtitle: 'Cómo usar tu tarjeta',
  phone: '+34 633 788 860',
  email: 'info@casarosierceramica.com',
  website: 'www.casarosierceramica.com'
};

/** Pack label on the card: «1 clase», «4 clases». */
export const classesCountLabel = (count: number): string =>
  `${count} ${count === 1 ? 'clase' : 'clases'}`;

export const todayEs = (now = new Date()): string =>
  now.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });

export const getSafeFileName = (donorName: string): string => {
  const safe = donorName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'Regalo';
  return `Bono-Casa-Rosier-${safe}.pdf`;
};
