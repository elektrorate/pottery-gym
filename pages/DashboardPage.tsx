import React from 'react';
import { useData } from '../context/DataContext';
import DashboardView from '../components/DashboardView';
import { useNavigate } from 'react-router-dom';

const DashboardPage: React.FC = () => {
    const { students, sessions, giftCards, updateStudent, updateSession, redeemGiftCardSession, reverseGiftCardSession, adjustMembershipClasses, capacityDefaults, workshopSchedule, workshopScheduleExceptions, loadError, isLoadingData } = useData();
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
            onUpdateStudent={updateStudent}
            onAdjustClasses={adjustMembershipClasses}
            onUpdateSession={updateSession}
            onRedeemGiftCardSession={redeemGiftCardSession}
            onReverseGiftCardSession={reverseGiftCardSession}
            onNavigate={(view) => navigate(`/${view}`)}
            onOpenStudentProfile={(studentId) => navigate(`/students?selected=${studentId}`)}
            capacityDefaults={capacityDefaults}
            workshopSchedule={workshopSchedule}
            workshopScheduleExceptions={workshopScheduleExceptions}
        />
    );
};

export default DashboardPage;
