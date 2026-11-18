import type { InventoryItem, InventoryMovement } from '../../types';
import { showError, showWarning } from '../toast';
import { supabase, withTimeout, removeUndefined, isAbortError, OpsContext } from './shared';

export const addInventoryItem = async (ctx: OpsContext, item: InventoryItem) => {
    ctx.assertScope();
    const payload: any = removeUndefined({
        name: item.name, category: item.category, code: item.code || undefined,
        current_quantity: item.current_quantity ?? 0, unit: item.unit || 'units',
        min_quantity: item.min_quantity ?? 0, status: item.status || 'active',
        location: item.location || undefined, supplier_code: item.supplier_code || undefined,
        color: item.color || undefined,
        color_family: item.color_family || undefined, finish: item.finish || undefined,
        notes: item.notes || undefined,
    });
    if (ctx.sedeId) payload.sede_id = ctx.sedeId;
    try {
        const { error } = await withTimeout('inventory_items.insert', supabase.from('inventory_items').insert(payload));
        ctx.assertScope();
        if (error) throw error;
        void ctx.safeReload().catch(() => undefined);
    } catch (err: any) {
        throw new Error(`No se pudo crear el material. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
    }
};

export const updateInventoryItem = async (ctx: OpsContext, id: string, updates: Partial<InventoryItem>) => {
    ctx.assertScope();
    const payload: Record<string, any> = {};
    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.category !== undefined) payload.category = updates.category;
    if (updates.code !== undefined) payload.code = updates.code || null;
    if (updates.current_quantity !== undefined) payload.current_quantity = updates.current_quantity;
    if (updates.unit !== undefined) payload.unit = updates.unit;
    if (updates.min_quantity !== undefined) payload.min_quantity = updates.min_quantity;
    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.location !== undefined) payload.location = updates.location || null;
    if (updates.supplier_code !== undefined) payload.supplier_code = updates.supplier_code || null;
    if (updates.color !== undefined) payload.color = updates.color || null;
    if (updates.color_family !== undefined) payload.color_family = updates.color_family || null;
    if (updates.finish !== undefined) payload.finish = updates.finish || null;
    if (updates.notes !== undefined) payload.notes = updates.notes || null;
    try {
        const { error } = await withTimeout('inventory_items.update', supabase.from('inventory_items').update(payload).eq('id', id));
        ctx.assertScope();
        if (error) throw error;
        ctx.setInventoryItems(prev => prev.map(i => i.id === id ? { ...i, ...updates } : i));
        void ctx.safeReload().catch(() => undefined);
    } catch (err: any) {
        throw new Error(`No se pudo actualizar el material. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
    }
};

export const archiveInventoryItem = async (ctx: OpsContext, id: string) => {
    ctx.assertScope();
    try {
        const { error } = await withTimeout('inventory_items.archive',
            supabase.from('inventory_items').update({ status: 'archived' }).eq('id', id));
        ctx.assertScope();
        if (error) { showError(`No se pudo archivar el item. ${error.message || ''}`); return; }
        ctx.setInventoryItems(prev => prev.map(i => i.id === id ? { ...i, status: 'archived' as const } : i));
    } catch (err: any) {
        showError(`No se pudo archivar el item. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
    }
};

export const deleteInventoryItem = async (ctx: OpsContext, id: string) => {
    ctx.assertScope();
    ctx.setInventoryItems(prev => prev.filter(i => i.id !== id));
    try {
        const { error } = await withTimeout('inventory_items.delete', supabase.from('inventory_items').delete().eq('id', id));
        ctx.assertScope();
        if (error) { showError(`No se pudo eliminar el item. ${error.message || ''}`); void ctx.safeReload().catch(() => undefined); return; }
    } catch (err: any) {
        showError(`No se pudo eliminar el item. ${err?.message || ''}`);
        ctx.assertScope();
        void ctx.safeReload().catch(() => undefined);
    }
};

export const addInventoryMovement = async (ctx: OpsContext, movement: Omit<InventoryMovement, 'id'>) => {
    ctx.assertScope();
    if (!movement.requestKey || !Number.isFinite(movement.expectedQuantity)) throw new Error('Recarga el material antes de registrar el movimiento.');
    const { data, error } = await withTimeout('inventory.record_movement', supabase.rpc('record_inventory_movement', {
        p_request_id: movement.requestKey, p_item_id: movement.item_id, p_type: movement.type,
        p_quantity: movement.type === 'adjust' ? null : movement.quantity,
        p_new_quantity: movement.type === 'adjust' ? movement.new_quantity : null,
        p_unit: movement.unit, p_reason: movement.reason, p_date: movement.date,
        p_notes: movement.notes || null, p_expected_quantity: movement.expectedQuantity
    }));
    ctx.assertScope();
    if (error) {
        if (error.code === '40001') void ctx.safeReload().catch(() => undefined);
        throw error;
    }
    if (!data || data.id !== movement.requestKey || data.item_id !== movement.item_id || !Number.isFinite(Number(data.new_quantity))) {
        throw new Error('No se pudo confirmar el movimiento. Reintenta los mismos datos.');
    }
    ctx.setInventoryItems(prev => prev.map(item => item.id === data.item_id ? { ...item, current_quantity: Number(data.new_quantity) } : item));
    ctx.setInventoryMovements(prev => [data, ...prev.filter(row => row.id !== data.id)]);
    void ctx.safeReload().catch(() => undefined);
};
