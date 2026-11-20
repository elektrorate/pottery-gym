import React, { useEffect, useId, useState } from 'react';

const REASON_SUGGESTIONS = ['Corrección', 'Clase de cortesía', 'Recuperación'];

interface ClassAdjustmentDialogProps {
  current: number;
  next: number;
  loading?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export const ClassAdjustmentDialog: React.FC<ClassAdjustmentDialogProps> = ({
  current, next, loading = false, onConfirm, onCancel
}) => {
  const titleId = useId();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && trimmed.length <= 200 && !loading;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [loading, onCancel]);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[300] flex items-center justify-center p-4" role="presentation">
      <div className="bg-white w-full max-w-md rounded-2xl p-5 md:p-6 soft-shadow border border-neutral-border" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="class-adjustment-dialog" onClick={event => event.stopPropagation()}>
        <h3 id={titleId} className="ui-section-title text-neutral-textMain mb-2">¿Ajustar clases?</h3>
        <p className="text-[14px] text-neutral-textSec leading-relaxed">
          Clases restantes: <strong className="text-neutral-textMain tabular-nums">{current}</strong>
          <span aria-hidden="true"> → </span>
          <strong className="text-neutral-textMain tabular-nums">{next}</strong>
        </p>
        <label className="mt-4 block text-[13px] font-semibold text-neutral-textMain" htmlFor={`${titleId}-reason`}>Motivo</label>
        <input id={`${titleId}-reason`} value={reason} maxLength={200} disabled={loading} onChange={event => setReason(event.target.value)} placeholder="Escribe un motivo" aria-label="Motivo del ajuste" className="mt-1.5 h-11 w-full rounded-md border border-neutral-border bg-white px-3 text-[14px] text-neutral-textMain outline-none focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:opacity-60" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {REASON_SUGGESTIONS.map(suggestion => (
            <button key={suggestion} type="button" disabled={loading} onClick={() => setReason(suggestion)} className="min-h-9 rounded-full border border-neutral-border bg-neutral-alt px-3 text-[12px] font-semibold text-neutral-textMain hover:border-brand hover:text-brand disabled:opacity-50">
              {suggestion}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-neutral-textHelper">El motivo es obligatorio.</p>
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={onCancel} disabled={loading} className="flex-1 min-h-[44px] rounded-[10px] border border-neutral-border bg-white px-4 text-[14px] font-semibold text-neutral-textSec hover:border-arena disabled:opacity-50">Cancelar</button>
          <button type="button" onClick={() => { if (canConfirm) onConfirm(trimmed); }} disabled={!canConfirm} className="flex-1 min-h-[44px] rounded-[10px] bg-brand px-4 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {loading ? 'Guardando...' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
};
