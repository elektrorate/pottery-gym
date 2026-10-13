import React from 'react';
import { useData } from '../context/DataContext';
import CalendarView from '../components/CalendarView';

const CalendarPage: React.FC = () => {
    const { sessions, giftCards, addSession, updateSession, students, teachers, workshopSchedule, workshopScheduleExceptions,
        capacityDefaults, approveSessionException, cancelSessionReservation, waiveSessionPenalty, canWaiveSessionPenalty,
        getPendingSessionOperation, retryPendingSessionOperation, loadAllData, loadError, isLoadingData, businessDataReady } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" className="min-h-11 rounded border px-3" onClick={() => void loadAllData().catch(() => undefined)}>Recargar datos sin repetir escrituras</button></div>;

    return (
        <>
        {!businessDataReady && <p role="status" className="text-[12px] text-neutral-textHelper">Cargando datos de negocio. El calendario es de solo lectura.</p>}
        <CalendarView
            readOnly={!businessDataReady}
            sessions={sessions}
            onAddSession={addSession}
            onUpdateSession={updateSession}
            onApproveSessionException={approveSessionException}
            onCancelSessionReservation={cancelSessionReservation}
            onWaiveSessionPenalty={waiveSessionPenalty}
            canWaiveSessionPenalty={canWaiveSessionPenalty}
            getPendingSessionOperation={getPendingSessionOperation}
            onRetryPendingSessionOperation={retryPendingSessionOperation}
            giftCards={giftCards}
            students={students}
            teachers={teachers}
            workshopSchedule={workshopSchedule}
            workshopScheduleExceptions={workshopScheduleExceptions}
            capacityDefaults={capacityDefaults}
        />
        </>
    );
};

export default CalendarPage;
