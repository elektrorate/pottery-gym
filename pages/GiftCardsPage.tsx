import SectionLoadBoundary from '../components/shared/SectionLoadBoundary';
import React, { useEffect, useRef, useState } from 'react';
import { useData } from '../context/DataContext';
import { useAuth } from '../context/AuthContext';
import GiftCardView from '../components/GiftCardView';

type GiftCardsTab = 'list' | 'designer';

const GiftCardsPage: React.FC = () => {
    const { giftCards, students, addGiftCard, updateGiftCard, deleteGiftCard, consumeGiftCard, cancelGiftCard, confirmGiftCardPayment, loadError, isLoadingData, loadAllData } = useData();
    const { sedeId } = useAuth();
    const [tab, setTab] = useState<GiftCardsTab>('list');
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

    const openTab = (next: GiftCardsTab) => {
        setTab(next);
        if (next === 'designer') setDesignerOpened(true);
        if (next === 'list' && needsReloadRef.current) {
            needsReloadRef.current = false;
            void loadAllData();
        }
    };

    const designerSrc = `/bonos-designer.html${sedeId ? `?sede=${encodeURIComponent(sedeId)}` : ''}`;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div role="tablist" aria-label="Bonos regalo" className="mb-3 flex shrink-0 gap-1 border-b border-neutral-border">
                {([['list', 'Bonos regalo'], ['designer', 'Diseñar bono regalo']] as [GiftCardsTab, string][]).map(([key, label]) => (
                    <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => openTab(key)}
                        className={`min-h-10 border-b-2 px-3 text-[12px] font-bold uppercase tracking-[0.12em] transition-colors ${tab === key ? 'border-brand text-brand' : 'border-transparent text-neutral-textHelper hover:text-brand'}`}>
                        {label}
                    </button>
                ))}
            </div>
            {/* Kept mounted once opened, so the design in progress is not lost when switching tabs. */}
            {designerOpened && (
                <iframe
                    title="Diseñador de bonos regalo"
                    src={designerSrc}
                    allow="web-share; clipboard-write"
                    className={`min-h-[80vh] w-full flex-1 rounded-xl border border-neutral-border bg-white ${tab === 'designer' ? '' : 'hidden'}`}
                />
            )}
            {tab === 'list' && (isLoadingData ? (
                <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                    Cargando datos...
                </div>
            ) : loadError ? <p role="alert">{loadError}</p> : (
                <SectionLoadBoundary sections={['gift_card_movements']}>
                <GiftCardView
                    giftCards={giftCards}
                    students={students}
                    onAddGiftCard={addGiftCard}
                    onUpdateGiftCard={updateGiftCard}
                    onConsumeGiftCard={consumeGiftCard}
                    onCancelGiftCard={cancelGiftCard}
                    onConfirmGiftCardPayment={confirmGiftCardPayment}
                    onDeleteGiftCard={deleteGiftCard}
                />
                </SectionLoadBoundary>
            ))}
        </div>
    );
};

export default GiftCardsPage;
