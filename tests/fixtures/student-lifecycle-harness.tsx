import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import StudentList from '../../components/StudentList';
import DashboardView from '../../components/DashboardView';
import type { Student } from '../../types';

const base: Student = { id: '', name: '', phone: '', studentCategory: 'membresia', status: 'membresia', paymentStatus: 'paid', expiryDate: '2026-10-10', classesRemaining: 4, bonosAsignados: 4 };
const fixtures: Student[] = [
  { ...base, id: 'active', name: 'ACTIVO SIN CLASES', expiryDate: '2026-11-01', classesRemaining: 0 },
  { ...base, id: 'pending', name: 'PENDIENTE DIA CINCO', expiryDate: '2026-10-11' },
  { ...base, id: 'inactive', name: 'INACTIVO DIA SEIS' },
  { ...base, id: 'temporary', name: 'TEMPORAL SIN CLASES', studentCategory: 'temporal', classesRemaining: 0, bonosAsignados: 1 },
  { ...base, id: 'legacy', name: 'TEMPORAL HISTORICO', studentCategory: 'temporal', classesRemaining: 3, bonosAsignados: 3, paymentStatus: undefined, archivedAt: '2026-01-01' },
  { ...base, id: 'archived-member', name: 'MEMBRESIA ARCHIVADA', archivedAt: '2026-01-01', expiryDate: '2026-11-01', paymentStatus: undefined }
];

const Harness = () => {
  const [students, setStudents] = useState(fixtures);
  const [saved, setSaved] = useState<unknown>(null);
  const [dashboard, setDashboard] = useState(false);
  const update = async (id: string, changes: Partial<Student>) => {
    setSaved(changes);
    setStudents(current => current.map(s => s.id === id ? { ...s, ...changes } : s));
  };
  const noop = async () => {};
  return <>
    <button onClick={() => setDashboard(!dashboard)}>Cambiar pantalla de prueba</button>
    <output data-testid="saved">{JSON.stringify(saved)}</output>
    {dashboard ? <DashboardView students={students} sessions={[]} giftCards={[]} onUpdateStudent={update} onUpdateSession={noop} onRedeemGiftCardSession={noop} onReverseGiftCardSession={noop} onNavigate={() => {}} onOpenStudentProfile={() => {}} /> :
      <StudentList students={students} onUpdate={update} onAddStudent={async s => { setSaved(s); setStudents(current => [...current, { ...s, id: 'created' }]); }} onRenew={noop} onDeleteStudent={async id => setStudents(current => current.filter(s => s.id !== id))} />}
  </>;
};
createRoot(document.getElementById('root')!).render(<Harness />);
