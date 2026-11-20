import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../context/DataContext';
import StudentList from '../components/StudentList';
import { enrollmentOnDate } from '../utils/sessionCapacity';

const StudentsPage: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);

    const {
        students,
        sessions,
        giftCards,
        addStudent,
        updateStudent,
        deleteStudent,
        renewStudent, confirmMembershipPayment, activateMembership, adjustMembershipClasses, adjustRemainingClasses, canAdjustMembershipClasses,
        approveStudentManualCredit, settlePendingStudentPenalty, waiveStudentPenalty, canManageStudentCredits,
        getPendingStudentCreditOperation, retryPendingStudentCreditOperation, loadAllData, loadError,
        isLoadingData, businessDataReady
    } = useData();

    // Handle selected student from URL params
    useEffect(() => {
        const selected = searchParams.get('selected');
        if (selected) {
            setSelectedStudentId(selected);
            // Clear the param after reading it
            const next = new URLSearchParams(searchParams); next.delete('selected'); setSearchParams(next, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    const handleClearSelectedStudent = () => {
        setSelectedStudentId(null);
    };

    // La lista básica no debe quedar bloqueada por las proyecciones de bonos,
    // asistencias y pagos. Esas proyecciones se completan en segundo plano.
    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" className="min-h-11 rounded border px-3" onClick={() => void loadAllData().catch(() => undefined)}>Recargar datos sin repetir escrituras</button></div>;

    const enrolledOn = searchParams.get('enrolled');
    const listPreset = searchParams.get('payment') === 'pending' ? 'payment'
        : searchParams.get('classes') === 'low' ? 'low-classes'
        : enrolledOn ? 'enrolled' : null;
    const category = searchParams.get('category');
    const tab = searchParams.get('tab');

    return (
        <StudentList
            students={students}
            giftCards={giftCards}
            reviewOnly={searchParams.get('review') === '1'}
            listPreset={listPreset}
            enrolledStudentIds={enrolledOn ? [...enrollmentOnDate(sessions, enrolledOn).studentIds] : undefined}
            initialCategory={category === 'membresia' || category === 'temporal' || category === 'grupal' || category === 'grupo_temporal' || category === 'archivados' || category === 'todos' ? category : undefined}
            initialTab={tab === 'all' || tab === 'active' || tab === 'pending' || tab === 'expired' ? tab : undefined}
            onClearListPreset={() => {
                const next = new URLSearchParams(searchParams);
                ['payment', 'classes', 'enrolled', 'category', 'tab'].forEach(key => next.delete(key));
                setSearchParams(next, { replace: true });
            }}
            detailsLoading={!businessDataReady}
            onAddStudent={addStudent}
            onRenew={renewStudent}
            onConfirmPayment={confirmMembershipPayment}
            onActivateMembership={activateMembership}
            onAdjustClasses={adjustMembershipClasses}
            onAdjustRemainingClasses={adjustRemainingClasses}
            canAdjustClasses={canAdjustMembershipClasses}
            onApproveManualCredit={approveStudentManualCredit}
            onSettlePendingPenalty={settlePendingStudentPenalty}
            onWaivePendingPenalty={waiveStudentPenalty}
            canManageStudentCredits={canManageStudentCredits}
            getPendingStudentCreditOperation={getPendingStudentCreditOperation}
            onRetryPendingStudentCreditOperation={retryPendingStudentCreditOperation}
            onUpdate={updateStudent}
            onDeleteStudent={deleteStudent}
            selectedStudentId={selectedStudentId}
            onClearSelectedStudent={handleClearSelectedStudent}
        />
    );
};

export default StudentsPage;
