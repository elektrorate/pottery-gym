import type { GiftCard, Student } from '../../types';
import { showError, showWarning } from '../toast';
import { supabase, withTimeout, normalizeForMatch, mapStudentRowToModel, mapGiftCardRowToModel, OpsContext } from './shared';

const resolveRecipientStudentId = (students: Student[], recipient?: string): string | null => {
    if (!recipient) return null;
    const normalized = normalizeForMatch(recipient);
    if (!normalized) return null;
    const fullMatches = students.filter(s => normalizeForMatch(`${s.name} ${s.surname || ''}`) === normalized);
    if (fullMatches.length === 1) return fullMatches[0].id;
    const nameMatches = students.filter(s => normalizeForMatch(s.name) === normalized);
    if (nameMatches.length === 1) return nameMatches[0].id;
    return null;
};

const localDateKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const createTemporaryStudent = async (ctx: OpsContext, params: {
    recipient: string; numClasses?: number; type?: GiftCard['type']; expiryDate?: string;
}): Promise<string | null> => {
    if (!ctx.sedeId) return null;
    const recipient = (params.recipient || '').replace(/\s+/g, ' ').trim();
    if (!recipient) return null;
    const firstName = recipient.split(' ')[0] || recipient;
    const surnameRaw = recipient.slice(firstName.length).trim();
    const payload: Record<string, any> = {
        sede_id: ctx.sedeId, full_name: recipient, name: firstName, surname: surnameRaw || null,
        phone: '', classes_remaining: Number.isFinite(params.numClasses as number) ? Math.max(0, params.numClasses as number) : 0,
        status: 'new', student_category: 'temporal',
        class_type: params.type === 'torno' ? 'Torno' : 'Modelado',
        expiry_date: params.expiryDate ? `${params.expiryDate}T00:00:00Z` : null,
        notes: 'Creado automaticamente desde bono regalo'
    };
    try {
        const { data, error } = await withTimeout('students.insert_from_gift_card',
            supabase.from('students').insert(payload).select('*').single(), 5000
        );
        if (error) return null;
        if (data) {
            const mapped = mapStudentRowToModel(data);
            ctx.setStudents(prev => prev.some(s => s.id === mapped.id) ? prev : [mapped, ...prev]);
            return data.id;
        }
    } catch { return null; }
    return null;
};

const ensureRecipientStudentId = async (ctx: OpsContext, params: {
    recipient?: string; recipientStudentId?: string; numClasses?: number; type?: GiftCard['type']; expiryDate?: string;
}): Promise<string | null> => {
    if (params.recipientStudentId) return params.recipientStudentId;
    const existing = resolveRecipientStudentId(ctx.students, params.recipient);
    if (existing) return existing;
    if (!params.recipient) return null;
    return createTemporaryStudent(ctx, { recipient: params.recipient, numClasses: params.numClasses, type: params.type, expiryDate: params.expiryDate });
};

