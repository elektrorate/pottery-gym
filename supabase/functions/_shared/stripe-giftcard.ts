/**
 * Webhook de Stripe → bono en pottery-gym (gift cards de la web).
 * Preparación: no desplegar ni apuntar Stripe aquí sin el OK de Erick.
 *
 * Stripe firma el cuerpo crudo (HMAC-SHA256, tolerancia 5 min). La función
 * crea el bono con el mismo código determinista que usaba bono-gift-card, de modo
 * que un evento repetido (o el webhook antiguo) recibe 409 y no duplica.
 * La cola de asistonto vive en gift_cards.external_metadata
 * (source=stripe-webhook, sin acknowledgedAt).
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { identify, json as actorJson, fingerprints, type Env, type Actor } from './asistonto-api.ts';
import { giftCardSelect, publicGiftCard } from './gift-card-api.ts';

export const STRIPE_WEBHOOK_SOURCE = 'stripe-webhook';
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded'
] as const;
export const STRIPE_GIFT_CARD_SESSION_HOURS = 2;
export const DEFAULT_VALIDITY_MONTHS = 12;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const NOTIFY_SIGNATURE_HEADER = 'X-Casa-Rosier-Signature';
export const NOTIFY_EVENT_TYPE = 'gift_card.paid';
const NOTIFY_TIMEOUT_MS = 5000;
const SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payment Links live (cuenta acct_1OlRUVG3M5SYIufu), leídos el 18/11/2026. */
export const DEFAULT_GIFT_CARD_PAYMENT_LINKS: readonly string[] = [
  'plink_1UVWMyG3M5SYIufuTEnM6xBx', // virtual 1 clase 50 €
  'plink_1UVWN2G3M5SYIufukKlvIxEH', // virtual 2 clases 75 €
  'plink_1UVWN6G3M5SYIufu7YJkS2E8', // virtual 3 clases 90 €
  'plink_1UVWN9G3M5SYIufujerhlCeS', // virtual 4 clases 120 €
  'plink_1UVWNCG3M5SYIufudq0TMaBQ', // física 1 clase 60 €
  'plink_1UVWNGG3M5SYIufufTP6by3R', // física 2 clases 80 €
  'plink_1UVWNKG3M5SYIufubGfcHk0n', // física 3 clases 95 €
  'plink_1UVWNNG3M5SYIufu7vMp3BVk' // física 4 clases 125 €
];

export const BONOS_CLASS_TYPES = ['modelado', 'torno'] as const;
export type BonosClassType = (typeof BONOS_CLASS_TYPES)[number];
export const DEFAULT_CLASS_TYPE: BonosClassType = 'modelado';

// ---------------------------------------------------------------------------
// Crypto (Web Crypto: Deno y Node)
// ---------------------------------------------------------------------------

const bytesToHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const sha256Bytes = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

export const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
};

export const sameHex = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

export const verifyStripeSignature = async (
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS
): Promise<boolean> => {
  if (!header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  const t = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => /^[0-9a-f]{64}$/i.test(signature) && sameHex(signature.toLowerCase(), expected));
};

