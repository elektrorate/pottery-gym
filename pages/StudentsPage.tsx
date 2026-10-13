import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../context/DataContext';
import StudentList from '../components/StudentList';

const StudentsPage: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);

    const {
        students,
        addStudent,
        updateStudent,
        deleteStudent,
        renewStudent, confirmMembershipPayment, activateMembership, initializeLegacyMemberships, adjustMembershipClasses, canAdjustMembershipClasses,
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
            setSearchParams({}, { replace: true });
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

    return (
        <StudentList
            students={students}
            detailsLoading={!businessDataReady}
            onAddStudent={addStudent}
            onRenew={renewStudent}
            onConfirmPayment={confirmMembershipPayment}
            onActivateMembership={activateMembership}
            onInitializeLegacyMemberships={initializeLegacyMemberships}
            onAdjustClasses={adjustMembershipClasses}
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
