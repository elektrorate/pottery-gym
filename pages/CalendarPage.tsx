import React from 'react';
import { useData } from '../context/DataContext';
import CalendarView from '../components/CalendarView';

const CalendarPage: React.FC = () => {
    const { sessions, giftCards, addSession, updateSession, deleteSession, students, teachers, updateStudent, redeemGiftCardSession, reverseGiftCardSession, workshopSchedule, workshopScheduleExceptions, capacityDefaults, isLoadingData } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    return (
        <CalendarView
            sessions={sessions}
            onAddSession={addSession}
            onUpdateSession={updateSession}
            onDeleteSession={deleteSession}
            onUpdateStudent={updateStudent}
            onRedeemGiftCardSession={redeemGiftCardSession}
            onReverseGiftCardSession={reverseGiftCardSession}
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
