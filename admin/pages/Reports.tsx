
import React from 'react';
import { useAppContext } from '../context/AppContext';
import { Card, Button } from '../components/UI';
import { madridDateKey } from '../../utils/dateFormat';

export const Reports: React.FC = () => {
    const { workshops, users, workshopMetrics, globalMetrics, showToast } = useAppContext();

    const handleExport = (type: string) => {
        showToast(`Generando reporte CSV de ${type}...`, 'info');

        try {
            const headers = [
                'Nombre Taller',
                'Admin General',
                'Email',
                'Teléfono',
                'País',
                'Ciudad',
                'Dirección',
                'Estado',
                'Alumnos Totales',
                'Alumnos Membresía',
                'Alumnos Temporales',
                'Bonos Totales',
                'Bonos Vigentes',
                'Bonos Vencidos',
                'Bonos Sin Enlace',
                'Bonos Sin Expiración',
                'Sesiones Totales',
                'Sesiones Temporal',
                'Sesiones Membresía',
                'Sesiones Sin Audiencia'
            ];
            const rows = workshops.map(w => {
                const admin = users.find(u => u.id === w.adminGeneralUserId);
                const metrics = workshopMetrics[w.id] || {
                    totalStudents: 0,
                    membershipStudents: 0,
                    temporaryStudents: 0,
                    totalGiftCards: 0,
                    activeGiftCards: 0,
                    expiredGiftCards: 0,
                    unlinkedGiftCards: 0,
                    missingExpiryGiftCards: 0,
                    totalSessions: 0,
                    temporalSessions: 0,
                    membershipSessions: 0,
                    nullAudienceSessions: 0
                };
                return [
                    w.nombre || '',
                    admin?.nombre || 'Sin asignar',
                    w.emailTaller || '',
                    w.telefonoTaller || '',
                    w.pais || '',
                    w.ciudad || '',
                    w.direccion || '',
                    w.estado || 'Desconocido',
                    metrics.totalStudents,
                    metrics.membershipStudents,
                    metrics.temporaryStudents,
                    metrics.totalGiftCards,
                    metrics.activeGiftCards,
                    metrics.expiredGiftCards,
                    metrics.unlinkedGiftCards,
                    metrics.missingExpiryGiftCards,
                    metrics.totalSessions,
                    metrics.temporalSessions,
                    metrics.membershipSessions,
                    metrics.nullAudienceSessions
                ];
            });

            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            ].join('\n');

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', `reporte_talleres_${madridDateKey()}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            showToast('Reporte descargado correctamente', 'success');
        } catch (err) {
            console.error('Error exporting CSV:', err);
            showToast('Error al generar el CSV', 'error');
        }
    };

    const countriesCount = workshops.reduce((acc, curr) => {
        acc[curr.pais] = (acc[curr.pais] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
    const missingWorkshopContacts = workshops.filter(w => !w.emailTaller || !w.telefonoTaller).length;
    const dataModelAlerts = globalMetrics.unlinkedGiftCards + globalMetrics.missingExpiryGiftCards + globalMetrics.nullAudienceSessions;

    return (
        <div className="space-y-6 md:space-y-8 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                     <h1 className="ui-page-title text-neutral-textMain">Reportes</h1>
                     <p className="ui-secondary">Analiza y descarga los datos del sistema</p>
                </div>
                <div className="flex gap-3">
                    {/* Se elimina el botón de exportación de Admins según solicitud visual */}
                    <Button variant="primary" onClick={() => handleExport('Talleres')}>Exportar CSV Talleres</Button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                <Card className="!p-4 md:!p-6">
                     <h3 className="ui-section-title text-neutral-textMain mb-5">Talleres por País</h3>
                    <div className="space-y-4">
                        {Object.entries(countriesCount).map(([pais, count]) => (
                            <div key={pais} className="flex items-center gap-4">
                                 <span className="w-24 min-w-0 shrink-0 truncate text-[13px] font-semibold text-neutral-textMain">{pais}</span>
                                <div className="flex-1 h-2 bg-neutral-sec rounded-full overflow-hidden">
                                    <div className="h-full bg-brand rounded-full" style={{ width: `${((count as number) / (workshops.length || 1)) * 100}%` }}></div>
                                </div>
                                <span className="text-sm font-bold text-neutral-textMain shrink-0">{count}</span>
                            </div>
                        ))}
                    </div>
                </Card>

                <Card className="!p-4 md:!p-6">
                     <h3 className="ui-section-title text-neutral-textMain mb-5">Alertas de Datos</h3>
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-4 p-4 bg-[#FBEAD2] border border-[#EBD5AC] rounded-xl">
                            <div>
                                <p className="text-[14px] font-bold text-[#8A5517]">Talleres sin admin general</p>
                                <p className="text-[13px] text-[#8A5517] opacity-80">Requiere atención inmediata</p>
                            </div>
                            <span className="text-2xl font-bold text-[#8A5517] shrink-0">{workshops.filter(w => !w.adminGeneralUserId).length}</span>
                        </div>
                         <div className="flex items-center justify-between gap-4 p-4 bg-neutral-sec border border-neutral-border rounded-xl">
                             <div>
                                 <p className="text-[14px] font-bold text-neutral-textMain">Datos incompletos</p>
                                 <p className="text-[13px] text-neutral-textSec">Contactos + modelo temporal/bonos/audiencia</p>
                             </div>
                             <span className="ui-kpi text-neutral-textMain shrink-0">{missingWorkshopContacts + dataModelAlerts}</span>
                        </div>
                    </div>
                </Card>
            </div>

            <Card className="!p-4 md:!p-6">
                 <h3 className="ui-section-title text-neutral-textMain mb-5">Resumen de Localidades</h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="border-b border-neutral-border">
                            <tr>
                                <th className="pb-3 text-[12px] font-semibold text-neutral-textSec">País</th>
                                <th className="pb-3 text-[12px] font-semibold text-neutral-textSec">Ciudad</th>
                                <th className="pb-3 text-[12px] font-semibold text-neutral-textSec text-right">Nº Talleres</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-border">
                            {workshops.reduce((acc, w) => {
                                const key = `${w.pais}-${w.ciudad}`;
                                const found = acc.find(item => item.pais === w.pais && item.ciudad === w.ciudad);
                                if (found) found.count++;
                                else acc.push({ pais: w.pais, ciudad: w.ciudad, count: 1 });
                                return acc;
                            }, [] as { pais: string, ciudad: string, count: number }[]).map((item, idx) => (
                                <tr key={idx}>
                                    <td className="py-3 text-sm font-semibold text-neutral-textMain">{item.pais}</td>
                                    <td className="py-3 text-sm text-neutral-textSec">{item.ciudad}</td>
                                    <td className="py-3 text-sm font-bold text-neutral-textMain text-right">{item.count}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
};