export const signStripePayload = async (rawBody: string, secret: string, timestamp: number): Promise<string> =>
  `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;

// ---------------------------------------------------------------------------
// Clasificación y código
// ---------------------------------------------------------------------------

export interface StripeCheckoutSession {
  id: string;
  object?: string;
  mode?: string;
  status?: string;
  payment_status?: string;
  payment_link?: string | null;
  created?: number;
  amount_total?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
  customer_details?: {
    name?: string | null;
    individual_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  custom_fields?: Array<{
    key?: string;
    type?: string;
    text?: { value?: string | null } | null;
  }> | null;
}

export type GiftCardClassification =
  | { giftCard: true; classes: number; giftFormat: 'virtual' | 'physical' }
  | { giftCard: false; reason: string };

export const parsePaymentLinkAllowlist = (value: string | undefined): readonly string[] => {
  const ids = (value || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^plink_[A-Za-z0-9]+$/.test(id));
  return ids.length > 0 ? ids : DEFAULT_GIFT_CARD_PAYMENT_LINKS;
};

export const classifyGiftCardSession = (
  session: StripeCheckoutSession,
  allowlist: readonly string[] = DEFAULT_GIFT_CARD_PAYMENT_LINKS
): GiftCardClassification => {
  if (session.mode && session.mode !== 'payment') return { giftCard: false, reason: 'mode' };
  const metadata = session.metadata || {};
  if (metadata.source !== 'casa_rosier_web') return { giftCard: false, reason: 'metadata.source' };
  const giftFormat = metadata.gift_format;
  if (giftFormat !== 'virtual' && giftFormat !== 'physical') {
    return { giftCard: false, reason: 'metadata.gift_format' };
  }
  const classes = Number.parseInt(String(metadata.classes ?? ''), 10);
  if (!Number.isInteger(classes) || classes < 1 || classes > 4) {
    return { giftCard: false, reason: 'metadata.classes' };
  }
  if (!session.payment_link || !allowlist.includes(session.payment_link)) {
    return { giftCard: false, reason: 'payment_link' };
  }
  return { giftCard: true, classes, giftFormat };
};

export const parseClassType = (value: unknown): BonosClassType | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (BONOS_CLASS_TYPES as readonly string[]).includes(normalized)
    ? (normalized as BonosClassType)
    : undefined;
};

export const resolveClassType = (value: unknown): { type: BonosClassType; defaulted: boolean } => {
  const parsed = parseClassType(value);
  return parsed ? { type: parsed, defaulted: false } : { type: DEFAULT_CLASS_TYPE, defaulted: true };
};

export const getNameInitials = (name: string): string => {
  const parts = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'XX';
  if (parts.length === 1) return (parts[0].slice(0, 2) || 'X').padEnd(2, 'X');
  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
};

export const formatVoucherDateStamp = (creationDate?: string, now = new Date()): string => {
  const match = creationDate?.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? match[3] : match[3].slice(-2);
    return `${match[1].padStart(2, '0')}${match[2].padStart(2, '0')}${year}`;
  }
  const iso = creationDate?.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}${iso[2]}${iso[1].slice(-2)}`;
  return `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getFullYear()).slice(-2)}`;
};

export const madridDate = (epochSeconds: number | undefined, fallback = new Date()): string => {
  const date = epochSeconds ? new Date(epochSeconds * 1000) : fallback;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
};

export const stripeVoucherCode = async (
  sessionId: string,
  donorName: string,
  recipientName: string,
  creationDate: string
): Promise<string> => {
  const digest = await sha256Bytes(`stripe:${sessionId}`);
  const suffix = Array.from(digest.subarray(0, 4), (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join('');
  return `CR-${formatVoucherDateStamp(creationDate)}-${getNameInitials(donorName)}-${getNameInitials(recipientName)}-${suffix}`;
};

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max).trim() : value);
const customField = (session: StripeCheckoutSession, key: string): string =>
  String(session.custom_fields?.find((field) => field.key === key)?.text?.value ?? '').trim();

export const getSafeFileName = (donorName: string): string => {
  const safe = donorName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'Regalo';
  return `Bono-Casa-Rosier-${safe}.pdf`;
};

export interface BuiltStripeBono {
  voucherCode: string;
  errors: string[];
  record: {
    voucherCode: string;
    stripeSessionId: string;
    stripeEventId?: string;
    stripePaymentLink?: string | null;
    buyerName: string;
    buyerEmail?: string;
    buyerPhone?: string;
    recipientName: string;
    dedication?: string;
    numberOfClasses: number;
    sessionDuration: string;
    giftFormat: 'virtual' | 'physical';
    amountTotal?: number | null;
    currency?: string | null;
    classType: BonosClassType;
  };
  card: Record<string, unknown>;
  student: Record<string, unknown>;
}

