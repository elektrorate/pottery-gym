import React from 'react';
import { useData } from '../context/DataContext';
import CalendarView from '../components/CalendarView';

const CalendarPage: React.FC = () => {
    const { sessions, giftCards, addSession, updateSession, students, teachers, workshopSchedule, workshopScheduleExceptions, capacityDefaults, loadError, isLoadingData } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <p role="alert">{loadError}</p>;

    return (
        <CalendarView
            sessions={sessions}
            onAddSession={addSession}
            onUpdateSession={updateSession}
            giftCards={giftCards}
            students={students}
            teachers={teachers}
            workshopSchedule={workshopSchedule}
            workshopScheduleExceptions={workshopScheduleExceptions}
            capacityDefaults={capacityDefaults}
        />
    );
};

export default CalendarPage;
