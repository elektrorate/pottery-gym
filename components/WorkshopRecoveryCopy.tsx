import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabaseClient';
import { withTimeout } from '../context/data/shared';
import { compareSnapshots, sealSnapshot, verifySnapshot } from '../utils/workshopSnapshot';
import { AdvancedDetails } from './shared/AdvancedDetails';

export default function WorkshopRecoveryCopy() {
  const { sedeId } = useAuth(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [comparison, setComparison] = useState<ReturnType<typeof compareSnapshots>>();
  const read = async () => {
    if (!sedeId) throw new Error('Selecciona el taller antes de continuar.');
    const { data, error } = await withTimeout('workshop.snapshot', supabase.rpc('export_workshop_snapshot', { p_sede_id: sedeId }));
    if (error) throw error; return sealSnapshot(data);
  };
  const download = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const copy = await read(); const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `recuperacion_taller_${copy.created_at?.toString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Copia lista: ${Object.keys(copy.data).length} apartados. Guárdela en un lugar privado.`);
    } catch (e: any) { setError(e.message || 'No se pudo generar la copia. No se ha descargado una copia completa.'); } finally { setBusy(false); }
  };
  const preview = async (file?: File) => {
    if (!file) return; setBusy(true); setError(''); setMessage(''); setComparison(undefined);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('La copia supera 50 MB. Pida la recuperación asistida.');
      const incoming = await verifySnapshot(JSON.parse(await file.text())); const current = await read(); setComparison(compareSnapshots(current, incoming));
      setMessage('Simulación: no se ha cambiado nada. Revise las diferencias antes de restaurar.');
    } catch (e: any) { setError(e.message || 'No se pudo verificar esta copia.'); } finally { setBusy(false); }
  };
  return <section className="mt-4 rounded-xl border border-neutral-border bg-white p-4">
    <h3 className="font-semibold text-neutral-textMain">Copia para restaurar</h3>
    <p className="my-2 text-sm text-neutral-textHelper">Descargue una copia del taller. No incluye cuentas ni contraseñas.</p>
    <button type="button" disabled={busy} onClick={() => void download()} className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Comprobando…' : 'Descargar copia de recuperación'}</button>
    <label className="mt-4 block text-sm text-neutral-textMain">Simular recuperación de una copia<input type="file" accept=".json,application/json" disabled={busy} onChange={e => void preview(e.target.files?.[0])} className="mt-2 block w-full text-sm" /></label>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{message && <p role="status" className="mt-3 text-sm text-neutral-textHelper">{message}</p>}
    {comparison && <AdvancedDetails><p>Diferencias de la simulación. No restaure nada desde aquí.</p><div className="mt-2 max-h-80 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th>Apartado</th><th>Nuevos</th><th>Distintos</th><th>Iguales</th><th>Solo aquí</th></tr></thead><tbody>{comparison.map(row => <tr key={row.table}><td className="py-1">{row.table}</td><td>{row.added}</td><td>{row.changed}</td><td>{row.identical}</td><td>{row.destinationOnly}</td></tr>)}</tbody></table></div></AdvancedDetails>}
  </section>;
}