export const buildBonoFromSession = async (
  session: StripeCheckoutSession,
  classification: { classes: number; giftFormat: 'virtual' | 'physical' },
  eventId?: string,
  now = new Date()
): Promise<BuiltStripeBono> => {
  const details = session.customer_details || {};
  const buyerName = clip(String(details.individual_name || details.name || '').trim(), 80);
  const recipientName = clip(customField(session, 'destinatario'), 80);
  const dedication = clip(customField(session, 'dedicatoria'), 500);
  const buyerEmail = String(details.email || '').trim() || undefined;
  const buyerPhone = String(details.phone || '').trim() || undefined;
  const creationDate = madridDate(session.created, now);
  const voucherCode = await stripeVoucherCode(session.id, buyerName, recipientName, creationDate);
  const metadata = session.metadata || {};
  const classType = resolveClassType(metadata.type || metadata.class_type);
  if (classType.defaulted) {
    console.warn('[stripe-giftcard-webhook] tipo de clase desconocido; se usa modelado', {
      code: voucherCode,
      ...(metadata.type || metadata.class_type ? { provided: metadata.type || metadata.class_type } : {})
    });
  }
  const errors: string[] = [];
  if (!buyerName) errors.push('Indica el nombre del comprador.');
  if (!recipientName) errors.push('Indica el nombre del destinatario.');
  const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null;
  const price = amountTotal !== null && (session.currency || 'eur') === 'eur' ? amountTotal / 100 : undefined;
  const activatedAt = creationDate.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (_, d, m, y) =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const fileName = getSafeFileName(buyerName);
  const card: Record<string, unknown> = {
    buyer: buyerName || 'Casa Rosier',
    recipient: recipientName || 'Sin destinatario',
    num_classes: classification.classes,
    type: classType.type,
    payment_status: 'paid',
    validity_months: DEFAULT_VALIDITY_MONTHS,
    code: voucherCode,
    external_reference: voucherCode,
    delivery_format: classification.giftFormat === 'physical' ? 'physical' : 'digital',
    extra_commentary: `Duración de la clase: ${STRIPE_GIFT_CARD_SESSION_HOURS} h`,
    activated_at: /^\d{4}-\d{2}-\d{2}$/.test(activatedAt) ? activatedAt : undefined,
    ...(buyerPhone ? { buyer_phone: buyerPhone } : {}),
    ...(buyerEmail ? { buyer_email: buyerEmail } : {}),
    ...(dedication ? { dedication } : {}),
    ...(price !== undefined ? { price } : {}),
    external_metadata: {
      source: STRIPE_WEBHOOK_SOURCE,
      voucherCode,
      fileName,
      donorName: buyerName,
      creationDate,
      classDurationHours: STRIPE_GIFT_CARD_SESSION_HOURS,
      stripeSessionId: session.id,
      ...(eventId ? { stripeEventId: eventId } : {}),
      ...(session.payment_link ? { stripePaymentLink: session.payment_link } : {}),
      giftFormat: classification.giftFormat,
      ...(classType.defaulted ? { typeDefaulted: true } : {})
    }
  };
  return {
    voucherCode,
    errors,
    record: {
      voucherCode,
      stripeSessionId: session.id,
      ...(eventId ? { stripeEventId: eventId } : {}),
      stripePaymentLink: session.payment_link || null,
      buyerName,
      ...(buyerEmail ? { buyerEmail } : {}),
      ...(buyerPhone ? { buyerPhone } : {}),
      recipientName,
      ...(dedication ? { dedication } : {}),
      numberOfClasses: classification.classes,
      sessionDuration: String(STRIPE_GIFT_CARD_SESSION_HOURS),
      giftFormat: classification.giftFormat,
      amountTotal,
      currency: session.currency || null,
      classType: classType.type
    },
    card,
    student: {
      full_name: recipientName || 'Sin destinatario',
      phone: null,
      notes: `Alumno temporal creado automáticamente desde Stripe (bono ${voucherCode}).`
    }
  };
};

