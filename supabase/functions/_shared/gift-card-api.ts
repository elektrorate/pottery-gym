import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-api-key, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

export const giftCardSelect = [
  'id', 'sede_id', 'code', 'buyer', 'buyer_phone', 'buyer_email', 'recipient', 'recipient_email',
  'recipient_student_id', 'num_classes', 'type', 'validity_months', 'activated_at', 'scheduled_date',
  'expiry_date', 'price', 'payment_status', 'status', 'sessions_used', 'delivery_format', 'dedication',
  'consumed_at', 'extra_commentary', 'internal_notes', 'external_reference', 'external_metadata', 'created_at'
].join(',');

type Scope = 'read' | 'write';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...headers }
  });

export const options = () => new Response('ok', { headers: corsHeaders });

const secureEqual = async (left: string, right: string) => {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
};

export const authenticate = async (req: Request, scope: Scope) => {
  const expectedKey = Deno.env.get(scope === 'read' ? 'BONOS_READ_API_KEY' : 'BONOS_WRITE_API_KEY')?.trim();
  const providedKey = (req.headers.get('x-api-key') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '').trim();
  const sedeId = Deno.env.get('BONOS_API_SEDE_ID')?.trim();
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!expectedKey || !sedeId || !supabaseUrl || !serviceRoleKey) {
    return { error: json({ error: 'Server configuration is incomplete' }, 500) };
  }
  if (!providedKey || !(await secureEqual(providedKey, expectedKey))) {
    return { error: json({ error: 'Invalid API key' }, 401) };
  }

  return {
    client: createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } }),
    sedeId
  };
};

export const parseBody = async (req: Request) => {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const publicGiftCard = (row: Record<string, any>, movements?: Record<string, any>[]) => ({
  id: row.id,
  code: row.code,
  buyer: row.buyer,
  buyerPhone: row.buyer_phone,
  buyerEmail: row.buyer_email,
  recipient: row.recipient,
  recipientEmail: row.recipient_email,
  recipientStudentId: row.recipient_student_id,
  numClasses: row.num_classes,
  type: row.type,
  validityMonths: row.validity_months,
  activatedAt: row.activated_at,
  issuedDate: row.scheduled_date,
  expiryDate: row.expiry_date,
  price: row.price,
  paymentStatus: row.payment_status,
  status: row.status,
  sessionsUsed: row.sessions_used ?? 0,
  sessionsRemaining: Math.max(0, (row.num_classes ?? 0) - (row.sessions_used ?? 0)),
  deliveryFormat: row.delivery_format,
  dedication: row.dedication,
  consumedAt: row.consumed_at,
  extraCommentary: row.extra_commentary,
  internalNotes: row.internal_notes,
  externalReference: row.external_reference,
  metadata: row.external_metadata || {},
  createdAt: row.created_at,
  ...(movements ? { movements } : {})
});

export const errorStatus = (message: string) => {
  const normalized = message.toLowerCase();
  if (normalized.includes('no encontrado')) return 404;
  if (normalized.includes('no autorizado') || normalized.includes('api key')) return 403;
  return 409;
};

export type ApiClient = SupabaseClient;
