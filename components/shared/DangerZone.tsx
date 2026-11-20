import React from 'react';

interface DangerZoneProps {
  description: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}

/** Destructive action, kept away from Editar and other primary buttons. */
export const DangerZone: React.FC<DangerZoneProps> = ({ description, actionLabel, onAction, disabled }) => (
  <div className="mt-5 rounded-xl border border-[#EFC9BE] bg-[#FFF8F5] px-4 py-4">
    <p className="text-[14px] font-semibold text-[#9E3B2B]">Zona de peligro</p>
    <p className="mt-1 text-[14px] leading-relaxed text-neutral-textSec">{description}</p>
    <button
      type="button"
      disabled={disabled}
      onClick={onAction}
      className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[10px] border border-[#EFC9BE] bg-white px-4 text-[14px] font-semibold text-[#9E3B2B] hover:bg-[#F8E1DA] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {actionLabel}
    </button>
  </div>
);