// ---------------------------------------------------------------------------
// Almacén
// ---------------------------------------------------------------------------

export type GiftCardRow = Record<string, any>;

export interface StripeGiftCardStore {
  createWithTemporalStudent: (
    card: Record<string, unknown>,
    student: Record<string, unknown>
  ) => Promise<{ data: GiftCardRow | null; error: { code?: string; message?: string } | null }>;
  readByCode: (code: string) => Promise<{ data: GiftCardRow | null; error: { code?: string; message?: string } | null }>;
  readByStripeSessionId: (sessionId: string) => Promise<{ data: GiftCardRow | null; error: { code?: string; message?: string } | null }>;
  listRecent: (limit: number) => Promise<{ data: GiftCardRow[] | null; error: { code?: string; message?: string } | null }>;
  updateMetadata: (id: string, metadata: Record<string, unknown>) => Promise<{ error: { code?: string; message?: string } | null }>;
}

export const createStripeGiftCardStore = (client: SupabaseClient, sedeId: string): StripeGiftCardStore => ({
  async createWithTemporalStudent(card, student) {
    return client.rpc('external_create_gift_card_with_temporal_student', {
      p_sede_id: sedeId,
      p_card: card,
      p_student: student
    });
  },
  async readByCode(code) {
    const { data, error } = await client
      .from('gift_cards')
      .select(giftCardSelect)
      .eq('sede_id', sedeId)
      .eq('code', code.trim().toUpperCase())
      .maybeSingle();
    return { data, error };
  },
  async readByStripeSessionId(sessionId) {
    const { data, error } = await client
      .from('gift_cards')
      .select(giftCardSelect)
      .eq('sede_id', sedeId)
      .filter('external_metadata->>source', 'eq', STRIPE_WEBHOOK_SOURCE)
      .filter('external_metadata->>stripeSessionId', 'eq', sessionId)
      .maybeSingle();
    return { data: Array.isArray(data) ? data[0] || null : data, error };
  },
  async listRecent(limit) {
    const { data, error } = await client
      .from('gift_cards')
      .select(giftCardSelect)
      .eq('sede_id', sedeId)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(limit);
    return { data, error };
  },
  async updateMetadata(id, metadata) {
    const { error } = await client
      .from('gift_cards')
      .update({ external_metadata: metadata })
      .eq('id', id)
      .eq('sede_id', sedeId);
    return { error };
  }
});

// ---------------------------------------------------------------------------
// Procesado del evento
// ---------------------------------------------------------------------------

export type NotifyResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

export interface WebhookDeps {
  store: StripeGiftCardStore;
  fetchSession: (sessionId: string) => Promise<StripeCheckoutSession | null>;
  allowlist: readonly string[];
  now: () => Date;
  notify: (record: BuiltStripeBono['record'] & { createdAt: string }) => Promise<NotifyResult>;
}

export type WebhookOutcome =
  | { status: 200; body: { ok: true; result: 'ignored'; reason: string } }
  | {
      status: 200;
      body: {
        ok: true;
        result: 'created' | 'duplicate';
        voucherCode: string;
        bonos: 'saved' | 'exists';
        notify: NotifyResult['status'] | 'not_sent';
      };
    }
  | { status: 422; body: { ok: false; error: string; details?: string[] } }
  | { status: 500; body: { ok: false; error: string } };

const ignored = (reason: string): WebhookOutcome => ({ status: 200, body: { ok: true, result: 'ignored', reason } });
const failure = (error: string): WebhookOutcome => ({ status: 500, body: { ok: false, error } });

export interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: StripeCheckoutSession };
}

