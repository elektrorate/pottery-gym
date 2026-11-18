// Shared core of the asistonto-read / asistonto-write Edge Functions.
// * Callers authenticate with their own key; only SHA-256 fingerprints are configured
//   (ASISTONTO_KEY_SHA256 / RIO_APPROVER_KEY_SHA256, comma-separated hex). The key in
//   clear never lives in this project, in the repository or in any chat.
// * service_role stays inside this function; callers only reach two narrow RPCs
//   (public.asistonto_read / public.asistonto_write) that are scoped to one sede.
// * Writes are draft -> approve (RIO) -> commit and are disabled unless
//   ASISTONTO_WRITES_ENABLED === 'true'.

export type Actor = 'asistonto' | 'rio';
export type Env = (name: string) => string | undefined;
export type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};
export type ClientFactory = (url: string, serviceRoleKey: string) => RpcClient;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8192;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  // Server-to-server API: no CORS headers, never cached.
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

export const fingerprints = (raw: string | undefined): string[] =>
  [...new Set((raw || '').split(',').map((part) => part.trim().toLowerCase()).filter((part) => HEX64.test(part)))];

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const sameHex = (left: string, right: string) => {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

export const extractKey = (req: Request): string | null => {
  const header = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const key = header.trim();
  return key.length >= 32 && key.length <= 256 ? key : null;
};

/** Resolves the caller from its key fingerprint. Every list is always scanned. */
export const identify = async (req: Request, env: Env): Promise<Actor | null> => {
  const key = extractKey(req);
  if (!key) return null;
  const digest = await sha256Hex(key);
  let asistonto = false;
  let rio = false;
  for (const candidate of fingerprints(env('ASISTONTO_KEY_SHA256'))) asistonto = sameHex(digest, candidate) || asistonto;
  for (const candidate of fingerprints(env('RIO_APPROVER_KEY_SHA256'))) rio = sameHex(digest, candidate) || rio;
  if (asistonto && rio) return null; // a key must identify exactly one actor
  return asistonto ? 'asistonto' : rio ? 'rio' : null;
};

type Config = { client: RpcClient; sedeId: string };
const configure = (env: Env, makeClient: ClientFactory): Config | Response => {
  const sedeId = (env('ASISTONTO_SEDE_ID') || env('BONOS_API_SEDE_ID') || '').trim();
  const missing = [
    !env('SUPABASE_URL') && 'SUPABASE_URL',
    !env('SUPABASE_SERVICE_ROLE_KEY') && 'SUPABASE_SERVICE_ROLE_KEY',
    !UUID.test(sedeId) && 'ASISTONTO_SEDE_ID',
    !fingerprints(env('ASISTONTO_KEY_SHA256')).length && !fingerprints(env('RIO_APPROVER_KEY_SHA256')).length && 'ASISTONTO_KEY_SHA256'
  ].filter(Boolean);
  if (missing.length) return json({ error: 'Server configuration is incomplete', missing }, 503);
  return { client: makeClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!), sedeId };
};

const STATUS_BY_CODE: Record<string, number> = {
  AS400: 400, AS403: 403, AS404: 404, AS409: 409, AS410: 410,
  '22023': 400, '22P02': 400, '22007': 400, '22008': 400, '42501': 403, '23505': 409, '40001': 409, P0001: 409
};

/** Maps database errors to HTTP without leaking internals for unexpected failures. */
export const dbError = (error: { code?: string; message?: string }) => {
  const status = STATUS_BY_CODE[error.code || ''] || 500;
  const message = status === 500 ? 'Internal error' : String(error.message || 'Request rejected').slice(0, 200);
  return json({ error: message, code: status === 500 ? undefined : error.code }, status);
};

const log = (fn: string, actor: Actor | null, op: string | null, status: number) =>
  console.info(JSON.stringify({ fn, actor, op, status })); // never bodies, keys or personal data

const READ_PARAMS: Record<string, string[]> = {
  bonos: ['code', 'status', 'limit'], calendario: ['from', 'to'], clases: [], alumnos: ['q'], alumno: ['id']
};

export const handleRead = async (req: Request, env: Env, makeClient: ClientFactory): Promise<Response> => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const actor = await identify(req, env);
  if (!actor) { log('asistonto-read', null, null, 401); return json({ error: 'Invalid API key' }, 401); }
  const config = configure(env, makeClient);
  if (config instanceof Response) return config;
  const url = new URL(req.url);
  const op = url.searchParams.get('op') || '';
  const allowed = READ_PARAMS[op];
  if (!allowed) return json({ error: 'Unknown op', ops: Object.keys(READ_PARAMS) }, 400);
  const params: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (name === 'op') continue;
    if (!allowed.includes(name) || name in params || value.length > 200) return json({ error: `Unsupported parameter ${name}` }, 400);
    params[name] = value;
  }
  const { data, error } = await config.client.rpc('asistonto_read', { p_sede_id: config.sedeId, p_op: op, p_params: params });
  const response = error ? dbError(error) : json(data, 200);
  log('asistonto-read', actor, op, response.status);
  return response;
};

const WRITE_OPS: Record<string, { actors: Actor[]; fields: string[] }> = {
  draft: { actors: ['asistonto'], fields: ['kind', 'payload'] },
  approve: { actors: ['rio'], fields: ['draftId', 'approvalRef'] },
  commit: { actors: ['asistonto', 'rio'], fields: ['draftId'] },
  discard: { actors: ['asistonto', 'rio'], fields: ['draftId'] },
  list: { actors: ['asistonto', 'rio'], fields: ['status'] }
};

export const handleWrite = async (req: Request, env: Env, makeClient: ClientFactory): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const actor = await identify(req, env);
  if (!actor) { log('asistonto-write', null, null, 401); return json({ error: 'Invalid API key' }, 401); }
  if (env('ASISTONTO_WRITES_ENABLED') !== 'true') {
    log('asistonto-write', actor, null, 403);
    return json({ error: 'Asistonto writes are disabled' }, 403);
  }
  const config = configure(env, makeClient);
  if (config instanceof Response) return config;
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'Body too large' }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed;
  } catch { return json({ error: 'Body must be a JSON object' }, 400); }
  const op = typeof body.op === 'string' ? body.op : '';
  const rule = WRITE_OPS[op];
  if (!rule) return json({ error: 'Unknown op', ops: Object.keys(WRITE_OPS) }, 400);
  if (!rule.actors.includes(actor)) { log('asistonto-write', actor, op, 403); return json({ error: `Only ${rule.actors.join(' or ')} may ${op}` }, 403); }
  const { op: _op, ...params } = body;
  const extra = Object.keys(params).find((name) => !rule.fields.includes(name));
  if (extra) return json({ error: `Unsupported field ${extra}` }, 400);
  const { data, error } = await config.client.rpc('asistonto_write', {
    p_sede_id: config.sedeId, p_actor: actor, p_op: op, p_params: params
  });
  const response = error ? dbError(error) : json(data, op === 'draft' ? 201 : 200);
  log('asistonto-write', actor, op, response.status);
  return response;
};
