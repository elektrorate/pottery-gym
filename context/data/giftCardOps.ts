import type { GiftCard } from '../../types';
import { showError } from '../toast';
import { supabase, withTimeout, mapGiftCardRowToModel, OpsContext } from './shared';

const rejectGiftCardValidation = (message: string): never => {
    showError(message);
    throw new Error(message);
};

export const addGiftCard = async (ctx: OpsContext, newCard: Omit<GiftCard, 'id' | 'createdAt'>) => {
    if (!ctx.sedeId || !newCard.recipientStudentId) {
        rejectGiftCardValidation('Selecciona la sede y el destinatario por su identidad. El nombre no identifica a una persona.');
    }
    if (newCard.sessionsUsed || newCard.consumedAt || (newCard.status && !['pending', 'active'].includes(newCard.status))) {
        rejectGiftCardValidation('Un bono nuevo no puede incluir historial de consumo.');
    }
    const payload: any = {
        buyer: newCard.buyer, recipient: newCard.recipient, recipient_student_id: newCard.recipientStudentId,
        code: newCard.code || `CR-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
        buyer_phone: newCard.buyerPhone || null, buyer_email: newCard.buyerEmail || null,
        recipient_email: newCard.recipientEmail || null,
        num_classes: newCard.numClasses, type: newCard.type,
        scheduled_date: newCard.issuedDate || null, extra_commentary: newCard.extraCommentary || null,
        internal_notes: newCard.extraCommentary || null,
        price: newCard.price ?? null,
        payment_status: newCard.paymentStatus || 'pending',
        delivery_format: newCard.deliveryFormat || 'digital',
        dedication: newCard.dedication || null
    };
    if (newCard.activatedAt) payload.activated_at = newCard.activatedAt;
    if (newCard.validityMonths !== undefined) payload.validity_months = newCard.validityMonths;
    if (ctx.sedeId) payload.sede_id = ctx.sedeId;
    try {
        const { data, error } = await withTimeout('gift_cards.insert', supabase.from('gift_cards').insert(payload).select().single());
        if (error) throw error;
        if (!data) throw new Error('El servidor no devolvio la tarjeta regalo creada.');
        const mapped = mapGiftCardRowToModel(data);
        ctx.setGiftCards(prev => [mapped, ...prev]);
        await ctx.safeReload();
    } catch (err: any) {
        showError(`No se pudo crear la tarjeta regalo. ${err?.message || ''}`);
        throw err;
    }
};

export const updateGiftCard = async (ctx: OpsContext, id: string, updates: Partial<GiftCard>, giftCards: GiftCard[]) => {
    if (!id) rejectGiftCardValidation('Se requiere la identidad del bono para actualizarlo.');
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
    if ('recipientStudentId' in editableUpdates) {
        if (!editableUpdates.recipientStudentId) {
            rejectGiftCardValidation('El destinatario requiere una identidad explicita; no se puede desvincular por nombre.');
        }
        payload.recipient_student_id = editableUpdates.recipientStudentId;
    } else if (editableUpdates.recipient !== undefined && !previousCard?.recipientStudentId) {
        rejectGiftCardValidation('Selecciona el destinatario por su identidad antes de cambiar un bono antiguo sin vinculo.');
    }
    if (editableUpdates.numClasses !== undefined) payload.num_classes = editableUpdates.numClasses;
    if (editableUpdates.type !== undefined) payload.type = editableUpdates.type;
    if ('validityMonths' in editableUpdates) payload.validity_months = editableUpdates.validityMonths ?? null;
    if ('activatedAt' in editableUpdates) payload.activated_at = editableUpdates.activatedAt || null;
    if (editableUpdates.price !== undefined) payload.price = editableUpdates.price ?? null;
    if (editableUpdates.deliveryFormat !== undefined) payload.delivery_format = editableUpdates.deliveryFormat;
    if ('issuedDate' in editableUpdates) payload.scheduled_date = editableUpdates.issuedDate || null;
    if ('expiryDate' in editableUpdates && !('activatedAt' in editableUpdates) && !('validityMonths' in editableUpdates)
        && editableUpdates.expiryDate !== previousCard?.expiryDate) {
        rejectGiftCardValidation('La caducidad se calcula en el servidor desde la activacion y la vigencia.');
    }
    if (editableUpdates.extraCommentary !== undefined) payload.extra_commentary = editableUpdates.extraCommentary || null;
    if (editableUpdates.extraCommentary !== undefined) payload.internal_notes = editableUpdates.extraCommentary || null;
    if (!Object.keys(payload).length) rejectGiftCardValidation('No hay campos editables para actualizar el bono.');

    try {
        const { data, error } = await withTimeout('gift_cards.update', supabase.from('gift_cards').update(payload).eq('id', id).select().single(), 5000);
        if (error) throw error;
        if (!data) throw new Error('El servidor no devolvio la tarjeta regalo actualizada.');
        updateGiftCardFromRpc(ctx, data);
        await ctx.safeReload();
    } catch (err: any) {
        showError(`No se pudo actualizar la tarjeta regalo. ${err?.message || ''}`);
        throw err;
    }
};

const updateGiftCardFromRpc = (ctx: OpsContext, data: any) => {
    if (!data) return;
    const mapped = mapGiftCardRowToModel(data);
    ctx.setGiftCards(prev => prev.map(card => card.id === mapped.id ? mapped : card));
};

// Pre-rollout standalone session wrappers: revoked by atomic attendance and
// unused by the UI. Attendance changes must use the atomic session operations.
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
            const { data, error } = await withTimeout('gift_cards.resolve_session_link',
                supabase.from('session_students')
                    .select('gift_card_id')
                    .eq('session_id', sessionId)
                    .eq('student_id', studentId)
                    .maybeSingle()
            );
            if (error) throw error;
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
            p_consumed_at: consumedAt || null
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
    await cancelGiftCard(ctx, id);
};

// These standalone keyed session wrappers are also pre-rollout, not UI writers.
export interface GiftCardSessionIntent {
    readonly giftCardId: string;
    readonly sessionId: string;
    readonly studentId: string;
    readonly reverse: boolean;
    readonly requestKey: string;
}

// Retain this exact intent across uncertain responses. A new correction gets a
// new key; replaying an old receipt must not resurrect a reversed consumption.
export const createGiftCardSessionIntent = (giftCardId: string, sessionId: string, studentId: string, reverse = false): GiftCardSessionIntent => {
    if (!giftCardId || !sessionId || !studentId) throw new Error('Se requieren las identidades del bono, sesion y alumno.');
    return Object.freeze({ giftCardId, sessionId, studentId, reverse, requestKey: crypto.randomUUID() });
};

export const applyGiftCardSessionIntent = async (ctx: OpsContext, intent: GiftCardSessionIntent): Promise<GiftCard> => {
    const { data, error } = await withTimeout('gift_cards.session_once', supabase.rpc(
        intent.reverse ? 'reverse_gift_card_session_once' : 'redeem_gift_card_session_once', {
            p_gift_card_id: intent.giftCardId, p_session_id: intent.sessionId,
            p_student_id: intent.studentId, p_request_key: intent.requestKey
        }
    ));
    if (error) throw error;
    if (!data) throw new Error('El servidor no devolvio un recibo del bono.');
    // A stable historical receipt is not today's projection.
    await ctx.safeReload();
    return mapGiftCardRowToModel(data);
};