const isStripeBono = (row: GiftCardRow | null): row is GiftCardRow =>
  Boolean(row && (row.external_metadata || {}).source === STRIPE_WEBHOOK_SOURCE);

export const processStripeEvent = async (event: StripeEvent, deps: WebhookDeps): Promise<WebhookOutcome> => {
  if (!event.type || !(HANDLED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return ignored(`event:${event.type || 'unknown'}`);
  }
  let session = event.data?.object;
  if (!session?.id || session.object !== 'checkout.session') return ignored('not_a_checkout_session');

  const preliminary = classifyGiftCardSession(session, deps.allowlist);
  if (preliminary.giftCard === false) return ignored(`not_gift_card:${preliminary.reason}`);

  try {
    const fresh = await deps.fetchSession(session.id);
    if (fresh) session = fresh;
  } catch (error) {
    return failure(`stripe_fetch_failed: ${error instanceof Error ? error.message : 'error'}`);
  }

  const classification = classifyGiftCardSession(session, deps.allowlist);
  if (classification.giftCard === false) return ignored(`not_gift_card:${classification.reason}`);
  if (session.payment_status !== 'paid') return ignored(`payment_status:${session.payment_status || 'unknown'}`);

  const built = await buildBonoFromSession(session, classification, event.id, deps.now());
  if (built.errors.length > 0) {
    console.error('[stripe-giftcard-webhook] datos de la sesión no válidos', session.id, built.errors);
    return { status: 422, body: { ok: false, error: 'invalid_session_data', details: built.errors } };
  }

  // Idempotencia por sesión: si el webhook antiguo (u otro reintento) ya creó el bono.
  try {
    const existingBySession = await deps.store.readByStripeSessionId(session.id);
    if (existingBySession.data) {
      return {
        status: 200,
        body: { ok: true, result: 'duplicate', voucherCode: existingBySession.data.code, bonos: 'exists', notify: 'not_sent' }
      };
    }
  } catch (error) {
    console.error('[stripe-giftcard-webhook] no se pudo buscar por sesión', session.id, error);
  }

  const created = await deps.store.createWithTemporalStudent(built.card, built.student);
  if (created.error) {
    const duplicate = created.error.code === '23505' || /duplicate key/i.test(created.error.message || '');
    if (!duplicate) return failure(`pottery_gym_error: ${created.error.message || created.error.code || 'error'}`);
    try {
      const existing = await deps.store.readByCode(built.voucherCode);
      const existingSession = existing.data?.external_metadata?.stripeSessionId;
      if (existing.data && existingSession && existingSession !== session.id) return failure('voucher_code_collision');
    } catch (error) {
      console.error('[stripe-giftcard-webhook] no se pudo confirmar el duplicado', built.voucherCode, error);
    }
    return {
      status: 200,
      body: { ok: true, result: 'duplicate', voucherCode: built.voucherCode, bonos: 'exists', notify: 'not_sent' }
    };
  }

  const record = { ...built.record, createdAt: deps.now().toISOString() };
  let notify: NotifyResult;
  try {
    notify = await deps.notify(record);
  } catch (error) {
    notify = { status: 'error', error: error instanceof Error ? error.message : 'notify_failed' };
  }
  if (notify.status === 'error') {
    console.error('[stripe-giftcard-webhook] aviso a asistonto falló', built.voucherCode, notify.error);
  }
  return {
    status: 200,
    body: { ok: true, result: 'created', voucherCode: built.voucherCode, bonos: 'saved', notify: notify.status }
  };
};

export const fetchCheckoutSessionFromStripe = async (
  sessionId: string,
  secretKey?: string
): Promise<StripeCheckoutSession | null> => {
  if (!secretKey) return null;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` }
  });
  if (!response.ok) throw new Error(`stripe ${response.status}`);
  return (await response.json()) as StripeCheckoutSession;
};

export const handleStripeWebhook = async (
  rawBody: string,
  signatureHeader: string | null,
  deps: WebhookDeps,
  secret: string
): Promise<{ status: number; body: unknown }> => {
  if (!secret) return { status: 503, body: { ok: false, error: 'STRIPE_WEBHOOK_SECRET no configurado' } };
  if (!(await verifyStripeSignature(rawBody, signatureHeader, secret, Math.floor(deps.now().getTime() / 1000)))) {
    return { status: 400, body: { ok: false, error: 'invalid_signature' } };
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json' } };
  }
  try {
    const outcome = await processStripeEvent(event, deps);
    if (outcome.status === 500) console.error('[stripe-giftcard-webhook]', event.id, outcome.body.error);
    return outcome;
  } catch (error) {
    console.error('[stripe-giftcard-webhook] unexpected', event.id, error);
    return { status: 500, body: { ok: false, error: 'internal_error' } };
  }
};

// ---------------------------------------------------------------------------
// Aviso a asistonto (opcional; el fallo no rompe el bono)
// ---------------------------------------------------------------------------

export const buildNotifyPayload = (
  record: BuiltStripeBono['record'] & { createdAt: string },
  now = new Date()
) => ({
  type: NOTIFY_EVENT_TYPE,
  id: record.voucherCode,
  voucherCode: record.voucherCode,
  amount: typeof record.amountTotal === 'number' ? record.amountTotal / 100 : null,
  currency: record.currency ? record.currency.toUpperCase() : null,
  buyerName: record.buyerName,
  recipientName: record.recipientName,
  numberOfClasses: record.numberOfClasses,
  giftFormat: record.giftFormat,
  classType: record.classType,
  stripeSessionId: record.stripeSessionId,
  pendingPath: '/functions/v1/stripe-giftcard-pending',
  createdAt: record.createdAt,
  sentAt: now.toISOString()
});

export const signNotifyBody = async (rawBody: string, secret: string, timestamp: number): Promise<string> =>
  `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;

export const notifyAsistonto = async (
  record: BuiltStripeBono['record'] & { createdAt: string },
  options: { url?: string; secret?: string; now?: Date; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<NotifyResult> => {
  const url = (options.url || '').trim();
  const secret = (options.secret || '').trim();
  if (!url) return { status: 'skipped', reason: 'ASISTONTO_NOTIFY_WEBHOOK_URL no configurada' };
  if (!secret) return { status: 'skipped', reason: 'ASISTONTO_NOTIFY_SECRET no configurado' };
  if (!/^https:\/\//i.test(url)) return { status: 'skipped', reason: 'la URL de aviso debe ser https' };
  const now = options.now ?? new Date();
  const body = JSON.stringify(buildNotifyPayload(record, now));
  const signature = await signNotifyBody(body, secret, Math.floor(now.getTime() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? NOTIFY_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NOTIFY_SIGNATURE_HEADER]: signature,
        'Idempotency-Key': record.voucherCode
      },
      body,
      signal: controller.signal
    });
    if (!response.ok) return { status: 'error', error: `HTTP ${response.status}` };
    return { status: 'sent' };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : 'notify_failed' };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Cola pendiente (equivalente a GET/POST /api/gift-cards/pending)
// ---------------------------------------------------------------------------

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const toNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
};

export const toPendingEntry = (row: GiftCardRow) => {
  const metadata = row.external_metadata || {};
  const published = publicGiftCard(row);
  return {
    voucherCode: published.code,
    stripeSessionId: text(metadata.stripeSessionId) || null,
    createdAt: published.createdAt || null,
    creationDate: text(metadata.creationDate) || null,
    buyerName: published.buyer,
    buyerEmail: published.buyerEmail || null,
    buyerPhone: published.buyerPhone || null,
    recipientName: published.recipient,
    dedication: published.dedication || null,
    numberOfClasses: published.numClasses,
    type: published.type,
    giftFormat: text(metadata.giftFormat) || (published.deliveryFormat === 'physical' ? 'physical' : 'virtual'),
    amount: toNumber(published.price),
    currency: 'EUR',
    paymentStatus: published.paymentStatus || null,
    expiryDate: published.expiryDate || null,
    acknowledgedAt: text(metadata.acknowledgedAt) || null,
    pendingPath: `/functions/v1/stripe-giftcard-pending?code=${encodeURIComponent(String(published.code || ''))}`
  };
};

export const listPendingStripeGiftCards = async (store: StripeGiftCardStore) => {
  const { data, error } = await store.listRecent(100);
  if (error) throw new Error(error.message || 'list_failed');
  return (data || [])
    .filter((row) => isStripeBono(row) && !text((row.external_metadata || {}).acknowledgedAt))
    .map(toPendingEntry)
    .reverse();
};

export const getPendingStripeGiftCard = async (
  store: StripeGiftCardStore,
  code: string,
  buildPdf?: (data: import('./gift-card-pdf/types.ts').GiftCardData) => Promise<Uint8Array>
) => {
  const { data, error } = await store.readByCode(code);
  if (error) throw new Error(error.message || 'read_failed');
  if (!isStripeBono(data)) return null;
  const { cardDataFromGiftCardRow, pdfFileNameFromRow, bytesToBase64 } = await import('./gift-card-pdf/cardDataFromRow.ts');
  const fileName = pdfFileNameFromRow(data);
  let pdfBase64: string | null = null;
  let pdfError: string | undefined;
  try {
    const cardData = cardDataFromGiftCardRow(data);
    const bytes = await (buildPdf
      ? buildPdf(cardData)
      : (await import('./gift-card-pdf/giftCardPdf.ts')).buildGiftCardPdfBytes(cardData));
    pdfBase64 = bytesToBase64(bytes);
  } catch (err) {
    pdfError = err instanceof Error ? err.message : 'No se pudo generar el PDF';
    console.error('[stripe-giftcard-pending] PDF', pdfError);
  }
  return {
    giftCard: toPendingEntry(data),
    fileName,
    pdfBase64,
    ...(pdfError ? { pdfError } : {})
  };
};

export const acknowledgeStripeGiftCards = async (
  store: StripeGiftCardStore,
  voucherCodes: string[],
  acknowledgedBy: string,
  now = new Date()
): Promise<{ acknowledged: string[]; notFound: string[] }> => {
  const acknowledged: string[] = [];
  const notFound: string[] = [];
  for (const raw of voucherCodes) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code) continue;
    const { data } = await store.readByCode(code);
    if (!isStripeBono(data)) {
      notFound.push(code);
      continue;
    }
    const metadata = { ...(data.external_metadata || {}) };
    if (!text(metadata.acknowledgedAt)) {
      const { error } = await store.updateMetadata(data.id, {
        ...metadata,
        acknowledgedAt: now.toISOString(),
        acknowledgedBy
      });
      if (error) throw new Error(error.message || 'update_failed');
    }
    acknowledged.push(code);
  }
  return { acknowledged, notFound };
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const webhookJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });

