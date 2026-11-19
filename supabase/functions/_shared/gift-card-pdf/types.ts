
export interface GiftCardData {
  buyerName: string;
  donorName: string;
  recipientName: string;
  numberOfClasses: number;
  /** pottery-gym gift_cards.type: modelado or torno. Omitted on older records. */
  classType?: 'modelado' | 'torno';
  sessionDuration: string;
  creationDate: string;
  /** Unique code stamped on the PDF and stored with the record. */
  voucherCode: string;
  logoUrl: string | null;
  // Cara 1
  title: string;
  subtitle: string;
  subtitle2: string;
  introText: string;
  mainQuote: string;
  fromLabel: string;
  // Cara 2
  experienceTitle: string;
  experienceIntro: string;
  experienceLocation: string;
  experienceBullet4: string;
  includesLabel: string;
  includesDetails: string;
  validityText: string;
  contactTitle: string;
  contactSubtitle: string;
  phone: string;
  email: string;
  website: string;
  internalContactPhone: string;
}
