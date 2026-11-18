import React from 'react';
import { useData } from '../../context/DataContext';
import type { SecondarySection } from '../../utils/sectionLoading';

export default function SectionLoadBoundary({ sections, children }: { sections: SecondarySection[]; children: React.ReactNode }) {
  const { sectionLoads, retrySection } = useData();
  const states = sections.map(key => ({ key, state: sectionLoads[key] }));
  const blocked = states.some(({ state }) => !state?.hasData);
  const errors = states.filter(({ state }) => state?.status === 'error');
  return <>
    {errors.length > 0 && <div role="alert" className="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p>Error de carga. {errors[0].state?.error}</p>
      {!blocked && <p>Se conserva la última información cargada. Puede estar desactualizada.</p>}
      <button type="button" className="mt-2 min-h-10 rounded-lg border border-red-300 px-3" onClick={() => void Promise.all(errors.map(({ key }) => retrySection(key))).catch(() => undefined)}>Reintentar esta sección</button>
    </div>}
    {blocked ? errors.length === 0 && <p role="status" className="p-6 text-sm text-neutral-textHelper">Cargando esta sección…</p> : <>
      {states.some(({ state }) => state?.status === 'refreshing') && <p role="status" className="px-4 text-sm text-neutral-textHelper">Actualizando información…</p>}
      {children}
    </>}
  </>;
}
