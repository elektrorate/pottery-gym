import {
  authenticate,
  giftCardSelect,
  errorStatus,
  json,
  options,
  parseBody,
  publicGiftCard
} from '../_shared/gift-card-api.ts';

const asText = (value: unknown, field: string, required = true) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required`);
  return result || undefined;
};

const asId = (value: unknown, field: string) => {
  const result = asText(value, field)!;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new Error(`${field} must be a UUID`);
  return result;
};

const asDate = (value: unknown, field: string) => {
  const result = asText(value, field, false);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
  return result;
};

const asNumber = (value: unknown, field: string) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !String(value).trim()) throw new Error(`${field} must be a non-negative number`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${field} must be a non-negative number`);
  return result;
};

const asInteger = (value: unknown, field: string, min: number, max: number) => {
  const result = asNumber(value, field);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return result;
};

const asChoice = (value: unknown, field: string, choices: readonly string[]) => {
  const result = asText(value, field)!;
  if (!choices.includes(result)) throw new Error(`Invalid ${field}`);
  return result;
};

const getId = (payload: Record<string, unknown>) => {
  if (payload.id !== undefined && payload.giftCardId !== undefined && payload.id !== payload.giftCardId) throw new Error('Conflicting gift card identities');
  return asId(payload.id ?? payload.giftCardId, 'id');
};

