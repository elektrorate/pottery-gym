import type { Teacher } from '../../types';
import { showError, showWarning } from '../toast';
import { supabase, withTimeout, isAbortError, OpsContext } from './shared';

export const addTeacher = async (ctx: OpsContext, newTeacher: Omit<Teacher, 'id'>) => {
    ctx.assertScope();
    const payload: any = {
        name: newTeacher.name, surname: newTeacher.surname || null,
        specialty: newTeacher.specialty || null, email: newTeacher.email || null,
        phone: newTeacher.phone || null, notes: newTeacher.notes || null
    };
    if (ctx.sedeId) payload.sede_id = ctx.sedeId;
    try {
        const { error } = await withTimeout('teachers.insert', supabase.from('teachers').insert(payload));
        ctx.assertScope();
        if (error) { showError(`No se pudo crear el profesor. ${error.message || ''}`); return; }
        ctx.safeReload();
    } catch (err: any) {
        showError(`No se pudo crear el profesor. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
    }
};

export const updateTeacher = async (ctx: OpsContext, id: string, updates: Partial<Teacher>) => {
    ctx.assertScope();
    const payload: Record<string, any> = {
        name: updates.name, surname: updates.surname || null,
        specialty: updates.specialty || null, email: updates.email || null,
        phone: updates.phone || null, notes: updates.notes || null
    };
    if (!payload.name) { console.error('updateTeacher: name is required'); return; }
    try {
        const { error } = await withTimeout('teachers.update', supabase.from('teachers').update(payload).eq('id', id));
        ctx.assertScope();
        if (error) { showError(`No se pudo actualizar el profesor. ${error.message || ''}`); return; }
        ctx.setTeachers(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
        ctx.safeReload();
    } catch (err: any) {
        showError(`No se pudo actualizar el profesor. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
    }
};

export const deleteTeacher = async (ctx: OpsContext, id: string) => {
    ctx.assertScope();
    ctx.setTeachers(prev => prev.filter(t => t.id !== id));
    try {
        const teacherReset = supabase.from('sessions').update({ teacher_id: null }).eq('teacher_id', id);
        ctx.assertScope();
        const substituteReset = supabase.from('sessions').update({ teacher_substitute_id: null }).eq('teacher_substitute_id', id);
        await Promise.allSettled([teacherReset, substituteReset]);
        ctx.assertScope();
        const { error } = await withTimeout('teachers.delete', supabase.from('teachers').delete().eq('id', id));
        ctx.assertScope();
        if (error) { showError(`No se pudo eliminar el profesor. ${error.message || ''}`); ctx.safeReload(); return; }
    } catch (err: any) {
        showError(`${err.message || 'Error inesperado al eliminar profesor.'}`);
        ctx.assertScope();
        ctx.safeReload();
    }
};