export const handleWebhookRequest = async (req: Request, env: Env, store: StripeGiftCardStore): Promise<Response> => {
  if (req.method !== 'POST') return webhookJson(405, { ok: false, error: 'Method not allowed' });
  const secret = (env('STRIPE_WEBHOOK_SECRET') || '').trim();
  const sedeId = (env('ASISTONTO_SEDE_ID') || env('BONOS_API_SEDE_ID') || '').trim();
  const missing = [
    !env('SUPABASE_URL') && 'SUPABASE_URL',
    !env('SUPABASE_SERVICE_ROLE_KEY') && 'SUPABASE_SERVICE_ROLE_KEY',
    !UUID.test(sedeId) && 'ASISTONTO_SEDE_ID'
  ].filter(Boolean);
  // The signing secret is checked first so a probe without it always gets 503/400,
  // even if the database config is also incomplete.
  const rawBody = await req.text();
  if (!secret) return webhookJson(503, { ok: false, error: 'STRIPE_WEBHOOK_SECRET no configurado' });
  if (missing.length) return webhookJson(503, { ok: false, error: 'Server configuration is incomplete', missing });
  const deps: WebhookDeps = {
    store,
    fetchSession: (sessionId) => fetchCheckoutSessionFromStripe(sessionId, env('STRIPE_SECRET_KEY')?.trim()),
    allowlist: parsePaymentLinkAllowlist(env('STRIPE_GIFT_CARD_PAYMENT_LINKS')),
    now: () => new Date(),
    notify: (record) =>
      notifyAsistonto(record, {
        url: env('ASISTONTO_NOTIFY_WEBHOOK_URL'),
        secret: env('ASISTONTO_NOTIFY_SECRET')
      })
  };
  const result = await handleStripeWebhook(rawBody, req.headers.get('stripe-signature'), deps, secret);
  return webhookJson(result.status, result.body);
};

