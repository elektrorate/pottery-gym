import type { GiftCardData } from '../types';
import {
  buildBonosCreatePayload,
  dedicationFrom,
  parseSessionHours,
  parseValidityMonths,
  toIsoDate
} from './bonosSync';
import { DEFAULT_VALIDITY_TEXT } from './giftCardDefaults';
import type { LocalGiftCardRecord, LocalGiftCardStatus } from './localHistory';

/**
 * Persistence of the Casa Rosier designer inside pottery-gym.
 * Every bono is a row of public.gift_cards (same code as on the PDF). The full
 * card design lives in gift_cards.external_metadata.cardData so the history can
 * reload it in the editor exactly as it was printed.
 */

export const DESIGNER_SOURCE = 'pottery-designer';

export type PotteryPaymentStatus = 'pending' | 'paid';
export type PotteryClassType = 'modelado' | 'torno';

export type RecipientChoice =
  | { mode: 'temporal' }
  | { mode: 'student'; studentId: string };

export interface PotteryRecord extends LocalGiftCardRecord {
  origin: 'server' | 'local';
  source?: string;
  /** pottery-gym lifecycle (pending, active, consumed, ...). */
  potteryStatus?: string;
  paymentStatus?: string;
  metadata?: Record<string, unknown>;
}

export interface PotteryStudentOption {
  id: string;
  name: string;
  category: string | null;
}

type Client = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
};

export const GIFT_CARD_COLUMNS =
  'id,sede_id,code,buyer,recipient,recipient_student_id,buyer_phone,num_classes,type,status,payment_status,dedication,validity_months,activated_at,expiry_date,extra_commentary,external_reference,external_metadata,created_at';

/** Card design without the bundled logo URL (it is a build asset, not data). */
export const storableCardData = (data: GiftCardData): Omit<GiftCardData, 'logoUrl'> => {
  const { logoUrl: _logo, ...rest } = data;
  return rest;
};

export interface PotteryCardOptions {
  voucherCode: string;
  fileName: string;
  paymentStatus?: PotteryPaymentStatus;
  type?: PotteryClassType;
}

/**
 * Row for public.gift_cards (snake_case). Same mapping as bono-gift-card ->
 * bonos-write, plus the full design in external_metadata.cardData.
 */
export const buildPotteryCardRow = (data: GiftCardData, options: PotteryCardOptions): Record<string, unknown> => {
  const payload = buildBonosCreatePayload(data, {
    voucherCode: options.voucherCode,
    fileName: options.fileName,
    paymentStatus: options.paymentStatus === 'paid' ? 'paid' : 'pending',
    source: 'gift-card-designer'
  });
  const metadata = {
    ...(payload.metadata as Record<string, unknown>),
    source: DESIGNER_SOURCE,
    designerStatus: 'created',
    cardData: storableCardData({ ...data, voucherCode: String(payload.code) })
  };
  const row: Record<string, unknown> = {
    code: payload.code,
    external_reference: payload.externalReference,
    buyer: payload.buyer,
    recipient: payload.recipient,
    num_classes: payload.numClasses,
    type: options.type === 'torno' ? 'torno' : 'modelado',
    payment_status: payload.paymentStatus,
    validity_months: payload.validityMonths,
    delivery_format: 'digital',
    external_metadata: metadata
  };
  if (payload.activatedAt) row.activated_at = payload.activatedAt;
  if (payload.buyerPhone) row.buyer_phone = payload.buyerPhone;
  if (payload.dedication) row.dedication = payload.dedication;
  if (payload.extraCommentary) {
    row.extra_commentary = payload.extraCommentary;
    row.internal_notes = payload.extraCommentary;
  }
  return row;
};

/** pottery-gym lifecycle -> designer history status. */
export const designerStatusFrom = (potteryStatus?: string | null, metadata?: Record<string, unknown> | null): LocalGiftCardStatus => {
  if (potteryStatus === 'cancelled') return 'cancelled';
  if (potteryStatus === 'consumed' || potteryStatus === 'exhausted') return 'redeemed';
  return metadata?.designerStatus === 'sent' ? 'sent' : 'created';
};

const isoToEs = (iso?: string | null): string => {
  const match = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};

const hoursFromCommentary = (text?: string | null): string | undefined => {
  const match = (text || '').match(/(\d+(?:[.,]\d+)?)\s*h/i);
  return match ? match[1].replace(',', '.') : undefined;
};

