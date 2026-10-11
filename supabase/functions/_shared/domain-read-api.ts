import {
  DomainReadError, parseDomainReadRequest, parseDomainReadResponse, readDomainJson,
  type DomainReadOperation, type DomainReadRequest
} from './domain-read-contract.ts';

export type DomainReadAudit = {
  event: 'domain_read'; requestId: string; operation: DomainReadOperation | null; status: number;
};
export type DomainReadBackend = {
  authenticate: (token: string) => Promise<boolean>;
  read: (token: string, request: DomainReadRequest) => Promise<{
    data: unknown; error: { code: string } | null;
  }>;
  audit: (event: DomainReadAudit) => void;
};

export function createDomainReadBackend(config: {
  supabaseOrigin?: string;
  anonKey?: string;
  fetch?: typeof fetch;
  audit: DomainReadBackend['audit'];
}): DomainReadBackend {
  const send = config.fetch ?? fetch;
  const origin = config.supabaseOrigin?.replace(/\/$/, '');
  const anonKey = config.anonKey;
  // No service-role client: both fixed routes receive the caller's user JWT.
  const upstream = (path: string, token: string, body?: unknown) => {
    if (!origin || !anonKey) throw new DomainReadError(503, 'read_unavailable');
    return send(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000)
    });
  };
  return {
    authenticate: async token => {
      const response = await upstream('/auth/v1/user', token);
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new DomainReadError(503, 'read_unavailable');
      const user = await readDomainJson(response, 32_768);
      return user !== null && typeof user === 'object' && 'id' in user && typeof user.id === 'string';
    },
    read: async (token, request) => {
      const response = await upstream('/rest/v1/rpc/domain_read_v1', token, { p_request: request });
      if (response.status === 401) throw new DomainReadError(401, 'unauthorized');
      const payload = await readDomainJson(response, 8192);
      if (!response.ok) {
        const code = payload !== null && typeof payload === 'object' && 'code' in payload ? payload.code : '';
        return { data: null, error: { code: typeof code === 'string' ? code : '' } };
      }
      return { data: payload, error: null };
    },
    audit: config.audit
  };
}

export function createDomainReadHandler(backend: DomainReadBackend) {
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    let operation: DomainReadOperation | null = null;
    let status = 500;
    let body: unknown;
    try {
      if (req.method !== 'POST') throw new DomainReadError(405, 'method_not_allowed');
      // Only the exact endpoint is supported, not URL-based query/CRUD dispatch.
      const url = new URL(req.url);
      if (!['/domain-read', '/functions/v1/domain-read'].includes(url.pathname) || url.search) {
        throw new DomainReadError(400, 'invalid_request');
      }
      const authorization = req.headers.get('authorization');
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
      if (!match || authorization!.length > 8192) throw new DomainReadError(401, 'unauthorized');
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new DomainReadError(415, 'unsupported_media_type');
      }
      const request = parseDomainReadRequest(await readDomainJson(req));
      operation = request.operation;
      const token = match[1];
      if (!await backend.authenticate(token)) throw new DomainReadError(401, 'unauthorized');
      const result = await backend.read(token, request);
      if (result.error) {
        if (result.error.code === '42501') throw new DomainReadError(403, 'forbidden');
        if (result.error.code === '22023') throw new DomainReadError(400, 'invalid_request');
        throw new DomainReadError(503, 'read_unavailable');
      }
      body = parseDomainReadResponse(result.data, request);
      status = 200;
    } catch (error) {
      status = error instanceof DomainReadError ? error.status : 503;
      body = { error: error instanceof DomainReadError ? error.code : 'read_unavailable' };
    }
    // No tokens, claims, resource IDs, URLs, payloads or database error messages.
    backend.audit({ event: 'domain_read', requestId, operation, status });
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId,
        ...(status === 405 ? { Allow: 'POST' } : {})
      }
    });
  };
}
