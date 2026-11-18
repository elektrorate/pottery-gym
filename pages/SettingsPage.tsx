import SectionLoadBoundary from '../components/shared/SectionLoadBoundary';
import React from 'react';
import { useData } from '../context/DataContext';
import SettingsView from '../components/SettingsView';

const SettingsPage: React.FC = () => {
    const { isLoadingData } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    return <SectionLoadBoundary sections={["workshop_schedules","workshop_capacity_defaults","workshop_schedule_exceptions"]}><SettingsView /></SectionLoadBoundary>;
};

export default SettingsPage;
