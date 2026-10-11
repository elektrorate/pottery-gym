import React from 'react';
import { useData } from '../context/DataContext';
import DashboardView from '../components/DashboardView';
import { useNavigate } from 'react-router-dom';

const DashboardPage: React.FC = () => {
    const { students, sessions, giftCards, capacityDefaults, workshopSchedule, workshopScheduleExceptions, loadError, isLoadingData } = useData();
    const navigate = useNavigate();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <p role="alert">{loadError}</p>;

    return (
        <DashboardView
            students={students}
            sessions={sessions}
            giftCards={giftCards}
            onNavigate={(view) => navigate(`/${view}`)}
            onOpenStudentProfile={(studentId) => navigate(`/students?selected=${studentId}`)}
            onOpenSession={(sessionId, date) => navigate(`/calendar?sessionId=${encodeURIComponent(sessionId)}&date=${encodeURIComponent(date)}&attendance=1`)}
            capacityDefaults={capacityDefaults}
            workshopSchedule={workshopSchedule}
            workshopScheduleExceptions={workshopScheduleExceptions}
        />
    );
};

export default DashboardPage;
