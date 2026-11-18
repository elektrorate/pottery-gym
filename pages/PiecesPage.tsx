import SectionLoadBoundary from '../components/shared/SectionLoadBoundary';
import React from 'react';
import { useData } from '../context/DataContext';
import PiecesToCollect from '../components/PiecesToCollect';

const PiecesPage: React.FC = () => {
    const { pieces, students, addPiece, updatePiece, deletePiece, isLoadingData } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    return (
        <SectionLoadBoundary sections={["pieces"]}>
        <PiecesToCollect
            pieces={pieces}
            students={students}
            onAddPiece={addPiece}
            onUpdatePiece={updatePiece}
            onDeletePiece={deletePiece}
        />
        </SectionLoadBoundary>
    );
};

export default PiecesPage;
