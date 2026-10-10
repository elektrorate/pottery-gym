import { MEMBERSHIP_PLANS, MembershipTier } from '../../types';
import type { Student } from '../../types';
import { getWorkshopDate } from '../../utils/studentLifecycle';
import { supabase, withTimeout, buildStudentPayload, isAbortError, OpsContext } from './shared';
import { showError, showWarning } from '../toast';

const isSchemaCacheColumnError = (error: { message?: string } | null | undefined) =>
    /schema cache/i.test(error?.message || '') && /column/i.test(error?.message || '');

const withoutExtendedStudentFields = (payload: Record<string, any>) => {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.membership_tier;
    delete fallbackPayload.membership_activated_at;
    delete fallbackPayload.archived_at;
    return fallbackPayload;
};

export const addStudent = async (ctx: OpsContext, newStudent: Omit<Student, 'id'>) => {
    if (ctx.operationLockRef.current) {
        showWarning('Hay otra operación en progreso. Espera un momento e intenta de nuevo.');
        return;
    }
    ctx.operationLockRef.current = true;
    let payload = buildStudentPayload(newStudent);
    if (ctx.sedeId) payload = { ...payload, sede_id: ctx.sedeId };
    try {
        let result = await withTimeout('students.insert', supabase.from('students').insert(payload).select().single());
        if (result.error && isSchemaCacheColumnError(result.error)) {
            console.warn('students.insert: retrying without extended membership fields while schema cache refreshes');
            result = await withTimeout('students.insert_fallback', supabase.from('students').insert(withoutExtendedStudentFields(payload)).select().single());
        }
        const { data, error } = result;
        if (error) { showError(`No se pudo crear el alumno. ${error.message || ''}`); return; }

        // IMMEDIATE UI update — don't wait for safeReload
        const newStudentWithId: Student = {
            ...newStudent,
            id: data.id,
            name: newStudent.name || data.name,
            surname: newStudent.surname || data.surname || undefined,
            phone: newStudent.phone || '',
            classesRemaining: newStudent.classesRemaining ?? data.classes_remaining ?? 0,
            status: newStudent.status || data.status || 'membresia',
            studentCategory: newStudent.studentCategory || data.student_category || 'membresia',
            bonosAsignados: newStudent.bonosAsignados ?? data.bonos_asignados ?? 4,
            repetirMensualmente: newStudent.repetirMensualmente ?? false,
        };
        ctx.setStudents(prev => [newStudentWithId, ...prev]);

        // Background reload — if it fails, UI already has the student
        ctx.safeReload();
    } catch (err: any) {
        if (isAbortError(err)) { console.warn('addStudent: request aborted, reloading...'); ctx.safeReload(); }
        else showError(`No se pudo crear el alumno. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
    } finally { ctx.operationLockRef.current = false; }
};

export const updateStudent = async (ctx: OpsContext, id: string, updates: Partial<Student>) => {
    if (ctx.operationLockRef.current) {
        showWarning('Hay otra operación en progreso. Espera un momento e intenta de nuevo.');
        return;
    }
    ctx.operationLockRef.current = true;

    // OPTIMISTIC: update UI immediately
    const previousStudents = [...ctx.students];
    ctx.setStudents(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

    const payload = buildStudentPayload(updates);
    try {
        let result = await withTimeout('students.update', supabase.from('students').update(payload).eq('id', id));
        if (result.error && isSchemaCacheColumnError(result.error)) {
            console.warn('students.update: retrying without extended membership fields while schema cache refreshes');
            result = await withTimeout('students.update_fallback', supabase.from('students').update(withoutExtendedStudentFields(payload)).eq('id', id));
        }
        const { error } = result;
        if (error) {
            // REVERT on error
            ctx.setStudents(previousStudents);
            showError(`No se pudo actualizar el alumno. ${error.message || ''}`);
            return;
        }
        ctx.safeReload();
    } catch (err: any) {
        if (isAbortError(err)) { console.warn('updateStudent: request aborted, reloading...'); ctx.safeReload(); }
        else {
            ctx.setStudents(previousStudents); // REVERT
            showError(`No se pudo actualizar el alumno. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`);
        }
    } finally { ctx.operationLockRef.current = false; }
};

export const deleteStudent = async (ctx: OpsContext, id: string) => {
    if (ctx.operationLockRef.current) {
        showWarning('Hay otra operación en progreso. Espera un momento e intenta de nuevo.');
        return;
    }
    ctx.operationLockRef.current = true;
    ctx.setStudents(prev => prev.filter(s => s.id !== id));
    // Also remove from sessions UI immediately
    const deletedStudent = ctx.students.find(st => st.id === id);
    if (deletedStudent) {
        const fullName = `${deletedStudent.name} ${deletedStudent.surname || ''}`.trim().toUpperCase();
        ctx.setSessions(prev => prev.map(s => ({
            ...s, students: (s.students || []).filter(name => name.toUpperCase() !== fullName)
        })));
    }
    try {
        // DB has ON DELETE CASCADE for all dependents
        const { error } = await withTimeout('students.delete', supabase.from('students').delete().eq('id', id));
        if (error) { showError(`No se pudo eliminar el alumno. ${error.message || ''}`); ctx.safeReload(); return; }
        console.log('deleteStudent: alumno eliminado correctamente');
    } catch (err: any) {
        if (isAbortError(err)) { console.warn('deleteStudent: request aborted — optimistic update active, verifying...'); }
        else { showError(`No se pudo eliminar el alumno. ${err?.message || 'Conexión lenta, intenta de nuevo.'}`); }
        ctx.safeReload();
    } finally { ctx.operationLockRef.current = false; }
};

export const renewStudent = async (ctx: OpsContext, id: string, numClasses: number = 4, membershipTier: MembershipTier = 'gold') => {
    const student = ctx.students.find(s => s.id === id);
    if (!student) { showError('Alumno no encontrado.'); return; }
    if (student.studentCategory === 'temporal') { showError('Los alumnos temporales no tienen membresía para renovar.'); return; }
    const plan = MEMBERSHIP_PLANS[membershipTier] || MEMBERSHIP_PLANS.gold;
    const renewedClasses = numClasses > 0 ? numClasses : plan.bonuses;
    const today = getWorkshopDate();
    const baseDate = student.expiryDate && student.expiryDate > today ? new Date(student.expiryDate) : new Date();
    baseDate.setMonth(baseDate.getMonth() + 1);
    const newExpiryDate = baseDate.toISOString().split('T')[0];
    await updateStudent(ctx, id, {
        classesRemaining: renewedClasses,
        bonosAsignados: plan.bonuses,
        membershipTier,
        price: plan.price,
        membershipActivatedAt: today,
        archivedAt: '',
        paymentStatus: 'paid',
        status: 'membresia',
        expiryDate: newExpiryDate
    });
};
