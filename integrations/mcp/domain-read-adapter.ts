import {
  DomainReadError, domainReadDataSchemas, domainReadInputSchema,
  parseDomainReadRequest, parseDomainReadResponse, readDomainJson,
  type DomainReadOperation
} from '../../supabase/functions/_shared/domain-read-contract.ts';

const toolOperations = {
  get_student_summary: 'student.summary.get',
  get_membership_status: 'membership.status.get'
} as const satisfies Record<string, DomainReadOperation>;

// Contract-only in-process adapter. No listener, MCP SDK or client registration.
export function createDomainReadAdapter(config: {
  supabaseOrigin: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
}) {
  const origin = new URL(config.supabaseOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || origin.port) {
    throw new Error('Expected a trusted HTTPS Supabase origin without path or credentials');
  }
  const endpoint = `${origin.origin}/functions/v1/domain-read`;
  // Capture server configuration once; tool input cannot replace transport/auth.
  const send = config.fetch ?? fetch;
  const getAccessToken = config.getAccessToken;
  const tools = Object.entries(toolOperations).map(([name, operation]) => ({
    name,
    description: `${operation}: provisioned staff/integration read only; not student self-service.`,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sedeId', 'studentId'],
      properties: { sedeId: domainReadInputSchema.properties.sedeId, studentId: domainReadInputSchema.properties.studentId }
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['version', 'operation', 'data'],
      properties: { version: { const: 1 }, operation: { const: operation }, data: domainReadDataSchemas[operation] }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }));

  return {
    // Return copies so discovery consumers cannot mutate validation/tool routing.
    listTools: () => structuredClone(tools),
    callTool: async (name: string, args: unknown) => {
      if (!Object.hasOwn(toolOperations, name)) throw new DomainReadError(400, 'unknown_tool');
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).length !== 2 || !Object.hasOwn(args, 'sedeId') || !Object.hasOwn(args, 'studentId')) {
        throw new DomainReadError(400, 'invalid_request');
      }
      const operation = toolOperations[name as keyof typeof toolOperations];
      const request = parseDomainReadRequest({ ...args, version: 1, operation });
      let result;
      try {
        const token = await getAccessToken();
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) {
          throw new DomainReadError(401, 'unauthorized');
        }
        const response = await send(endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request), redirect: 'error', credentials: 'omit', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) {
          const status = [400, 401, 403, 413, 415, 429].includes(response.status) ? response.status : 503;
          throw new DomainReadError(status, status === 403 ? 'forbidden' : 'domain_read_failed');
        }
        result = parseDomainReadResponse(await readDomainJson(response, 8192), request);
      } catch (error) {
        if (error instanceof DomainReadError) throw error;
        throw new DomainReadError(503, 'domain_read_failed');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  };
}
