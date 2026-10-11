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
        renewStudent, confirmMembershipPayment, activateMembership, adjustMembershipClasses,
        loadError,
        isLoadingData
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

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <p role="alert">{loadError}</p>;

    return (
        <StudentList
            students={students}
            onAddStudent={addStudent}
            onRenew={renewStudent}
            onConfirmPayment={confirmMembershipPayment}
            onActivateMembership={activateMembership}
            onAdjustClasses={adjustMembershipClasses}
            onUpdate={updateStudent}
            onDeleteStudent={deleteStudent}
            selectedStudentId={selectedStudentId}
            onClearSelectedStudent={handleClearSelectedStudent}
        />
    );
};

export default StudentsPage;
