import {
  authenticate,
  giftCardSelect,
  json,
  options,
  publicGiftCard
} from '../_shared/gift-card-api.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return options();
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req, 'read');
  if ('error' in auth) return auth.error;

  const url = new URL(req.url);
  const code = url.searchParams.get('code')?.trim().toUpperCase();
  const id = url.searchParams.get('id')?.trim();
  const includeMovements = url.searchParams.get('include_movements') === 'true';
  const parsedLimit = Number(url.searchParams.get('limit') || '100');
  const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 100;

  let query = auth.client
    .from('gift_cards')
    .select(giftCardSelect)
    .eq('sede_id', auth.sedeId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (code) query = query.eq('code', code);
  if (id) query = query.eq('id', id);

  const { data, error } = await query;
  if (error) return json({ error: 'Could not read gift cards' }, 500);
  if ((code || id) && !data?.length) return json({ error: 'Gift card not found' }, 404);

  const rows = data || [];
  let movementsByCard: Record<string, Record<string, any>[]> = {};
  if (includeMovements && rows.length) {
    const { data: movementRows, error: movementError } = await auth.client
      .from('gift_card_movements')
      .select('id, gift_card_id, session_id, student_id, movement_type, sessions_delta, note, created_at')
      .eq('sede_id', auth.sedeId)
      .in('gift_card_id', rows.map((row) => row.id))
      .order('created_at', { ascending: false });
    if (movementError) return json({ error: 'Could not read gift card movements' }, 500);
    movementsByCard = (movementRows || []).reduce<Record<string, Record<string, any>[]>>((groups, row) => {
      (groups[row.gift_card_id] ||= []).push({
        id: row.id,
        sessionId: row.session_id,
        studentId: row.student_id,
        type: row.movement_type,
        sessionsDelta: row.sessions_delta,
        note: row.note,
        createdAt: row.created_at
      });
      return groups;
    }, {});
  }

  const giftCards = rows.map((row) => publicGiftCard(row, includeMovements ? movementsByCard[row.id] || [] : undefined));
  return json({ data: code || id ? giftCards[0] : giftCards, count: giftCards.length });
});
