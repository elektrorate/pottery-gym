import React from 'react';
import { useData } from '../context/DataContext';
import GiftCardView from '../components/GiftCardView';

const GiftCardsPage: React.FC = () => {
    const { giftCards, students, addGiftCard, updateGiftCard, deleteGiftCard, consumeGiftCard, cancelGiftCard, confirmGiftCardPayment, loadError, isLoadingData } = useData();

    if (isLoadingData) {
        return (
            <div className="h-full flex items-center justify-center text-neutral-textHelper uppercase text-[12px] tracking-widest">
                Cargando datos...
            </div>
        );
    }

    if (loadError) return <p role="alert">{loadError}</p>;

    return (
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
    );
};

export default GiftCardsPage;
