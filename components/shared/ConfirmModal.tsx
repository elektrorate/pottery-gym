import React, { useEffect, useId } from 'react';

interface ConfirmModalProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
    loading?: boolean;
    loadingText?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
    isOpen,
    title,
    message,
    confirmText = 'Eliminar',
    cancelText = 'Cancelar',
    isDestructive = true,
    loading = false,
    loadingText = 'Procesando...',
    onConfirm,
    onCancel
}) => {
    const titleId = useId();

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !loading) onCancel();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, loading, onCancel]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[300] flex items-center justify-center p-4 animate-fade-in" role="presentation">
            <div className="bg-white w-full max-w-md rounded-2xl p-5 md:p-6 soft-shadow relative text-center border border-neutral-border" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={e => e.stopPropagation()}>

                {isDestructive ? (
                    <div className="w-12 h-12 bg-[#F8E1DA] rounded-xl flex items-center justify-center mx-auto mb-5">
                        <svg className="w-6 h-6 text-[#9E3B2B]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </div>
                ) : (
                    <div className="w-12 h-12 bg-brand-soft rounded-xl flex items-center justify-center mx-auto mb-5">
                        <svg className="w-6 h-6 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                )}

                <h3 id={titleId} className="ui-section-title text-neutral-textMain mb-2">
                    {title}
                </h3>

                <p className="text-[14px] text-neutral-textSec mb-6 px-1 leading-relaxed">
                    {message}
                </p>

                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={loading}
                        className="flex-1 min-h-[44px] px-4 py-2.5 bg-white border border-neutral-border text-neutral-textSec rounded-[10px] font-semibold text-[14px] hover:border-arena transition-colors outline-none focus:ring-2 focus:ring-brand/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {cancelText}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={loading}
                        className={`flex-1 min-h-[44px] px-4 py-2.5 rounded-[10px] font-semibold text-[14px] text-white hover:opacity-90 transition-opacity outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${isDestructive ? 'bg-[#9E3B2B] focus:ring-[#9E3B2B]' : 'bg-brand focus:ring-brand'
                            }`}
                    >
                        {loading ? loadingText : confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
};
