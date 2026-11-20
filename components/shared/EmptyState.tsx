import React from 'react';

interface EmptyStateProps {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** Explains an empty list and offers the next step. Filter copy belongs only in `body`. */
export const EmptyState: React.FC<EmptyStateProps> = ({ title, body, actionLabel, onAction }) => (
  <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
    <p className="text-[16px] font-semibold text-neutral-textMain">{title}</p>
    <p className="mt-2 max-w-md text-[15px] leading-relaxed text-neutral-textSec">{body}</p>
    {actionLabel && onAction && (
      <button
        type="button"
        onClick={onAction}
        className="mt-5 inline-flex min-h-11 items-center justify-center rounded-[10px] bg-brand px-4 text-[14px] font-semibold text-white hover:bg-brand-hover"
      >
        {actionLabel}
      </button>
    )}
  </div>
);
