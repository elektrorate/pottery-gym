import SectionLoadBoundary from '../components/shared/SectionLoadBoundary';
import React from 'react';
import { useData } from '../context/DataContext';
import InventoryView from '../components/InventoryView';

const InventoryPage: React.FC = () => {
    const { inventoryItems, inventoryMovements, addInventoryItem, updateInventoryItem, archiveInventoryItem, deleteInventoryItem, addInventoryMovement, loadAllData, isLoadingData } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    return (
        <SectionLoadBoundary sections={["inventory_items","inventory_movements"]}>
        <InventoryView
            items={inventoryItems}
            movements={inventoryMovements}
            onAddItem={addInventoryItem}
            onUpdateItem={updateInventoryItem}
            onArchiveItem={archiveInventoryItem}
            onDeleteItem={deleteInventoryItem}
            onAddMovement={addInventoryMovement}
            onReload={loadAllData}
        />
        </SectionLoadBoundary>
    );
};

export default InventoryPage;
