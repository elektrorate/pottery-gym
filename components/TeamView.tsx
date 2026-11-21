import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { ConfirmModal } from './shared/ConfirmModal';
import { DangerZone } from './shared/DangerZone';
import { EmptyState } from './shared/EmptyState';
import { pluralize } from '../utils/pluralize';
import { supabase } from '../supabaseClient';
import { formatDate } from '../utils/dateFormat';

interface StaffMember {
    id: string;
    memberId: string;
    email: string;
    name: string;
    role: string;
    joinedAt: string;
    createdAt: string;
}

const TeamView: React.FC = () => {
    const { session } = useAuth();
    const [staff, setStaff] = useState<StaffMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [staffToDelete, setStaffToDelete] = useState<{ id: string, name: string } | null>(null);

    const [createForm, setCreateForm] = useState({ nombre: '', email: '', password: '' });
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_PROJECT_URL || '';
    const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

    const callManageStaff = useCallback(async (body: Record<string, any>) => {
        const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession();
        const token = currentSession?.access_token;
        if (sessionError || !token) {
            throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
        }

        const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-staff`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'apikey': SUPABASE_ANON_KEY,
            },
            body: JSON.stringify(body),
        });

        const responseData = await res.json().catch(() => null);
        if (!res.ok) {
            if (res.status === 401) {
                throw new Error('Sesión no válida. Vuelve a iniciar sesión.');
            }
            throw new Error(responseData?.error || 'No se pudo completar la operación. Inténtelo de nuevo.');
        }

        if (responseData?.error) {
            throw new Error(responseData.error);
        }

        return responseData;
    }, [SUPABASE_URL, SUPABASE_ANON_KEY]);

    const loadStaff = useCallback(async () => {
        try {
            setLoading(true);
            const data = await callManageStaff({ action: 'list' });
            if (data.success) {
                setStaff(data.staff || []);
            } else {
                console.error('List error:', data.error);
            }
        } catch (err) {
            console.error('Failed to load staff:', err);
        } finally {
            setLoading(false);
        }
    }, [callManageStaff]);

    useEffect(() => { loadStaff(); }, [loadStaff]);

    const showFeedback = (type: 'success' | 'error', message: string) => {
        setFeedback({ type, message });
        setTimeout(() => setFeedback(null), 4000);
    };

    const handleCreateStaff = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!createForm.nombre.trim() || !createForm.email.trim() || !createForm.password.trim()) {
            showFeedback('error', 'Todos los campos son obligatorios.');
            return;
        }
        if (createForm.password.length < 12) {
            showFeedback('error', 'La contraseña debe tener al menos 12 caracteres.');
            return;
        }

        setActionLoading(true);

        try {
            const data = await callManageStaff({ action: 'create', ...createForm });

            if (data.success) {
                // Close modal immediately for better UX
                setShowCreateModal(false);
                setCreateForm({ nombre: '', email: '', password: '' });
                setActionLoading(false);

                showFeedback('success', data.message || 'Colaborador creado exitosamente.');

                // Add the new staff to the list optimistically
                if (data.staff) {
                    setStaff(prev => [...prev, {
                        id: data.staff.id,
                        memberId: '',
                        email: data.staff.email,
                        name: data.staff.name,
                        role: 'staff',
                        joinedAt: new Date().toISOString(),
                        createdAt: new Date().toISOString()
                    }]);
                } else {
                    // If no staff data returned, reload the list
                    await loadStaff();
                }
            } else {
                setActionLoading(false);
                showFeedback('error', data.error || 'Error al crear colaborador.');
            }
        } catch (err: any) {
            setActionLoading(false);
            showFeedback('error', err.message || 'Error de conexión.');
        }
    };

    const executeStaffDeletion = async (staffUserId: string) => {
        // Optimistic UI: close modal and remove from list immediately
        setStaffToDelete(null);
        setStaff(prev => prev.filter(s => s.id !== staffUserId));

        try {
            const data = await callManageStaff({ action: 'delete', staffUserId });
            if (data.success) {
                showFeedback('success', data.message || 'Colaborador eliminado.');
            } else {
                // Revert on error - reload the list
                showFeedback('error', data.error || 'Error al eliminar.');
                await loadStaff();
            }
        } catch (err: any) {
            showFeedback('error', err.message || 'Error de conexión.');
            // Revert on error - reload the list
            await loadStaff();
        }
    };

    const handleDeleteStaff = (staffUserId: string, staffName: string) => {
        setStaffToDelete({ id: staffUserId, name: staffName });
    };



    const formatJoinedDate = (dateStr: string) => formatDate(dateStr, 'numeric', '—');

    const currentUserEmail = session?.user?.email || '';

    return (
        <div className="h-full flex flex-col overflow-hidden bg-neutral-base">
            <div className="flex-1 overflow-y-auto custom-scrollbar px-4 md:px-12 pt-6 pb-32">

                {/* Feedback toast */}
                {feedback && (
                    <div className={`fixed top-6 right-6 z-[200] px-5 py-3.5 rounded-2xl shadow-xl text-[13px] font-semibold animate-fade-in ${feedback.type === 'success' ? 'bg-[#20663B] text-white' : 'bg-[#9E3B2B] text-white'}`}>
                        {feedback.message}
                    </div>
                )}

                {/* Header */}
                <header className="mb-6 animate-fade-in text-center md:text-left">
                    <p className="eyebrow mb-3">Gestión de equipo</p>
                    <h1 className="ui-page-title text-neutral-textMain">
                        Equipo de <span className="text-brand">Trabajo</span>
                    </h1>
                    <p className="ui-secondary mt-2 max-w-xl mx-auto md:mx-0">
                        Gestiona los colaboradores de tu taller. Ellos tendrán acceso similar al tuyo, pero no podrán crear otros colaboradores.
                    </p>
                </header>

                {/* Actions bar */}
                <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
                    <div className="flex gap-3 w-full md:w-auto">
                        <button
                            onClick={() => setShowCreateModal(true)}
                            className="flex-1 md:flex-none min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] text-[14px] font-semibold inline-flex items-center justify-center gap-2 hover:bg-brand-hover active:scale-95 transition-all"
                        >
                            + Nuevo colaborador
                        </button>

                    </div>
                    <div className="text-[14px] font-semibold text-neutral-textSec">
                        {pluralize(staff.length, 'colaborador registrado', 'colaboradores registrados')}
                    </div>
                </div>

                {/* Staff list */}
                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="w-8 h-8 border-[3px] border-brand border-t-transparent rounded-full animate-spin"></div>
                    </div>
                ) : staff.length === 0 ? (
                    <EmptyState title="Todavía no hay colaboradores" body="Añade a quien te ayuda en el taller. Tendrá acceso parecido al tuyo, sin poder crear más cuentas." actionLabel="Añadir el primer colaborador" onAction={() => setShowCreateModal(true)} />
                ) : (
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                        {staff.map((member) => {
                            const isMe = member.email === currentUserEmail;
                            return (
                                <div
                                    key={member.id}
                                    className="p-4 md:p-6 bg-white rounded-2xl border border-neutral-border hover:border-arena transition-all flex flex-col h-full animate-fade-in"
                                >
                                    <div className="flex items-center gap-3 mb-5">
                                        <div className="w-12 h-12 rounded-xl bg-brand flex items-center justify-center text-white font-bold text-[18px] shrink-0">
                                            {member.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="overflow-hidden">
                        <h4 className="ui-card-title text-neutral-textMain truncate">
                                                {member.name}
                                                {isMe && <span className="text-[13px] ml-2 text-brand font-semibold">(tú)</span>}
                                            </h4>
                                            <p className="text-[13px] text-neutral-textSec truncate mt-0.5">{member.email}</p>
                                        </div>
                                    </div>

                                    <div className="space-y-3 flex-1">
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-[12px] font-semibold text-neutral-textSec">Rol</span>
                                            <span className={`px-3 py-1 rounded-lg text-[12px] font-semibold border ${member.role === 'tallerista' ? 'bg-brand-soft text-brand border-arena' : 'bg-neutral-sec text-neutral-textSec border-neutral-border'}`}>
                                                {member.role === 'tallerista' ? 'Tallerista' : 'Staff'}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-[12px] font-semibold text-neutral-textSec">Ingreso</span>
                                            <span className="text-[13px] font-semibold text-neutral-textMain">{formatJoinedDate(member.joinedAt)}</span>
                                        </div>
                                    </div>

                                    {!isMe && (
                                        <DangerZone
                                          description={`Quitar a ${member.name} del equipo cierra su acceso. No se puede deshacer desde aquí.`}
                                          actionLabel="Eliminar del equipo"
                                          disabled={actionLoading}
                                          onAction={() => handleDeleteStaff(member.id, member.name)}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── CREATE STAFF MODAL ─── */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-neutral-textMain/40 backdrop-blur-md z-[100] flex items-center justify-center p-4">
                    <div className="bg-white w-full max-w-lg rounded-2xl soft-shadow relative animate-fade-in border border-neutral-border overflow-hidden">
                        <button onClick={() => setShowCreateModal(false)} className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-neutral-textHelper hover:text-brand transition-colors z-20">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                        <div className="p-4 md:p-6">
                            <h3 className="text-[24px] font-bold text-neutral-textMain leading-none mb-2">Nuevo colaborador</h3>
                            <p className="text-neutral-textSec text-[14px] mb-5">Agrega un miembro a tu equipo de trabajo.</p>

                            <form onSubmit={handleCreateStaff} className="space-y-4">
                                <div>
                                    <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">Nombre completo</label>
                                    <input
                                        required
                                        value={createForm.nombre}
                                        onChange={(e) => setCreateForm({ ...createForm, nombre: e.target.value })}
                                        placeholder="Ej: María García"
                                        className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">Email</label>
                                    <input
                                        required
                                        type="email"
                                        value={createForm.email}
                                        onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                                        placeholder="colaborador@email.com"
                                        className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[12px] font-semibold text-neutral-textSec mb-1.5">Contraseña</label>
                                    <input
                                        required
                                        type="password"
                                        value={createForm.password}
                                        onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                                        placeholder="Mínimo 12 caracteres"
                                        className="w-full min-h-[44px] px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper transition-all"
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={actionLoading}
                                    className="w-full min-h-[44px] px-4 py-2.5 bg-brand text-white rounded-[10px] font-semibold text-[15px] hover:bg-brand-hover active:scale-[0.98] transition-all mt-4 disabled:opacity-50"
                                >
                                    {actionLoading ? 'Creando...' : 'Crear colaborador'}
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmModal
                isOpen={!!staffToDelete}
                title={staffToDelete ? `¿Eliminar a ${staffToDelete.name} del equipo?` : '¿Eliminar colaborador?'}
                message={staffToDelete ? `${staffToDelete.name} dejará de tener acceso al taller. Esta acción no se puede deshacer.` : 'Esta acción no se puede deshacer.'}
                isDestructive={true}
                loading={actionLoading}
                onConfirm={() => { if (staffToDelete) executeStaffDeletion(staffToDelete.id); }}
                onCancel={() => !actionLoading && setStaffToDelete(null)}
            />
        </div>
    );
};

export default TeamView;