const pendingConfig = (env: Env): { sedeId: string } | Response => {
  const sedeId = (env('ASISTONTO_SEDE_ID') || env('BONOS_API_SEDE_ID') || '').trim();
  const missing = [
    !env('SUPABASE_URL') && 'SUPABASE_URL',
    !env('SUPABASE_SERVICE_ROLE_KEY') && 'SUPABASE_SERVICE_ROLE_KEY',
    !UUID.test(sedeId) && 'ASISTONTO_SEDE_ID',
    !fingerprints(env('ASISTONTO_KEY_SHA256')).length && !fingerprints(env('RIO_APPROVER_KEY_SHA256')).length && 'ASISTONTO_KEY_SHA256'
  ].filter(Boolean);
  if (missing.length) return actorJson({ error: 'Server configuration is incomplete', missing }, 503);
  return { sedeId };
};

export const handlePendingRequest = async (
  req: Request,
  env: Env,
  storeFactory: (env: Env, sedeId: string) => StripeGiftCardStore
): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const actor: Actor | null = await identify(req, env);
  if (!actor) return actorJson({ ok: false, error: 'No autorizado. Usa el header x-api-key.' }, 401);
  const config = pendingConfig(env);
  if (config instanceof Response) return config;
  const store = storeFactory(env, config.sedeId);
  try {
    if (req.method === 'GET') {
      const code = new URL(req.url).searchParams.get('code')?.trim() || '';
      if (code) {
        const result = await getPendingStripeGiftCard(store, code);
        if (!result) return actorJson({ ok: false, error: 'Bono del webhook no encontrado.' }, 404);
        return actorJson({ ok: true, ...result }, 200);
      }
      const giftCards = await listPendingStripeGiftCards(store);
      return actorJson({ ok: true, count: giftCards.length, giftCards }, 200);
    }
    if (req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await req.text());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
        body = parsed;
      } catch {
        return actorJson({ ok: false, error: 'Body must be a JSON object' }, 400);
      }
      const codes = Array.isArray(body.voucherCodes) ? body.voucherCodes.map(String) : [];
      if (codes.length === 0 || codes.length > 100) {
        return actorJson({ ok: false, error: 'Indica {"voucherCodes": ["CR-..."]} (1 a 100 códigos).' }, 400);
      }
      const result = await acknowledgeStripeGiftCards(store, codes, actor);
      return actorJson({ ok: true, ...result }, 200);
    }
    return actorJson({ ok: false, error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('[stripe-giftcard-pending]', error instanceof Error ? error.message : 'error');
    return actorJson({ ok: false, error: 'Error interno del servidor' }, 500);
  }
};

export const makeDefaultStore = (env: Env, sedeId: string): StripeGiftCardStore => {
  const client = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  return createStripeGiftCardStore(client, sedeId);
};
