import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TeachersView from '../../components/TeachersView';
import CalendarView from '../../components/CalendarView';
import type { ClassSession, Teacher } from '../../types';
import '../../app.css';

const teachers: Teacher[] = [
  { id: 'ana', name: 'Ana', surname: 'Mesa', specialty: 'Modelado', email: 'ana@ejemplo.test' },
  { id: 'luis', name: 'Luis', surname: 'Torno', specialty: 'Torno', email: 'luis@ejemplo.test' }
];

const sessions: ClassSession[] = [
  {
    id: 'mesa-proxima', date: '2026-11-21', startTime: '10:00', endTime: '12:00',
    classType: 'mesa', capacity: 8, students: ['Alumna Ejemplo'], studentIds: ['alumna'],
    teacherId: 'ana', revision: 1
  },
  {
    id: 'mixta-proxima', date: '2026-11-24', startTime: '18:00', endTime: '20:00',
    classType: 'mixto', capacity: 6, students: ['Alumno Mesa', 'Alumno Torno'],
    studentIds: ['mesa', 'torno'], revision: 1,
    activityBlocks: [
      { id: 'bloque-mesa', activityType: 'mesa', teacherId: 'ana', capacity: 4, studentIds: ['mesa'] },
      { id: 'bloque-torno', activityType: 'torno', teacherId: 'luis', capacity: 2, studentIds: ['torno'] }
    ]
  },
  {
    id: 'mesa-concluida', date: '2026-11-12', startTime: '10:00', endTime: '12:00',
    classType: 'mesa', capacity: 8, students: ['Alumna Ejemplo'], studentIds: ['alumna'],
    teacherId: 'ana', completedAt: '2026-11-12T12:00:00Z', revision: 2
  },
  {
    id: 'torno-ajena', date: '2026-11-22', startTime: '16:00', endTime: '18:00',
    classType: 'torno', capacity: 4, students: ['Otra persona'], studentIds: ['otra'],
    teacherId: 'otra-profe', revision: 1
  }
];

function CalendarProbe() {
  const location = useLocation();
  return (
    <div className="h-screen bg-neutral-base">
      <p className="px-4 pt-3 text-[12px] text-neutral-textHelper">Datos de ejemplo · no conectado a producción · {location.pathname}{location.search}</p>
      <div className="h-[calc(100vh-2rem)]">
        <CalendarView
          sessions={sessions}
          teachers={teachers}
          students={[]}
          giftCards={[]}
          workshopSchedule={[]}
          workshopScheduleExceptions={[]}
          capacityDefaults={[]}
          onAddSession={async () => undefined}
          onUpdateSession={async () => true}
        />
      </div>
    </div>
  );
}

function Harness() {
  const [view, setView] = useState<'teachers' | 'calendar'>('teachers');
  return (
    <div className="min-h-screen bg-neutral-base">
      <p className="px-4 pt-3 text-[12px] text-neutral-textHelper">Datos de ejemplo · no conectado a producción</p>
      <nav className="flex gap-2 px-4 py-3">
        <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => setView('teachers')}>Profesores</button>
        <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => setView('calendar')}>Clases</button>
      </nav>
      {view === 'teachers' ? (
        <div className="h-[860px]">
          <TeachersView teachers={teachers} sessions={sessions} onAddTeacher={async () => undefined} onUpdateTeacher={async () => undefined} onDeleteTeacher={async () => undefined} />
        </div>
      ) : <CalendarProbe />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/teachers']}>
    <Routes>
      <Route path="/teachers" element={<Harness />} />
      <Route path="/calendar" element={<CalendarProbe />} />
    </Routes>
  </MemoryRouter>
);
