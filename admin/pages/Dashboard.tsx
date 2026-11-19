
import React from 'react';
import { useAppContext } from '../context/AppContext';
import { Card, Button, Icon, ActivityPill } from '../components/UI';
import { useNavigate } from 'react-router-dom';
import { WorkshopStatus } from '../types';
import DiagonalPattern from '../../components/shared/DiagonalPattern';

export const Dashboard: React.FC = () => {
  const { workshops, users, globalMetrics } = useAppContext();
  const navigate = useNavigate();

  const activeWorkshops = workshops.filter(w => w.estado === WorkshopStatus.ACTIVE).length;
  const adminUsers = users.length;
  const totalStudents = globalMetrics.totalStudents;
  const temporaryStudents = globalMetrics.temporaryStudents;
  const activeGiftCards = globalMetrics.activeGiftCards;
  const totalGiftCards = globalMetrics.totalGiftCards;
  const expiredGiftCards = globalMetrics.expiredGiftCards;

  return (
    <div className="animate-fade-in max-w-7xl mx-auto">

      <div className="flex flex-col lg:flex-row gap-8 lg:gap-12 items-start">

        {/* COLUMNA IZQUIERDA: ACTIVIDAD DIARIA */}
        <section className="flex-1 space-y-6">
          <div className="flex items-center justify-between px-1">
            <h2 className="ui-page-title text-neutral-textMain">
              Resumen Global
            </h2>
            <button type="button" aria-label="Más opciones del resumen" className="p-2 text-neutral-textHelper hover:text-brand transition-colors">
              <Icon.More />
            </button>
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="px-4 py-2 bg-neutral-alt rounded-full flex items-center gap-2.5">
              <div className="w-2 h-2 bg-[#20663B] rounded-full animate-pulse"></div>
              <span className="eyebrow">
                {new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}
              </span>
            </div>
            <div className="px-4 py-2 border border-neutral-border rounded-full flex items-center gap-2.5 text-neutral-textMain">
              <span className="text-[12px] font-semibold text-neutral-textSec uppercase tracking-[0.1em]">Red de Producción:</span>
              <span className="text-[12px] font-bold text-brand">ACTIVA</span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 max-w-2xl">
            <ActivityPill
              label="Talleres Activos"
              value={`${activeWorkshops} / ${workshops.length}`}
              status="Operativo"
              percentage={`${workshops.length > 0 ? Math.round((activeWorkshops / workshops.length) * 100) : 0}%`}
                iconBg="#C7460A"
            />
            <ActivityPill
              label="Usuarios"
              value={`${adminUsers} / ${totalStudents}`}
              status="Admins / Alumnos"
              percentage={`${temporaryStudents} TEMP`}
               iconBg="#C98A53"
            />
            <ActivityPill
              label="Bonos"
              value={`${activeGiftCards} / ${totalGiftCards}`}
              status="Vigentes / Total"
              percentage={`${expiredGiftCards} VENC`}
               iconBg="#172338"
            />
          </div>
        </section>

        {/* COLUMNA DERECHA: TARJETA GESTIÓN */}
        <section className="w-full lg:w-[380px] shrink-0">
           <Card className="!p-4 md:!p-6 flex flex-col justify-between gap-8 relative overflow-hidden group">
             <DiagonalPattern />
             <div className="space-y-6">
               <div className="relative z-10 w-14 h-14 bg-brand-soft rounded-2xl flex items-center justify-center text-brand">
                <Icon.Target />
              </div>
               <div className="relative z-10 space-y-4">
                 <h3 className="ui-section-title text-neutral-textMain leading-tight">Gestión<br />de Red</h3>
                <div className="accent-line"></div>
              </div>
               <p className="relative z-10 text-[15px] text-neutral-textSec leading-relaxed max-w-[280px]">Configura nuevos centros de producción y supervisa la actividad global.</p>
            </div>

             <div className="relative z-10 mt-4">
              <Button
                variant="primary"
                className="w-full justify-between group-hover:scale-[1.01] transition-transform"
                onClick={() => navigate('/admin/talleres/nuevo')}
              >
                NUEVA SEDE
                <Icon.ArrowUpRight />
              </Button>
            </div>

            {/* Marca de agua sutil */}
            <div className="absolute -bottom-10 -right-10 opacity-[0.03] rotate-12 pointer-events-none">
              <div className="w-64 h-64 bg-black rounded-full"></div>
            </div>
          </Card>
        </section>

      </div>

      {/* Footer Branding */}
      <div className="mt-16 md:mt-20 pb-8 flex flex-col items-center opacity-10">
        <div className="w-10 h-10 bg-neutral-textMain rounded-xl mb-4"></div>
        <p className="eyebrow">CASA ROSIER ESTUDIO CENTRAL</p>
      </div>
    </div>
  );
};