export const addGiftCard = async (ctx: OpsContext, newCard: Omit<GiftCard, 'id' | 'createdAt'>) => {
    const resolvedId = await ensureRecipientStudentId(ctx, {
        recipient: newCard.recipient, recipientStudentId: newCard.recipientStudentId,
        numClasses: newCard.numClasses, type: newCard.type, expiryDate: newCard.expiryDate
    });
    const payload: any = {
        buyer: newCard.buyer, recipient: newCard.recipient, recipient_student_id: resolvedId,
        code: newCard.code || `CR-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
        buyer_phone: newCard.buyerPhone || null, buyer_email: newCard.buyerEmail || null,
        recipient_email: newCard.recipientEmail || null,
        num_classes: newCard.numClasses, type: newCard.type,
        scheduled_date: newCard.issuedDate || null, extra_commentary: newCard.extraCommentary || null,
        internal_notes: newCard.extraCommentary || null,
        activated_at: newCard.activatedAt || localDateKey(),
        price: newCard.price ?? null,
        payment_status: newCard.paymentStatus || 'pending',
        status: newCard.status || (newCard.paymentStatus === 'paid' ? 'active' : 'pending'),
        sessions_used: newCard.sessionsUsed || 0,
        delivery_format: newCard.deliveryFormat || 'digital',
        dedication: newCard.dedication || null
    };
    if (newCard.validityMonths !== undefined) payload.validity_months = newCard.validityMonths;
    if (newCard.expiryDate) payload.expiry_date = newCard.expiryDate;
    if (ctx.sedeId) payload.sede_id = ctx.sedeId;
    try {
        const { data, error } = await withTimeout('gift_cards.insert', supabase.from('gift_cards').insert(payload).select().single());
        if (error) { showError(`No se pudo crear la tarjeta regalo. ${error.message || ''}`); return; }
        if (data) {
            const mapped = mapGiftCardRowToModel(data);
            ctx.setGiftCards(prev => [mapped, ...prev]);
        }
        ctx.safeReload();
    } catch (err: any) {
        showError(`No se pudo crear la tarjeta regalo. ${err?.message || ''}`);
    }
};

export const updateGiftCard = async (ctx: OpsContext, id: string, updates: Partial<GiftCard>, giftCards: GiftCard[]) => {
    const previousCard = giftCards.find(gc => gc.id === id);
    const editableUpdates = { ...updates };
    delete editableUpdates.status;
    delete editableUpdates.sessionsUsed;
    delete editableUpdates.consumedAt;
    delete editableUpdates.paymentStatus;
    const payload: Record<string, any> = {};
    if (editableUpdates.buyer !== undefined) payload.buyer = editableUpdates.buyer;
    if (editableUpdates.recipient !== undefined) payload.recipient = editableUpdates.recipient;
    if (editableUpdates.buyerPhone !== undefined) payload.buyer_phone = editableUpdates.buyerPhone || null;
    if (editableUpdates.buyerEmail !== undefined) payload.buyer_email = editableUpdates.buyerEmail || null;
    if (editableUpdates.recipientEmail !== undefined) payload.recipient_email = editableUpdates.recipientEmail || null;
    if (editableUpdates.dedication !== undefined) payload.dedication = editableUpdates.dedication || null;
    if (editableUpdates.code !== undefined) payload.code = editableUpdates.code;
    let resolvedId: string | null | undefined = undefined;
    if (editableUpdates.recipientStudentId !== undefined || editableUpdates.recipient !== undefined) {
        resolvedId = await ensureRecipientStudentId(ctx, {
            recipient: editableUpdates.recipient ?? previousCard?.recipient, recipientStudentId: editableUpdates.recipientStudentId,
            numClasses: editableUpdates.numClasses ?? previousCard?.numClasses, type: editableUpdates.type ?? previousCard?.type,
            expiryDate: editableUpdates.expiryDate ?? previousCard?.expiryDate
        });
        payload.recipient_student_id = resolvedId;
    }
    if (editableUpdates.numClasses !== undefined) payload.num_classes = editableUpdates.numClasses;
    if (editableUpdates.type !== undefined) payload.type = editableUpdates.type;
    if ('validityMonths' in editableUpdates) payload.validity_months = editableUpdates.validityMonths ?? null;
    if ('activatedAt' in editableUpdates) payload.activated_at = editableUpdates.activatedAt || null;
    if (editableUpdates.price !== undefined) payload.price = editableUpdates.price ?? null;
    if (editableUpdates.deliveryFormat !== undefined) payload.delivery_format = editableUpdates.deliveryFormat;
    if ('issuedDate' in editableUpdates) payload.scheduled_date = editableUpdates.issuedDate || null;
    if ('expiryDate' in editableUpdates) payload.expiry_date = editableUpdates.expiryDate || null;
    if (editableUpdates.extraCommentary !== undefined) payload.extra_commentary = editableUpdates.extraCommentary || null;
    if (editableUpdates.extraCommentary !== undefined) payload.internal_notes = editableUpdates.extraCommentary || null;
    if (!Object.keys(payload).length) return;

    const optimistic: Partial<GiftCard> = { ...editableUpdates };
    if (resolvedId !== undefined) optimistic.recipientStudentId = resolvedId || undefined;
    ctx.setGiftCards(prev => prev.map(gc => gc.id === id ? { ...gc, ...optimistic } : gc));
    const revert = () => { if (previousCard) ctx.setGiftCards(prev => prev.map(gc => gc.id === id ? previousCard : gc)); };

    try {
        const { error } = await withTimeout('gift_cards.update', supabase.from('gift_cards').update(payload).eq('id', id), 5000);
        if (error) throw error;
        ctx.safeReload();
    } catch (err: any) {
        const isTimeout = typeof err?.message === 'string' && err.message.toLowerCase().includes('timeout');
        if (isTimeout) {
            void ctx.safeReload();
            showWarning('La actualización está tardando. Se ha recargado el estado para confirmar el resultado.');
            return;
        }
        revert();
        showError(`No se pudo actualizar la tarjeta regalo. ${err?.message || ''}`);
    }
};

const updateGiftCardFromRpc = (ctx: OpsContext, data: any) => {
    if (!data) return;
    const mapped = mapGiftCardRowToModel(data);
    ctx.setGiftCards(prev => prev.map(card => card.id === mapped.id ? mapped : card));
};

export const redeemGiftCardSession = async (ctx: OpsContext, giftCardId: string, sessionId: string, studentId?: string) => {
    try {
        const { data, error } = await withTimeout('gift_cards.redeem', supabase.rpc('redeem_gift_card_session', {
            p_gift_card_id: giftCardId, p_session_id: sessionId, p_student_id: studentId || null
        }));
        if (error) throw error;
        updateGiftCardFromRpc(ctx, data);
    } catch (err: any) {
        throw new Error(err?.message || 'No se pudo descontar la sesión del bono temporal.');
    }
};

export const reverseGiftCardSession = async (ctx: OpsContext, giftCardId: string, sessionId: string, studentId?: string) => {
    try {
        let resolvedGiftCardId = giftCardId;
        if (!resolvedGiftCardId && studentId) {
            const { data } = await withTimeout('gift_cards.resolve_session_link',
                supabase.from('session_students')
                    .select('gift_card_id')
                    .eq('session_id', sessionId)
                    .eq('student_id', studentId)
                    .maybeSingle()
            );
            resolvedGiftCardId = data?.gift_card_id || '';
        }
        if (!resolvedGiftCardId) return false;
        const { data, error } = await withTimeout('gift_cards.reverse', supabase.rpc('reverse_gift_card_session', {
            p_gift_card_id: resolvedGiftCardId, p_session_id: sessionId, p_student_id: studentId || null
        }));
        if (error) throw error;
        updateGiftCardFromRpc(ctx, data);
        return true;
    } catch (err: any) {
        throw new Error(err?.message || 'No se pudo devolver la sesión del bono temporal.');
    }
};

export const consumeGiftCard = async (ctx: OpsContext, giftCardId: string, consumedAt?: string) => {
    try {
        const { data, error } = await withTimeout('gift_cards.consume', supabase.rpc('consume_gift_card', {
            p_gift_card_id: giftCardId,
            p_consumed_at: consumedAt || localDateKey()
        }));
        if (error) throw error;
        updateGiftCardFromRpc(ctx, data);
    } catch (err: any) {
        throw new Error(err?.message || 'No se pudo archivar el bono como consumido.');
    }
};

export const cancelGiftCard = async (ctx: OpsContext, giftCardId: string) => {
    try {
        const { data, error } = await withTimeout('gift_cards.cancel', supabase.rpc('cancel_gift_card', {
            p_gift_card_id: giftCardId
        }));
        if (error) throw error;
        updateGiftCardFromRpc(ctx, data);
    } catch (err: any) {
        throw new Error(err?.message || 'No se pudo anular el bono temporal.');
    }
};

export const deleteGiftCard = async (ctx: OpsContext, id: string) => {
    ctx.setGiftCards(prev => prev.filter(gc => gc.id !== id));
    try {
        const { error } = await withTimeout('gift_cards.delete', supabase.from('gift_cards').delete().eq('id', id));
        if (error) { showError(`No se pudo eliminar la tarjeta regalo. ${error.message || ''}`); ctx.safeReload(); return; }
    } catch (err: any) {
        showError(`No se pudo eliminar la tarjeta regalo. ${err?.message || ''}`);
        ctx.safeReload();
    }
};
