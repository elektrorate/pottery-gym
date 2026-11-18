import React, { useEffect, useRef, useState } from 'react';
import { useData } from '../context/DataContext';
import { useAuth } from '../context/AuthContext';
import GiftCardView from '../components/GiftCardView';

const GiftCardsPage: React.FC = () => {
    const { giftCards, students, addGiftCard, updateGiftCard, deleteGiftCard, consumeGiftCard, cancelGiftCard, confirmGiftCardPayment, loadError, isLoadingData, loadAllData } = useData();
    const { sedeId } = useAuth();
    const [designerOpen, setDesignerOpen] = useState(false);
    const [designerOpened, setDesignerOpened] = useState(false);
    // The Casa Rosier designer (iframe, same origin) reports new or cancelled bonos.
    const needsReloadRef = useRef(false);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.data && event.data.type === 'bonos-designer:saved') needsReloadRef.current = true;
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const openDesigner = () => {
        setDesignerOpened(true);
        setDesignerOpen(true);
    };

    const closeDesigner = () => {
        setDesignerOpen(false);
        if (needsReloadRef.current) {
            needsReloadRef.current = false;
            void loadAllData();
        }
    };

    const designerSrc = `/bonos-designer.html${sedeId ? `?sede=${encodeURIComponent(sedeId)}` : ''}`;

    const designButton = (
        <button
            type="button"
            onClick={openDesigner}
            className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-brand-hover"
        >
            Diseñar bono
        </button>
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            {isLoadingData ? (
                <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                    Cargando datos...
                </div>
            ) : loadError ? <p role="alert">{loadError}</p> : (
                <GiftCardView
                    giftCards={giftCards}
                    students={students}
                    onAddGiftCard={addGiftCard}
                    onUpdateGiftCard={updateGiftCard}
                    onConsumeGiftCard={consumeGiftCard}
                    onCancelGiftCard={cancelGiftCard}
                    onConfirmGiftCardPayment={confirmGiftCardPayment}
                    onDeleteGiftCard={deleteGiftCard}
                    headerActions={designButton}
                />
            )}
            {/* Kept mounted once opened, so the design in progress is not lost when returning to the list. */}
            {designerOpened && (
                <div
                    className={`fixed inset-0 z-[120] flex flex-col bg-neutral-base ${designerOpen ? '' : 'hidden'}`}
                    role="dialog"
                    aria-modal={designerOpen}
                    aria-label="Diseñador de bonos Casa Rosier"
                    hidden={!designerOpen}
                >
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-border bg-white px-4 py-3 md:px-8">
                        <div>
                            <h2 className="ui-page-title text-neutral-textMain">Diseñar bono</h2>
                            <p className="ui-meta">Gift Card Casa Rosier</p>
                        </div>
                        <button
                            type="button"
                            onClick={closeDesigner}
                            className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-[10px] border border-neutral-border bg-white px-4 py-2 text-[13px] font-semibold text-neutral-textSec transition hover:border-arena hover:text-brand"
                        >
                            Volver a bonos
                        </button>
                    </div>
                    <iframe
                        title="Diseñador de bonos Casa Rosier"
                        src={designerSrc}
                        allow="web-share; clipboard-write"
                        className="min-h-0 w-full flex-1 bg-white"
                    />
                </div>
            )}
        </div>
    );
};

export default GiftCardsPage;
