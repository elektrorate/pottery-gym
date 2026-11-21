import { useWorkshopActivities } from '../utils/useWorkshopActivities';
import React from 'react';
import { useData } from '../context/DataContext';
import DashboardView from '../components/DashboardView';
import { useNavigate } from 'react-router-dom';

const DashboardPage: React.FC = () => {
    const { students, sessions, giftCards, inventoryItems, capacityDefaults, workshopSchedule, workshopScheduleExceptions, loadError, businessDataReady, isLoadingData, loadAllData } = useData();
    const navigate = useNavigate();
    const agenda = useWorkshopActivities();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void loadAllData().catch(() => undefined)} className="min-h-11 px-3 underline">Reintentar carga</button></div>;

    return (
        <>
        {agenda.error && <p role="alert" className="mb-3 text-sm text-red-700">No se pudo actualizar la agenda. {agenda.error}<button onClick={() => void agenda.load().catch(() => undefined)} className="ml-2 underline">Reintentar</button></p>}
        {!agenda.ready && !agenda.error && <p role="status" className="mb-3 text-sm">Cargando actividades de agenda…</p>}
        <DashboardView
            students={students}
            activities={agenda.activities.filter(a => !a.deletedAt)}
            detailsReady={businessDataReady}
            activitiesReady={agenda.ready}
            sessions={sessions}
            giftCards={giftCards}
            inventoryItems={inventoryItems}
            onNavigate={(view) => navigate(`/${view}`)}
            onOpenStudentProfile={(studentId) => navigate(`/students?selected=${studentId}`)}
            onOpenSession={(sessionId, date) => navigate(`/calendar?sessionId=${encodeURIComponent(sessionId)}&date=${encodeURIComponent(date)}&attendance=1`)}
            capacityDefaults={capacityDefaults}
            workshopSchedule={workshopSchedule}
            workshopScheduleExceptions={workshopScheduleExceptions}
        />
        </>
    );
};

export default DashboardPage;