const fieldMap: Record<string, string> = {
  buyer: 'buyer', recipient: 'recipient', recipientStudentId: 'recipient_student_id', buyerPhone: 'buyer_phone', buyerEmail: 'buyer_email',
  recipientEmail: 'recipient_email', dedication: 'dedication', code: 'code', validityMonths: 'validity_months',
  activatedAt: 'activated_at', price: 'price', deliveryFormat: 'delivery_format', numClasses: 'num_classes', type: 'type',
  extraCommentary: 'extra_commentary', internalNotes: 'internal_notes', externalReference: 'external_reference', metadata: 'external_metadata'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return options();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  // Approval of the external-write permission matrix is still pending.
  if (Deno.env.get('BONOS_WRITES_ENABLED') !== 'true') return json({ error: 'External gift card writes are disabled' }, 403);

  try {
    const auth = await authenticate(req, 'write');
    if ('error' in auth) return auth.error;
    const body = await parseBody(req);
    if (!body) throw new Error('Invalid JSON body');
    const action = asChoice(body.action, 'action', ['create', 'update', 'consume', 'cancel', 'redeem', 'reverse']);
    // Standalone debits/refunds can desynchronize attendance; their RPCs are revoked.
    if (action === 'redeem' || action === 'reverse') {
      return json({ error: 'Standalone gift card redeem/reverse is disabled. Use the revision-aware atomic session flow.' }, 403);
    }
    const payload = body.data ?? body.payload ?? {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('data must be an object');
    const input = payload as Record<string, unknown>;
    const allowed = action === 'create' ? Object.keys(fieldMap).concat('paymentStatus')
      : action === 'update' ? Object.keys(fieldMap).concat('id', 'giftCardId')
      : ['id', 'giftCardId', ...(action === 'consume' ? ['consumedAt'] : [])];
    for (const field of Object.keys(input)) {
      if (!allowed.includes(field)) throw new Error(`Field ${field} is not editable for ${action}; payment, expiry and balance are server-managed`);
    }

    const { data: sede, error: sedeError } = await auth.client.from('sedes').select('id').eq('id', auth.sedeId).eq('is_active', true).maybeSingle();
    if (sedeError || !sede) return json({ error: 'API sede is unavailable' }, 403);

    if (action === 'create' || action === 'update') {
      const writePayload: Record<string, unknown> = {};
      for (const [field, column] of Object.entries(fieldMap)) {
        if (!(field in input)) continue;
        if (field === 'metadata') {
          if (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field])) throw new Error('metadata must be an object');
          writePayload[column] = input[field];
        } else if (field === 'recipientStudentId') {
          writePayload[column] = asId(input[field], field);
        } else if (field === 'validityMonths') {
          const months = asInteger(input[field], field, 3, 8);
          if (![3, 6, 8].includes(months)) throw new Error('validityMonths must be 3, 6 or 8');
          writePayload[column] = months;
        } else if (field === 'numClasses') {
          writePayload[column] = asInteger(input[field], field, 1, 100);
        } else if (field === 'activatedAt') {
          writePayload[column] = asDate(input[field], field) || null;
        } else if (field === 'price') {
          writePayload[column] = input[field] === null ? null : asNumber(input[field], field);
        } else if (field === 'type' || field === 'deliveryFormat') {
          writePayload[column] = asChoice(input[field], field, field === 'type' ? ['modelado', 'torno'] : ['digital', 'physical']);
        } else {
          writePayload[column] = asText(input[field], field, ['buyer', 'recipient', 'code'].includes(field)) || null;
          if (field === 'code') writePayload[column] = String(writePayload[column]).toUpperCase();
        }
      }

      let id: string | undefined;
      let recipientId = writePayload.recipient_student_id;
      if (action === 'create') {
        writePayload.sede_id = auth.sedeId;
        writePayload.buyer = asText(input.buyer, 'buyer');
        writePayload.recipient = asText(input.recipient, 'recipient');
        recipientId = writePayload.recipient_student_id = asId(input.recipientStudentId, 'recipientStudentId');
        writePayload.num_classes = asInteger(input.numClasses, 'numClasses', 1, 100);
        writePayload.type = asChoice(input.type ?? 'modelado', 'type', ['modelado', 'torno']);
        writePayload.payment_status = asChoice(input.paymentStatus ?? 'pending', 'paymentStatus', ['pending', 'paid']);
        writePayload.delivery_format ??= 'digital';
      } else {
        id = getId(input);
        if (!Object.keys(writePayload).length) throw new Error('No editable fields supplied');
        const { data: card, error } = await auth.client.from('gift_cards').select('id,recipient_student_id')
          .eq('id', id).eq('sede_id', auth.sedeId).maybeSingle();
        if (error) return json({ error: error.message }, 400);
        if (!card) return json({ error: 'Gift card not found' }, 404);
        if ('recipient' in input) recipientId ??= card.recipient_student_id;
        if ('recipient' in input && !recipientId) throw new Error('Explicit recipientStudentId required before editing a legacy recipient');
        // Display edits never clear or infer the existing recipient identity.
      }
      if (recipientId) {
        const { data: student, error } = await auth.client.from('students').select('id')
          .eq('id', recipientId).eq('sede_id', auth.sedeId).maybeSingle();
        if (error) return json({ error: error.message }, 400);
        if (!student) return json({ error: 'Recipient must belong to the API sede' }, 403);
      }

      const query = action === 'create' ? auth.client.from('gift_cards').insert(writePayload)
        : auth.client.from('gift_cards').update(writePayload).eq('id', id!).eq('sede_id', auth.sedeId);
      const { data, error } = await query.select(giftCardSelect).single();
      if (error) return json({ error: error.message }, error.code === '23505' ? 409 : error.code === 'PGRST116' ? 404 : 400);
      return json({ data: publicGiftCard(data) }, action === 'create' ? 201 : 200);
    }

    const id = getId(input);
    // Manual lifecycle RPCs retain their existing authorization and state-idempotence.
    const { data, error } = await auth.client.rpc(action === 'consume' ? 'external_consume_gift_card' : 'external_cancel_gift_card', {
      p_sede_id: auth.sedeId, p_gift_card_id: id,
      ...(action === 'consume' ? { p_consumed_at: asDate(input.consumedAt, 'consumedAt') || null } : {})
    });
    if (error) return json({ error: error.message }, errorStatus(error.message));
    return json({ data: publicGiftCard(data) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid request' }, 400);
  }
});
