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

const asDate = (value: unknown, field: string, required = false) => {
  const result = asText(value, field, required);
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${field} must use YYYY-MM-DD`);
  return result;
};

const asInteger = (value: unknown, field: string, min: number, max: number) => {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return result;
};

const getId = (payload: Record<string, unknown>) => asText(payload.id || payload.giftCardId, 'id');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return options();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req, 'write');
  if ('error' in auth) return auth.error;

  const body = await parseBody(req);
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  const action = asText(body.action, 'action');
  const payload = (body.data || body.payload || {}) as Record<string, unknown>;

  try {
    if (action === 'create') {
      const buyer = asText(payload.buyer, 'buyer');
      const recipient = asText(payload.recipient, 'recipient');
      const numClasses = asInteger(payload.numClasses, 'numClasses', 1, 100);
      const type = asText(payload.type || 'modelado', 'type');
      if (!['modelado', 'torno'].includes(type)) throw new Error('type must be modelado or torno');
      const paymentStatus = asText(payload.paymentStatus || 'pending', 'paymentStatus');
      if (!['pending', 'paid', 'refunded'].includes(paymentStatus)) throw new Error('Invalid paymentStatus');
      const validityMonths = payload.validityMonths === undefined ? undefined : asInteger(payload.validityMonths, 'validityMonths', 1, 24);
      const code = payload.code === undefined ? undefined : asText(payload.code, 'code');
      const metadata = payload.metadata === undefined ? {} : payload.metadata;
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new Error('metadata must be an object');

      const insertPayload: Record<string, unknown> = {
        sede_id: auth.sedeId,
        buyer,
        recipient,
        buyer_phone: asText(payload.buyerPhone, 'buyerPhone', false) || null,
        buyer_email: asText(payload.buyerEmail, 'buyerEmail', false) || null,
        recipient_email: asText(payload.recipientEmail, 'recipientEmail', false) || null,
        num_classes: numClasses,
        type,
        payment_status: paymentStatus,
        status: paymentStatus === 'paid' ? 'active' : 'pending',
        sessions_used: 0,
        delivery_format: asText(payload.deliveryFormat || 'digital', 'deliveryFormat'),
        dedication: asText(payload.dedication, 'dedication', false) || null,
        extra_commentary: asText(payload.extraCommentary, 'extraCommentary', false) || null,
        internal_notes: asText(payload.internalNotes, 'internalNotes', false) || null,
        external_reference: asText(payload.externalReference, 'externalReference', false) || null,
        external_metadata: metadata
      };
      if (code) insertPayload.code = code.toUpperCase();
      if (validityMonths !== undefined) insertPayload.validity_months = validityMonths;
      const activatedAt = asDate(payload.activatedAt, 'activatedAt', false);
      const expiryDate = asDate(payload.expiryDate, 'expiryDate', false);
      if (activatedAt) insertPayload.activated_at = activatedAt;
      if (expiryDate) insertPayload.expiry_date = expiryDate;
      if (payload.price !== undefined) insertPayload.price = Number(payload.price);

      const { data, error } = await auth.client.from('gift_cards').insert(insertPayload).select(giftCardSelect).single();
      if (error) return json({ error: error.code === '23505' ? 'Gift card code already exists' : error.message }, error.code === '23505' ? 409 : 400);
      return json({ data: publicGiftCard(data) }, 201);
    }

    if (action === 'update') {
      const id = getId(payload);
      const updatePayload: Record<string, unknown> = {};
      const fieldMap: Record<string, string> = {
        buyer: 'buyer', recipient: 'recipient', buyerPhone: 'buyer_phone', buyerEmail: 'buyer_email',
        recipientEmail: 'recipient_email', dedication: 'dedication', code: 'code', validityMonths: 'validity_months',
        activatedAt: 'activated_at', expiryDate: 'expiry_date', price: 'price', deliveryFormat: 'delivery_format',
        extraCommentary: 'extra_commentary', internalNotes: 'internal_notes', externalReference: 'external_reference',
        metadata: 'external_metadata'
      };
      for (const [input, column] of Object.entries(fieldMap)) {
        if (!(input in payload)) continue;
        if (input === 'metadata') {
          if (!payload[input] || typeof payload[input] !== 'object' || Array.isArray(payload[input])) throw new Error('metadata must be an object');
          updatePayload[column] = payload[input];
        } else if (input === 'validityMonths') {
          updatePayload[column] = asInteger(payload[input], input, 1, 24);
        } else if (input === 'activatedAt' || input === 'expiryDate') {
          updatePayload[column] = asDate(payload[input], input, false) || null;
        } else if (input === 'price') {
          updatePayload[column] = Number(payload[input]);
        } else {
          updatePayload[column] = asText(payload[input], input, false) || null;
          if (input === 'code' && updatePayload[column]) updatePayload[column] = String(updatePayload[column]).toUpperCase();
        }
      }
      if (payload.numClasses !== undefined) updatePayload.num_classes = asInteger(payload.numClasses, 'numClasses', 1, 100);
      if (payload.type !== undefined) {
        const type = asText(payload.type, 'type');
        if (!['modelado', 'torno'].includes(type)) throw new Error('type must be modelado or torno');
        updatePayload.type = type;
      }
      if (payload.recipient !== undefined) updatePayload.recipient_student_id = null;
      if (!Object.keys(updatePayload).length) throw new Error('No editable fields supplied');

      const { data, error } = await auth.client.from('gift_cards').update(updatePayload)
        .eq('id', id).eq('sede_id', auth.sedeId).select(giftCardSelect).single();
      if (error) return json({ error: error.code === 'PGRST116' ? 'Gift card not found' : error.message }, error.code === 'PGRST116' ? 404 : 400);
      return json({ data: publicGiftCard(data) });
    }

    const id = getId(payload);
    if (action === 'consume') {
      const { data, error } = await auth.client.rpc('external_consume_gift_card', {
        p_sede_id: auth.sedeId, p_gift_card_id: id, p_consumed_at: asDate(payload.consumedAt, 'consumedAt', false) || null
      });
      if (error) return json({ error: error.message }, errorStatus(error.message));
      return json({ data: publicGiftCard(data) });
    }
    if (action === 'cancel') {
      const { data, error } = await auth.client.rpc('external_cancel_gift_card', { p_sede_id: auth.sedeId, p_gift_card_id: id });
      if (error) return json({ error: error.message }, errorStatus(error.message));
      return json({ data: publicGiftCard(data) });
    }
    if (action === 'reverse' || action === 'redeem') {
      const sessionId = asText(payload.sessionId, 'sessionId');
      const studentId = asText(payload.studentId, 'studentId');
      const rpc = action === 'reverse' ? 'external_reverse_gift_card_session' : 'external_redeem_gift_card_session';
      const { data, error } = await auth.client.rpc(rpc, {
        p_sede_id: auth.sedeId, p_gift_card_id: id, p_session_id: sessionId, p_student_id: studentId
      });
      if (error) return json({ error: error.message }, errorStatus(error.message));
      return json({ data: publicGiftCard(data) });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid request' }, 400);
  }
});
