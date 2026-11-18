
import React, { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { supabase } from '../../supabaseClient';
import { Button, Input, Modal } from '../components/UI';

/* ───────────────────────────────────────────────
   Tipos auxiliares
   ─────────────────────────────────────────────── */
interface TeamMember {
    id: string;
    email: string;
    full_name: string;
    phone: string;
    role: string;
    sede_name: string;
}

/* ───────────────────────────────────────────────
   Helper: call manage-staff edge function
   ─────────────────────────────────────────────── */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_PROJECT_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

async function callManageStaff(body: Record<string, any>): Promise<any> {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    const token = session?.access_token;

    if (sessionError || !token) {
        throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('Configuración incompleta de Supabase en el deploy.');
    }

    const response = await fetch(`${SUPABASE_URL}/functions/v1/manage-staff`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('Sesión no válida. Vuelve a iniciar sesión.');
        }
        throw new Error(data?.error || `Error del servidor (${response.status}).`);
    }

    if (data?.error) throw new Error(data.error);
    return data;
}

/* ───────────────────────────────────────────────
   Standalone load function — NO React dependencies
   ─────────────────────────────────────────────── */
async function fetchTeamMembers(): Promise<TeamMember[]> {
    // 1) Get all tallerista + staff profiles
    const { data: profiles, error: profError } = await supabase
        .from('profiles')
        .select('id, email, full_name, phone, role')
        .in('role', ['tallerista'])
        .order('full_name');

    if (profError) {
        console.error('[TeamManagement] profiles query error:', profError);
        throw new Error('Error cargando perfiles: ' + profError.message);
    }

    if (!profiles || profiles.length === 0) {
        console.warn('[TeamManagement] No profiles found with role tallerista/staff');
        return [];
    }

    console.log(`[TeamManagement] Found ${profiles.length} team members`);

    // 2) Try to get sede names (non-critical — if fails, we still show members)
    let sedeMap: Record<string, string> = {};
    try {
        const { data: sedes } = await supabase
            .from('sedes')
            .select('id, owner_id, name');

        if (sedes) {
            // Map talleristas to their sede by owner_id
            sedes.forEach((s: any) => {
                if (s.owner_id) sedeMap[s.owner_id] = s.name;
            });

            // Map staff to their sede via sede_members
            const { data: memberships } = await supabase
                .from('sede_members')
                .select('user_id, sede_id');

            if (memberships) {
                const sedeIdMap: Record<string, string> = {};
                sedes.forEach((s: any) => { sedeIdMap[s.id] = s.name; });
                memberships.forEach((m: any) => {
                    if (!sedeMap[m.user_id] && sedeIdMap[m.sede_id]) {
                        sedeMap[m.user_id] = sedeIdMap[m.sede_id];
                    }
                });
            }
        }
    } catch (sedeErr) {
        // Non-critical — members still show without sede names
        console.warn('[TeamManagement] sede lookup failed (non-critical):', sedeErr);
    }

    return profiles.map(p => ({
        id: p.id,
        email: p.email || '',
        full_name: p.full_name || 'Sin nombre',
        phone: p.phone || '',
        role: p.role || 'tallerista',
        sede_name: sedeMap[p.id] || ''
    }));
}

/* ───────────────────────────────────────────────
   Page Component
   ─────────────────────────────────────────────── */
