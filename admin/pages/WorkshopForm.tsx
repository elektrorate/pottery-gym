
import React, { useState, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { Card, Button, Badge, Icon, Input } from '../components/UI';
import { WorkshopStatus, UserRole } from '../types';
import { useNavigate, useParams } from 'react-router-dom';
import { countryList, countriesData } from '../data/locations';
import { supabase } from '../../supabaseClient';

export const WorkshopForm: React.FC = () => {
  const { id } = useParams();
  const { addWorkshop, updateWorkshop, addUser, updateUser, users, workshops, showToast } = useAppContext();
  const navigate = useNavigate();

  const isEdit = !!id;
  const existingWorkshop = workshops.find(w => w.id === id);

  // Estados del flujo
  const [currentStep, setCurrentStep] = useState<1 | 2>(isEdit ? 2 : 1);
  const [adminConfirmed, setAdminConfirmed] = useState(isEdit);
  const [autoCreatedSedeId, setAutoCreatedSedeId] = useState<string | null>(null);

  // Datos del administrador (Paso 1)
  const [adminData, setAdminData] = useState({
    nombre: '',
    email: '',
    telefono: '',
    password: '',
    id: ''
  });

  // Datos del taller (Paso 2)
  const [workshopData, setWorkshopData] = useState({
    nombre: '',
    pais: '',
    ciudad: '',
    direccion: '',
    emailTaller: '',
    telefonoTaller: '',
    adminGeneralUserId: '',
    lat: 41.3851,
    lng: 2.1734,
    estado: WorkshopStatus.ACTIVE
  });

  useEffect(() => {
    if (isEdit && existingWorkshop) {
      setWorkshopData({
        nombre: existingWorkshop.nombre,
        pais: existingWorkshop.pais,
        ciudad: existingWorkshop.ciudad,
        direccion: existingWorkshop.direccion,
        emailTaller: existingWorkshop.emailTaller || '',
        telefonoTaller: existingWorkshop.telefonoTaller || '',
        adminGeneralUserId: existingWorkshop.adminGeneralUserId || '',
        lat: existingWorkshop.lat,
        lng: existingWorkshop.lng,
        estado: existingWorkshop.estado
      });
      const admin = users.find(u => u.id === existingWorkshop.adminGeneralUserId);
      if (admin) {
        setAdminData({
          nombre: admin.nombre,
          email: admin.email,
          telefono: admin.telefono,
          password: '••••••••', // Placeholder para edición
          id: admin.id
        });
      }
    }
  }, [isEdit, existingWorkshop, users]);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminData.nombre || !adminData.email || (!isEdit && !adminData.password)) {
      showToast('Nombre, Email y Contraseña son obligatorios', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      // BUG 4 FIX: In edit mode, update existing admin instead of creating new one
      if (isEdit && adminData.id) {
        await updateUser(adminData.id, { nombre: adminData.nombre, telefono: adminData.telefono });
        setAdminConfirmed(true);
        setCurrentStep(2);
        return;
      }

      // CREATE MODE: Create new user
      const result = await addUser({
        nombre: adminData.nombre,
        email: adminData.email,
        telefono: adminData.telefono,
        pais: '',
        ciudad: '',
        estado: WorkshopStatus.ACTIVE,
        rolesGlobales: [UserRole.WORKSHOP_ADMIN],
        rolesPorTaller: [],
        password: adminData.password
      });

      if (!result) return; // addUser already showed error toast

      const { userId, sedeId } = result;
      if (sedeId) setAutoCreatedSedeId(sedeId);

      setAdminData(prev => ({ ...prev, id: userId }));
      setWorkshopData(prev => ({ ...prev, adminGeneralUserId: userId }));
      setAdminConfirmed(true);
      setCurrentStep(2);
    } catch (err: any) {
      showToast(err?.message || 'Error inesperado al crear el administrador', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinalizeWorkshop = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!workshopData.nombre || !workshopData.pais || !workshopData.ciudad || !workshopData.direccion) {
      showToast('Por favor, completa los datos de la sede', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      let success = false;

      if (isEdit && id) {
        // EDIT MODE: Update existing sede by its ID
        success = await updateWorkshop(id, {
          ...workshopData,
          adminUserIds: [workshopData.adminGeneralUserId]
        });
      } else {
        // NEW MODE: The Edge Function already auto-created a sede for this user.
        // Find the auto-created sede by owner_id and UPDATE it with the real details.
        const autoCreatedSede = workshops.find(w => w.adminGeneralUserId === workshopData.adminGeneralUserId);
        let targetId = autoCreatedSede?.id || autoCreatedSedeId;

        // BUG 5 FIX: If not found in local state, query DB directly (more reliable)
        if (!targetId && workshopData.adminGeneralUserId) {
          const { data: sedeData } = await supabase
            .from('sedes')
            .select('id')
            .eq('owner_id', workshopData.adminGeneralUserId)
            .single();
          if (sedeData?.id) {
            targetId = sedeData.id;
          }
        }

        if (targetId) {
          // Update the auto-created sede with the real workshop details
          success = await updateWorkshop(targetId, {
            ...workshopData,
            adminUserIds: [workshopData.adminGeneralUserId]
          });
        } else {
          // Fallback: if for some reason the auto-created sede is not found, create one
          success = await addWorkshop({
            ...workshopData,
            adminUserIds: [workshopData.adminGeneralUserId]
          });
        }
      }

      // Solo navegar si la operación fue exitosa
      if (success) {
        navigate('/admin/talleres');
      }
    } catch (err: any) {
      showToast(err?.message || 'Error inesperado al guardar la sede', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const labelClass = "ui-label mb-1.5 block";
  const selectClass = "ui-control w-full px-4 py-2.5 pr-10 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none transition-all text-neutral-textMain appearance-none";

  return (
    <div className="max-w-3xl mx-auto space-y-8 md:space-y-10 animate-fade-in pb-20">

      {/* Header Visual */}
      <div className="text-center space-y-3">
        <Badge variant={adminConfirmed ? 'success' : 'yellow'}>
          {adminConfirmed ? 'PASO 1 COMPLETADO' : 'CONFIGURACIÓN INICIAL'}
        </Badge>
        <h1 className="ui-page-title text-neutral-textMain">
          {isEdit ? 'Actualizar Sede' : 'Nuevo Registro'}
        </h1>
        <div className="flex justify-center items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.14em]">
          <span className={currentStep === 1 ? 'text-brand' : 'text-neutral-textHelper'}>01 RESPONSABLE</span>
          <div className="w-8 h-px bg-neutral-border"></div>
          <span className={currentStep === 2 ? 'text-brand' : 'text-neutral-textHelper'}>02 TALLER</span>
        </div>
      </div>

      <div className="space-y-6">

        {/* PASO 1: ADMINISTRADOR */}
        <Card className={`relative transition-all duration-500 ${currentStep === 2 && !isEdit ? 'opacity-40 grayscale-[0.5]' : ''}`}>
          <div className="flex items-center gap-4 border-b border-neutral-border pb-4 mb-5">
            <div className={`w-11 h-11 rounded-full flex items-center justify-center font-bold text-[14px] transition-colors shrink-0 ${adminConfirmed ? 'bg-[#20663B] text-white' : 'bg-brand text-white'}`}>
              {adminConfirmed ? '✓' : '01'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-center gap-2">
                <h3 className="text-[15px] font-bold text-neutral-textMain">Registro de Administrador Taller</h3>
                {adminConfirmed && currentStep === 2 && (
                  <button
                    type="button"
                    onClick={() => { setAdminConfirmed(false); setCurrentStep(1); }}
                    className="text-[12px] font-semibold text-brand hover:text-brand-hover transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    Editar
                  </button>
                )}
              </div>
              <p className="text-[12px] font-semibold text-neutral-textHelper mt-0.5">DATOS DEL ADMINISTRADOR DEL CENTRO</p>
            </div>
          </div>

          <form onSubmit={handleCreateAdmin} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Nombre y Apellidos *"
                placeholder="Ej: David Casals"
                value={adminData.nombre}
                onChange={e => setAdminData({ ...adminData, nombre: e.target.value })}
                disabled={adminConfirmed && currentStep === 2}
              />
              <Input
                label="Correo Electrónico *"
                type="email"
                placeholder="nombre@ejemplo.com"
                value={adminData.email}
                onChange={e => setAdminData({ ...adminData, email: e.target.value })}
                disabled={adminConfirmed && currentStep === 2}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Teléfono Móvil"
                placeholder="+34 600 000 000"
                value={adminData.telefono}
                onChange={e => setAdminData({ ...adminData, telefono: e.target.value })}
                disabled={adminConfirmed && currentStep === 2}
              />
              <Input
                label="Contraseña de Acceso *"
                type="password"
                placeholder="••••••••"
                value={adminData.password}
                onChange={e => setAdminData({ ...adminData, password: e.target.value })}
                disabled={adminConfirmed && currentStep === 2}
              />
            </div>

            {!adminConfirmed && (
              <div className="flex justify-end pt-3">
                <Button type="submit" variant="primary" className="w-full md:w-auto" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <div className="flex items-center gap-2">
                      <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></span>
                      <span>CREANDO...</span>
                    </div>
                  ) : 'Crear Perfil Administrador'}
                </Button>
              </div>
            )}

            {adminConfirmed && currentStep === 2 && !isEdit && (
              <div className="flex items-center gap-3 p-4 bg-[#DFF0E4] rounded-2xl border border-[#BFDECB]">
                <div className="w-8 h-8 bg-[#20663B] text-white rounded-full flex items-center justify-center text-xs shrink-0">✓</div>
                <p className="text-[13px] font-semibold text-[#20663B] truncate flex-1">
                  Responsable confirmado: <span className="underline ml-1">{adminData.nombre}</span>
                </p>
              </div>
            )}
          </form>
        </Card>

        {/* PASO 2: TALLER */}
        {(currentStep === 2 || isEdit) && (
          <Card className="animate-fade-in">
            <div className="flex items-center gap-4 border-b border-neutral-border pb-4 mb-5">
              <div className="w-11 h-11 bg-brand text-white rounded-full flex items-center justify-center font-bold text-[14px] shrink-0">
                02
              </div>
              <div className="min-w-0">
                <h3 className="text-[15px] font-bold text-neutral-textMain">Configuración de Sede</h3>
                <p className="text-[12px] font-semibold text-neutral-textHelper mt-0.5">DATOS FÍSICOS Y CONTACTO DEL TALLER</p>
              </div>
            </div>

            <form onSubmit={handleFinalizeWorkshop} className="space-y-5">
              <div className="space-y-4">
                <Input
                  label="Nombre Comercial del Centro *"
                  placeholder="Ej: Terracotta Studio BCN"
                  value={workshopData.nombre}
                  onChange={e => setWorkshopData({ ...workshopData, nombre: e.target.value })}
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>País de Operación *</label>
                    <div className="relative">
                      <select
                        className={selectClass}
                        value={workshopData.pais}
                        onChange={e => setWorkshopData({ ...workshopData, pais: e.target.value, ciudad: '' })}
                      >
                        <option value="">Selecciona...</option>
                        {countryList.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-neutral-textHelper">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>Ciudad *</label>
                    <div className="relative">
                      <select
                        className={selectClass}
                        value={workshopData.ciudad}
                        onChange={e => setWorkshopData({ ...workshopData, ciudad: e.target.value })}
                        disabled={!workshopData.pais}
                      >
                        <option value="">Selecciona...</option>
                        {(countriesData[workshopData.pais] || []).map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-neutral-textHelper">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                      </div>
                    </div>
                  </div>
                </div>

                <Input
                  label="Dirección Completa *"
                  placeholder="Carrer de Valencia, 123, Local 2"
                  value={workshopData.direccion}
                  onChange={e => setWorkshopData({ ...workshopData, direccion: e.target.value })}
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="Email Público del Taller"
                    placeholder="info@terracotta.com"
                    value={workshopData.emailTaller}
                    onChange={e => setWorkshopData({ ...workshopData, emailTaller: e.target.value })}
                  />
                  <Input
                    label="Teléfono del Centro"
                    placeholder="932 000 000"
                    value={workshopData.telefonoTaller}
                    onChange={e => setWorkshopData({ ...workshopData, telefonoTaller: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:justify-end gap-3 pt-5 border-t border-neutral-border">
                {!isEdit && (
                  <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setCurrentStep(1)}>
                    VOLVER AL PASO 1
                  </Button>
                )}
                <Button type="submit" variant="primary" disabled={isSubmitting} className="w-full sm:w-auto disabled:opacity-60 disabled:cursor-not-allowed">
                  {isSubmitting ? 'GUARDANDO...' : (isEdit ? 'GUARDAR CAMBIOS' : 'CONFIRMAR Y CREAR TALLER')}
                </Button>
              </div>
            </form>
          </Card>
        )}
      </div>

      <div className="flex justify-center pt-4">
        <button
          type="button"
          onClick={() => navigate('/admin/talleres')}
          className="min-h-[44px] px-4 text-[12px] font-semibold text-neutral-textHelper hover:text-[#9E3B2B] transition-colors"
        >
          CANCELAR PROCESO DE REGISTRO
        </button>
      </div>
    </div>
  );
};
