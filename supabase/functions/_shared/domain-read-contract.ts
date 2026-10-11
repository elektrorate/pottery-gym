export const DOMAIN_READ_OPERATIONS = ['student.summary.get', 'membership.status.get'] as const;
export type DomainReadOperation = typeof DOMAIN_READ_OPERATIONS[number];
export type DomainReadRequest = {
  version: 1;
  operation: DomainReadOperation;
  sedeId: string;
  studentId: string;
};

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const uuid = new RegExp(uuidPattern);
const categories = ['membresia', 'iniciacion', 'grupal', 'temporal', 'grupo_temporal'];
const nullableEnum = (values: string[]) => ({ enum: [...values, null] });
const nullableInteger = { type: ['integer', 'null'] };
const nullableDate = { type: ['string', 'null'], format: 'date' };

export const domainReadInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'operation', 'sedeId', 'studentId'],
  properties: {
    version: { const: 1 }, operation: { enum: DOMAIN_READ_OPERATIONS },
    sedeId: { type: 'string', pattern: uuidPattern }, studentId: { type: 'string', pattern: uuidPattern }
  }
} as const;

export const domainReadDataSchemas = {
  'student.summary.get': {
    type: 'object', additionalProperties: false,
    required: ['studentId', 'sedeId', 'category', 'archived'],
    properties: {
      studentId: { type: 'string', pattern: uuidPattern }, sedeId: { type: 'string', pattern: uuidPattern },
      category: nullableEnum(categories), archived: { type: 'boolean' }
    }
  },
  'membership.status.get': {
    type: ['object', 'null'], additionalProperties: false,
    required: ['studentId', 'sedeId', 'effectivePeriodId', 'tier', 'allocatedClasses', 'classesRemaining', 'startsOn', 'endsOn', 'paymentStatus'],
    properties: {
      studentId: { type: 'string', pattern: uuidPattern }, sedeId: { type: 'string', pattern: uuidPattern },
      effectivePeriodId: { type: ['string', 'null'], pattern: uuidPattern },
      tier: nullableEnum(['plata', 'gold', 'platinum']), allocatedClasses: nullableInteger,
      classesRemaining: nullableInteger, startsOn: nullableDate, endsOn: nullableDate,
      paymentStatus: nullableEnum(['pending', 'paid'])
    }
  }
} as const;

export class DomainReadError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function parseDomainReadRequest(value: unknown): DomainReadRequest {
  if (!object(value) || !exactKeys(value, domainReadInputSchema.required)
    || value.version !== 1 || !DOMAIN_READ_OPERATIONS.includes(value.operation as DomainReadOperation)
    || typeof value.sedeId !== 'string' || !uuid.test(value.sedeId)
    || typeof value.studentId !== 'string' || !uuid.test(value.studentId)) {
    throw new DomainReadError(400, 'invalid_request');
  }
  return { version: 1, operation: value.operation as DomainReadOperation,
    sedeId: value.sedeId.toLowerCase(), studentId: value.studentId.toLowerCase() };
}

export type DomainReadResponse = { version: 1; operation: DomainReadOperation; data: Record<string, unknown> | null };

// Validate the response too: an upstream schema change must not leak new fields.
export function parseDomainReadResponse(value: unknown, request: DomainReadRequest): DomainReadResponse {
  const invalid = () => { throw new DomainReadError(502, 'invalid_upstream_response'); };
  if (!object(value) || !exactKeys(value, ['version', 'operation', 'data'])
    || value.version !== 1 || value.operation !== request.operation) return invalid();
  const data = value.data;
  if (data === null && request.operation === 'membership.status.get') {
    return { version: 1, operation: request.operation, data: null };
  }
  const schema = domainReadDataSchemas[request.operation];
  if (!object(data) || !exactKeys(data, schema.required)
    || data.studentId !== request.studentId || data.sedeId !== request.sedeId) return invalid();
  for (const [key, rule] of Object.entries(schema.properties)) {
    const item = data[key];
    if ('enum' in rule && !(rule.enum as readonly unknown[]).includes(item)) return invalid();
    if ('type' in rule) {
      const types: readonly string[] = typeof rule.type === 'string' ? [rule.type] : rule.type;
      if (item === null) {
        if (!types.includes('null')) return invalid();
        continue;
      }
      if (types.includes('integer')) {
        if (!Number.isSafeInteger(item)) return invalid();
      } else if (!types.includes(typeof item)) return invalid();
    }
    if ('pattern' in rule && (typeof item !== 'string' || !uuid.test(item))) return invalid();
    if ('format' in rule && rule.format === 'date') {
      if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item)
        || Number.isNaN(Date.parse(item)) || new Date(item).toISOString().slice(0, 10) !== item) return invalid();
    }
  }
  return { version: 1, operation: request.operation, data: { ...data } };
}

export async function readDomainJson(message: Request | Response, maxBytes = 4096): Promise<unknown> {
  if (!message.body) throw new DomainReadError(400, 'invalid_json');
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new DomainReadError(413, 'payload_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof DomainReadError) throw error;
    throw new DomainReadError(400, 'invalid_json');
  } finally {
    reader.releaseLock();
  }
}