export const TeamManagement: React.FC = () => {
    const { currentUser, showToast } = useAppContext();
    const showToastRef = useRef(showToast);
    showToastRef.current = showToast;

    /* ── Admin profile state ── */
    const [adminForm, setAdminForm] = useState({ nombre: '', telefono: '' });
    const [adminSaving, setAdminSaving] = useState(false);

    /* ── Password state ── */
    const [pwForm, setPwForm] = useState({ newPassword: '', confirmPassword: '' });
    const [pwSaving, setPwSaving] = useState(false);

    /* ── Team list state ── */
    const [team, setTeam] = useState<TeamMember[]>([]);
    const [teamLoading, setTeamLoading] = useState(true);

    /* ── Edit member modal ── */
    const [editMember, setEditMember] = useState<TeamMember | null>(null);
    const [editForm, setEditForm] = useState({ nombre: '', telefono: '', newPassword: '' });
    const [editSaving, setEditSaving] = useState(false);

    /* ── Delete member modal ── */
    const [deleteMember, setDeleteMember] = useState<TeamMember | null>(null);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [deleting, setDeleting] = useState(false);

    /* ── Search ── */
    const [search, setSearch] = useState('');

    /* ── Seed admin form from currentUser ── */
    useEffect(() => {
        if (currentUser) {
            setAdminForm({
                nombre: currentUser.nombre || '',
                telefono: currentUser.telefono || ''
            });
        }
    }, [currentUser]);

    /* ── Load team on mount — no deps, runs once ── */
    const loadTeam = async () => {
        setTeamLoading(true);
        try {
            const members = await fetchTeamMembers();
            setTeam(members);
        } catch (err: any) {
            console.error('[TeamManagement] loadTeam failed:', err);
            showToastRef.current(err.message || 'Error cargando equipo', 'error');
        } finally {
            setTeamLoading(false);
        }
    };

    useEffect(() => {
        loadTeam();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ────────────────────────────────
       Handlers
       ──────────────────────────────── */

    const handleSaveAdmin = async () => {
        if (adminSaving) return;
        if (!currentUser) return;
        if (!adminForm.nombre.trim()) {
            showToast('El nombre es obligatorio', 'error');
            return;
        }
        setAdminSaving(true);
        try {
            await callManageStaff({
                action: 'update_profile',
                targetUserId: currentUser.id,
                full_name: adminForm.nombre.trim(),
                phone: adminForm.telefono.trim()
            });
            showToast('Datos del administrador actualizados ✓', 'success');
        } catch (err: any) {
            showToast(err.message || 'Error inesperado', 'error');
        } finally {
            setAdminSaving(false);
        }
    };

    const handleChangePassword = async () => {
        if (pwSaving) return;
        if (pwForm.newPassword !== pwForm.confirmPassword) {
            showToast('Las contraseñas no coinciden', 'error');
            return;
        }
        if (pwForm.newPassword.length < 12) {
            showToast('La contraseña debe tener al menos 12 caracteres', 'error');
            return;
        }
        setPwSaving(true);
        try {
            const { error } = await supabase.auth.updateUser({ password: pwForm.newPassword });
            if (error) {
                showToast(error.message || 'Error al cambiar contraseña', 'error');
            } else {
                showToast('Contraseña actualizada exitosamente ✓', 'success');
                setPwForm({ newPassword: '', confirmPassword: '' });
            }
        } catch (err: any) {
            showToast(err.message || 'Error inesperado', 'error');
        } finally {
            setPwSaving(false);
        }
    };

    const openEditMember = (member: TeamMember) => {
        setEditMember(member);
        setEditForm({ nombre: member.full_name, telefono: member.phone, newPassword: '' });
    };

    const handleSaveMember = async () => {
        if (editSaving) return;
        if (!editMember) return;
        if (!editForm.nombre.trim()) {
            showToast('El nombre es obligatorio', 'error');
            return;
        }
        setEditSaving(true);
        try {
            // 1. Update profile
            await callManageStaff({
                action: 'update_profile',
                targetUserId: editMember.id,
                full_name: editForm.nombre.trim(),
                phone: editForm.telefono.trim()
            });

            // 2. Update password if provided
            if (editForm.newPassword.trim()) {
                if (editForm.newPassword.trim().length < 12) {
                    showToast('Perfil guardado, pero la contraseña necesita mínimo 12 caracteres', 'error');
                    setEditMember(null);
                    await loadTeam();
                    setEditSaving(false);
                    return;
                }
                await callManageStaff({
                    action: 'update_password',
                    staffUserId: editMember.id,
                    password: editForm.newPassword.trim()
                });
                showToast('Perfil y contraseña actualizados ✓', 'success');
            } else {
                showToast('Perfil actualizado correctamente ✓', 'success');
            }

            setEditMember(null);
            await loadTeam();
        } catch (err: any) {
            showToast(err.message || 'Error inesperado', 'error');
        } finally {
            setEditSaving(false);
        }
    };

    const handleDeleteMember = async () => {
        if (deleting) return;
        if (!deleteMember) return;
        if (deleteConfirmText !== 'ELIMINAR') {
            showToast('Escribe ELIMINAR para confirmar', 'error');
            return;
        }
        setDeleting(true);
        try {
            await callManageStaff({
                action: 'delete',
                staffUserId: deleteMember.id
            });
            showToast(`${deleteMember.full_name} eliminado correctamente`, 'success');
            setDeleteMember(null);
            setDeleteConfirmText('');
            await loadTeam();
        } catch (err: any) {
            showToast(err.message || 'Error al eliminar usuario', 'error');
        } finally {
            setDeleting(false);
        }
    };

    /* ── Filtered members ── */
    const filtered = team.filter(m => {
        const q = search.toLowerCase();
        if (!q) return true;
        return m.full_name.toLowerCase().includes(q) ||
            m.email.toLowerCase().includes(q) ||
            m.role.toLowerCase().includes(q);
    });

    const roleLabel = (r: string) => {
        if (r === 'tallerista') return 'TALLERISTA';
        if (r === 'staff') return 'STAFF';
        return r.toUpperCase();
    };

    /* ────────────────────────────────
       RENDER
       ──────────────────────────────── */
    return (
        <div className="animate-fade-in max-w-5xl mx-auto space-y-8 md:space-y-12">

            {/* ── HEADER ── */}
            <div>
                <h2 className="ui-page-title text-neutral-textMain">
                    Gestión del <span className="text-brand">Equipo</span>
                </h2>
                <p className="ui-secondary mt-2 max-w-xl">
                    Edita tus datos de administrador, cambia tu contraseña y gestiona las credenciales de talleristas.
                </p>
            </div>

            {/* ── SECCIÓN 1: Datos del Administrador ── */}
            <section className="bg-white rounded-2xl border border-neutral-border p-4 md:p-6 space-y-6">
                <div>
                    <p className="eyebrow mb-2">MI PERFIL</p>
                    <h3 className="ui-section-title text-neutral-textMain">Datos del Administrador</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Input
                        label="Nombre completo"
                        value={adminForm.nombre}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdminForm({ ...adminForm, nombre: e.target.value })}
                        placeholder="Tu nombre"
                    />
                    <Input
                        label="Teléfono"
                        value={adminForm.telefono}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdminForm({ ...adminForm, telefono: e.target.value })}
                        placeholder="+34 600 000 000"
                    />
                </div>

                <div className="flex items-center gap-3 rounded-2xl bg-neutral-sec p-4 border border-neutral-border">
                    <div className="w-3 h-3 bg-brand rounded-full shrink-0"></div>
                    <p className="text-[14px] text-neutral-textSec">
                        Email: <span className="font-semibold text-neutral-textMain">{currentUser?.email || '—'}</span>
                        <span className="ml-2 text-[12px] text-neutral-textHelper">(no editable)</span>
                    </p>
                </div>

                <Button variant="dark" size="md" className="!bg-brand hover:!bg-brand-hover" onClick={handleSaveAdmin} disabled={adminSaving}>
                    {adminSaving ? 'GUARDANDO...' : 'GUARDAR CAMBIOS'}
                </Button>
            </section>

            {/* ── SECCIÓN 2: Cambiar Contraseña ── */}
            <section className="bg-white rounded-2xl border border-neutral-border p-4 md:p-6 space-y-6">
                <div>
                    <p className="eyebrow mb-2">SEGURIDAD</p>
                     <h3 className="ui-section-title text-neutral-textMain">Cambiar Contraseña</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Input label="Nueva contraseña" type="password" value={pwForm.newPassword}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                        placeholder="Mínimo 12 caracteres" />
                    <Input label="Confirmar contraseña" type="password" value={pwForm.confirmPassword}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                        placeholder="Repite la contraseña" />
                </div>
                <Button variant="dark" size="md" className="!bg-brand hover:!bg-brand-hover" onClick={handleChangePassword} disabled={pwSaving}>
                    {pwSaving ? 'ACTUALIZANDO...' : 'ACTUALIZAR CONTRASEÑA'}
                </Button>
            </section>

            {/* ── SECCIÓN 3: Credenciales del Equipo ── */}
            <section className="bg-white rounded-2xl border border-neutral-border p-4 md:p-6 space-y-6">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                        <p className="eyebrow mb-2">CREDENCIALES</p>
                         <h3 className="ui-section-title text-neutral-textMain">Equipo de Trabajo</h3>
                        <p className="text-[14px] text-neutral-textSec mt-1">Talleristas — edita sus datos o restablece contraseñas.</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        <span className="px-3 py-1.5 bg-brand-soft rounded-[10px] text-[13px] font-semibold text-brand">
                            {team.length} miembro{team.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>

                {/* Search */}
                <div className="relative max-w-md">
                    <svg className="absolute left-5 top-1/2 -translate-y-1/2 text-neutral-textHelper" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16" y2="16" />
                    </svg>
                    <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                        placeholder="Buscar por nombre, email o rol..."
                        className="w-full min-h-[44px] pl-14 pr-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none transition-all text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper" />
                </div>

                {/* List */}
                {teamLoading ? (
                    <div className="flex items-center justify-center py-16">
                        <div className="w-8 h-8 border-[3px] border-brand border-t-transparent rounded-full animate-spin"></div>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="py-16 text-center bg-neutral-sec border border-dashed border-neutral-border rounded-2xl">
                        <p className="text-[14px] font-semibold text-neutral-textHelper">
                            {search ? 'Sin resultados para tu búsqueda' : 'No hay miembros del equipo registrados'}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filtered.map(member => (
                            <div key={member.id}
                                className="flex flex-col md:flex-row md:items-center gap-4 p-4 md:p-6 bg-neutral-sec hover:bg-neutral-alt rounded-2xl transition-colors group">
                                <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 bg-white">
                                    <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${member.email}`} alt={member.full_name} className="w-full h-full" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[16px] font-semibold text-neutral-textMain truncate leading-tight">{member.full_name}</p>
                                    <p className="text-[13px] text-neutral-textSec truncate mt-0.5">{member.email}</p>
                                    {member.phone && <p className="text-[13px] text-neutral-textSec mt-0.5">📞 {member.phone}</p>}
                                    <div className="flex flex-wrap gap-2 mt-2">
                                         <span className={`px-2.5 py-1 rounded-lg text-[12px] font-semibold ${member.role === 'tallerista' ? 'bg-brand-soft text-brand' : 'bg-white text-neutral-textMain'}`}>
                                            {roleLabel(member.role)}
                                        </span>
                                        {member.sede_name && (
                                             <span className="px-2.5 py-1 rounded-lg text-[12px] font-semibold bg-white border border-neutral-border text-neutral-textSec">
                                                {member.sede_name}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex gap-2 shrink-0">
                                    <Button variant="dark" size="sm" className="!px-5 !py-3 !bg-brand hover:!bg-brand-hover" onClick={() => openEditMember(member)}>
                                        EDITAR
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="!px-5 !py-3 !border-[#EFC9BE] !text-[#9E3B2B] hover:!bg-[#F8E1DA]"
                                        onClick={() => { setDeleteMember(member); setDeleteConfirmText(''); }}
                                    >
                                        ELIMINAR
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* ── MODAL: Editar miembro ── */}
            <Modal isOpen={!!editMember} onClose={() => setEditMember(null)}
                title={`Editar ${editMember?.role === 'tallerista' ? 'Tallerista' : 'Staff'}`}
                footer={
                    <>
                        <Button variant="outline" size="sm" onClick={() => setEditMember(null)}>CANCELAR</Button>
                        <Button variant="dark" size="sm" className="!bg-brand hover:!bg-brand-hover" onClick={handleSaveMember} disabled={editSaving}>
                            {editSaving ? 'GUARDANDO...' : 'GUARDAR'}
                        </Button>
                    </>
                }>
                <div className="space-y-5">
                    <div className="flex items-center gap-4 p-4 bg-neutral-sec rounded-2xl">
                        <div className="w-12 h-12 rounded-full overflow-hidden bg-white shrink-0">
                            <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${editMember?.email}`} alt="" className="w-full h-full" />
                        </div>
                        <div>
                            <p className="text-[15px] font-semibold text-neutral-textMain">{editMember?.full_name}</p>
                            <p className="text-[13px] text-neutral-textSec">{editMember?.email} <span className="text-[12px] text-neutral-textHelper">(no editable)</span></p>
                        </div>
                    </div>
                    <Input label="Nombre completo" value={editForm.nombre}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm({ ...editForm, nombre: e.target.value })} />
                    <Input label="Teléfono" value={editForm.telefono}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm({ ...editForm, telefono: e.target.value })} />
                    <div className="border-t border-neutral-border pt-5">
                        <p className="eyebrow mb-3">RESTABLECER CONTRASEÑA</p>
                        <Input label="Nueva contraseña (dejar vacío para no cambiar)" type="password" value={editForm.newPassword}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm({ ...editForm, newPassword: e.target.value })}
                            placeholder="Mínimo 12 caracteres" />
                    </div>
                </div>
            </Modal>

            {/* ── MODAL: Confirmar eliminación ── */}
            <Modal isOpen={!!deleteMember} onClose={() => { setDeleteMember(null); setDeleteConfirmText(''); }}
                title="Eliminar Usuario"
                footer={
                    <>
                        <Button variant="outline" size="sm" onClick={() => { setDeleteMember(null); setDeleteConfirmText(''); }}>CANCELAR</Button>
                        <Button
                            variant="dark"
                            size="sm"
                            className="!bg-[#9E3B2B] hover:!bg-[#8A3325]"
                            onClick={handleDeleteMember}
                            disabled={deleting || deleteConfirmText !== 'ELIMINAR'}
                        >
                            {deleting ? 'ELIMINANDO...' : 'ELIMINAR USUARIO'}
                        </Button>
                    </>
                }>
                <div className="space-y-5">
                    <div className="flex items-center gap-4 p-4 bg-[#F8E1DA] border border-[#EFC9BE] rounded-2xl">
                        <div className="w-12 h-12 rounded-full overflow-hidden bg-white shrink-0">
                            <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${deleteMember?.email}`} alt="" className="w-full h-full" />
                        </div>
                        <div>
                            <p className="text-[15px] font-semibold text-neutral-textMain">{deleteMember?.full_name}</p>
                            <p className="text-[13px] text-neutral-textSec">{deleteMember?.email}</p>
                            <span className={`inline-block mt-1 px-2.5 py-1 rounded-lg text-[12px] font-semibold ${deleteMember?.role === 'tallerista' ? 'bg-white text-brand' : 'bg-white text-neutral-textMain'}`}>
                                {roleLabel(deleteMember?.role || '')}
                            </span>
                        </div>
                    </div>

                    <div className="p-4 bg-[#F8E1DA] border border-[#EFC9BE] rounded-2xl">
                        <p className="text-[13px] text-[#9E3B2B]">
                            <strong>Esta accion es irreversible.</strong> Se eliminara permanentemente:
                        </p>
                        <ul className="mt-2 text-[13px] text-[#9E3B2B] list-disc list-inside space-y-1">
                            <li>La cuenta de usuario</li>
                            <li>Su perfil y datos asociados</li>
                            <li>Su acceso a la plataforma</li>
                        </ul>
                    </div>

                    <div>
                        <p className="text-[12px] font-semibold text-neutral-textSec mb-2">
                            Escribe ELIMINAR para confirmar:
                        </p>
                        <Input
                            value={deleteConfirmText}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeleteConfirmText(e.target.value)}
                            placeholder="ELIMINAR"
                            className={deleteConfirmText === 'ELIMINAR' ? '!border-[#BFDECB] !ring-[#DFF0E4]' : ''}
                        />
                    </div>
                </div>
            </Modal>
        </div>
    );
};