export interface GiftCardRow {
  id: string;
  code: string | null;
  buyer: string | null;
  recipient: string | null;
  recipient_student_id?: string | null;
  buyer_phone: string | null;
  num_classes: number | null;
  type?: string | null;
  status: string | null;
  payment_status: string | null;
  dedication: string | null;
  validity_months: number | null;
  activated_at: string | null;
  extra_commentary: string | null;
  external_metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Any gift_cards row (designer, bono-gift-card API or pottery form) -> history record. */
export const mapGiftCardRow = (row: GiftCardRow, defaults: GiftCardData): PotteryRecord => {
  const metadata = (row.external_metadata && typeof row.external_metadata === 'object') ? row.external_metadata : {};
  const stored = (metadata.cardData && typeof metadata.cardData === 'object') ? metadata.cardData as Partial<GiftCardData> : null;
  const voucherCode = row.code || String(metadata.voucherCode || '') || null;
  const hours = metadata.classDurationHours !== undefined ? String(metadata.classDurationHours) : hoursFromCommentary(row.extra_commentary);
  const derived: GiftCardData = {
    ...defaults,
    buyerName: row.buyer || '',
    donorName: String(metadata.donorName || row.buyer || ''),
    recipientName: row.recipient || '',
    numberOfClasses: row.num_classes || defaults.numberOfClasses,
    sessionDuration: hours || defaults.sessionDuration,
    creationDate: String(metadata.creationDate || isoToEs(row.activated_at) || ''),
    subtitle: String(metadata.subtitle || defaults.subtitle),
    subtitle2: String(metadata.subtitle2 || ''),
    mainQuote: row.dedication || defaults.mainQuote,
    validityText: row.validity_months ? `Validez de la tarjeta: ${row.validity_months} meses` : DEFAULT_VALIDITY_TEXT,
    internalContactPhone: row.buyer_phone || '',
    voucherCode: voucherCode || ''
  };
  return {
    id: row.id,
    origin: 'server',
    source: String(metadata.source || 'pottery-gym'),
    createdAt: row.created_at,
    fileName: String(metadata.fileName || `Bono-Casa-Rosier-${(row.buyer || '').trim().replace(/\s+/g, '-') || 'bono'}.pdf`),
    voucherCode,
    formToken: null,
    formCompletedAt: null,
    status: designerStatusFrom(row.status, metadata),
    potteryStatus: row.status || undefined,
    paymentStatus: row.payment_status || undefined,
    metadata,
    data: stored
      ? { ...derived, ...stored, logoUrl: defaults.logoUrl, voucherCode: voucherCode || stored.voucherCode || '' }
      : derived
  };
};

const errorMessage = (error: any, fallback: string) => (error?.message ? String(error.message) : fallback);

/** Saves a designer bono in pottery-gym (same code). Duplicate codes reject with code 23505. */
export const createPotteryGiftCard = async (
  client: Client,
  sedeId: string,
  data: GiftCardData,
  options: PotteryCardOptions,
  recipient: RecipientChoice
): Promise<PotteryRecord> => {
  if (!sedeId) throw new Error('No hay una sede seleccionada.');
  const row = buildPotteryCardRow(data, options);
  if (recipient.mode === 'student') {
    const { data: saved, error } = await client
      .from('gift_cards')
      .insert({ ...row, sede_id: sedeId, recipient_student_id: recipient.studentId })
      .select(GIFT_CARD_COLUMNS)
      .single();
    if (error) throw Object.assign(new Error(errorMessage(error, 'No se pudo guardar el bono.')), { code: error.code });
    return mapGiftCardRow(saved as GiftCardRow, { ...data });
  }
  const { data: saved, error } = await client.rpc('designer_create_gift_card_with_temporal_student', {
    p_sede_id: sedeId,
    p_card: row,
    p_student: {
      full_name: row.recipient,
      notes: `Alumno temporal creado desde el diseñador de bonos (bono ${row.code}).`
    }
  });
  if (error) throw Object.assign(new Error(errorMessage(error, 'No se pudo guardar el bono.')), { code: error.code });
  const card = Array.isArray(saved) ? saved[0] : saved;
  return mapGiftCardRow(card as GiftCardRow, { ...data });
};

export const fetchPotteryHistory = async (
  client: Client,
  sedeId: string,
  defaults: GiftCardData
): Promise<PotteryRecord[]> => {
  const { data, error } = await client
    .from('gift_cards')
    .select(GIFT_CARD_COLUMNS)
    .eq('sede_id', sedeId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(errorMessage(error, 'No se pudo leer el historial de pottery-gym.'));
  return ((data || []) as GiftCardRow[]).map((row) => mapGiftCardRow(row, defaults));
};

/** «Creado» / «Enviado» are designer labels kept in external_metadata. */
export const updateDesignerStatus = async (
  client: Client,
  record: PotteryRecord,
  status: 'created' | 'sent'
): Promise<void> => {
  const { error } = await client
    .from('gift_cards')
    .update({ external_metadata: { ...(record.metadata || {}), designerStatus: status } })
    .eq('id', record.id);
  if (error) throw new Error(errorMessage(error, 'No se pudo actualizar el estado.'));
};

/** Bonos are never deleted in pottery-gym: they are cancelled (anulados). */
export const cancelPotteryGiftCard = async (client: Client, id: string): Promise<void> => {
  const { error } = await client.rpc('cancel_gift_card', { p_gift_card_id: id });
  if (error) throw new Error(errorMessage(error, 'No se pudo anular el bono.'));
};

export const fetchSedeStudents = async (client: Client, sedeId: string): Promise<PotteryStudentOption[]> => {
  const { data, error } = await client
    .from('students')
    .select('id,full_name,name,student_category,archived_at')
    .eq('sede_id', sedeId)
    .is('archived_at', null)
    .order('full_name', { ascending: true })
    .limit(2000);
  if (error) throw new Error(errorMessage(error, 'No se pudieron cargar los alumnos.'));
  return ((data || []) as Array<{ id: string; full_name: string | null; name: string | null; student_category: string | null }>)
    .map((row) => ({ id: row.id, name: row.full_name || row.name || 'Sin nombre', category: row.student_category }));
};

/** Merge server and local records: server wins for the same code. Newest first. */
export const mergeHistory = <T extends { id: string; voucherCode: string | null; createdAt: string }>(
  server: T[],
  local: T[]
): T[] => {
  const seenCodes = new Set<string>();
  const seenIds = new Set<string>();
  const out: T[] = [];
  for (const list of [server, local]) {
    for (const item of list) {
      if (seenIds.has(item.id)) continue;
      if (item.voucherCode && seenCodes.has(item.voucherCode)) continue;
      seenIds.add(item.id);
      if (item.voucherCode) seenCodes.add(item.voucherCode);
      out.push(item);
    }
  }
  return out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
};

export { parseValidityMonths, parseSessionHours, toIsoDate, dedicationFrom };
