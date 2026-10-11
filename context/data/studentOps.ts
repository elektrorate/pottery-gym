import type { Student } from '../../types';
import { withStudentCreationDefaults, isManagedMembership, assertOrdinaryStudentUpdate } from '../../utils/studentLifecycle';
import { supabase, withTimeout, buildStudentPayload, mapStudentRowToModel, OpsContext } from './shared';

export const addStudent = async (ctx: OpsContext, input: Omit<Student, 'id'>) => {
    if (ctx.operationLockRef.current) throw new Error('Hay otra operación en progreso.');
    ctx.operationLockRef.current = true;
    try {
        const payload = buildStudentPayload(withStudentCreationDefaults(input));
        if (ctx.sedeId) payload.sede_id = ctx.sedeId;
        const { data, error } = await withTimeout('students.insert', supabase.from('students').insert(payload).select().single());
        if (error) throw error;
        if (!data) throw new Error('El servidor no devolvió el alumno creado.');
        if (isManagedMembership(input) && !data.current_membership_period_id) {
            throw new Error('El servidor no devolvió el período inicial. Verifica la versión del backend antes de reintentar.');
        }
        ctx.setStudents(previous => [mapStudentRowToModel(data), ...previous]);
        await ctx.safeReload();
    } finally { ctx.operationLockRef.current = false; }
};

export const updateStudent = async (ctx: OpsContext, id: string, updates: Partial<Student>) => {
    const student = ctx.students.find(item => item.id === id);
    if (!student) throw new Error('Alumno no encontrado.');
    assertOrdinaryStudentUpdate(student, updates);
    if (ctx.operationLockRef.current) throw new Error('Hay otra operación en progreso.');
    ctx.operationLockRef.current = true;
    try {
        const { error } = await withTimeout('students.update', supabase.from('students').update(buildStudentPayload(updates)).eq('id', id));
        if (error) throw error;
        await ctx.safeReload();
    } finally { ctx.operationLockRef.current = false; }
};

export const deleteStudent = async (ctx: OpsContext, id: string) => {
    const student = ctx.students.find(item => item.id === id);
    if (!student) throw new Error('Alumno no encontrado.');
    if (isManagedMembership(student)) throw new Error('La membresía conserva historial. Archiva el alumno en lugar de eliminarlo.');
    const { error } = await withTimeout('students.delete', supabase.from('students').delete().eq('id', id));
    if (error) throw error;
    await ctx.safeReload();
};
