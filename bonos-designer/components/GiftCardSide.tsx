import React, { useLayoutEffect, useRef } from 'react';
import { classesCountLabel } from '../lib/giftCardDefaults';
import { CARD_PX_HEIGHT, CARD_PX_WIDTH } from '../lib/pdfLayout';
import { GiftCardData } from '../types';

interface GiftCardSideProps {
  side: 1 | 2;
  data: GiftCardData;
}

/**
 * Portrait card face, laid out at a fixed 480 × 758.4 CSS px (120.25 × 190 mm).
 * `lib/giftCardPdf.ts` paints the same boxes for the bot PDF; keep both in sync.
 */
export const GiftCardSide: React.FC<GiftCardSideProps> = ({ side, data }) => {
  const frontFrameRef = useRef<HTMLDivElement>(null);
  const frontContentRef = useRef<HTMLDivElement>(null);
  const bulletsAreaRef = useRef<HTMLDivElement>(null);
  const bulletsListRef = useRef<HTMLUListElement>(null);

  // Front: shrink the whole text block (like the PDF `fit`) when long names or
  // messages would not fit inside the frame. Nothing is ever cut.
  useLayoutEffect(() => {
    const frame = frontFrameRef.current;
    const content = frontContentRef.current;
    if (!frame || !content) return;
    const available = frame.clientHeight - 56;
    let fit = 1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      content.style.width = `${100 / fit}%`;
      content.style.transform = fit < 1 ? `scale(${fit})` : '';
      const natural = content.offsetHeight * fit;
      if (natural <= available + 0.5 || fit < 0.6) break;
      fit *= (available / natural) * 0.98;
    }
  }, [side, data]);

  // Back: shrink the bullet text when the four lines are very long.
  useLayoutEffect(() => {
    const area = bulletsAreaRef.current;
    const list = bulletsListRef.current;
    if (!area || !list) return;
    let size = 12;
    list.style.fontSize = `${size}px`;
    while (size > 9 && area.scrollHeight > area.clientHeight + 0.5) {
      size -= 0.5;
      list.style.fontSize = `${size}px`;
    }
  }, [side, data]);

  const cardClasses =
    `relative overflow-hidden border border-[#ebe2d9] p-7 text-[#1f2430] ${side === 2 ? 'bg-white' : 'bg-[#fdfcfa]'}`;
  const cardStyle: React.CSSProperties = { width: CARD_PX_WIDTH, height: CARD_PX_HEIGHT };
  const cornerClasses = 'absolute w-8 h-8';
  // Triangles drawn with gradients: html2canvas ignores CSS clipping (it printed squares).
  const corner = (angle: number): React.CSSProperties => ({
    backgroundImage: `linear-gradient(${angle}deg, #f1ddce 50%, transparent 50%)`
  });

  if (side === 1) {
    return (
      <div className={cardClasses} style={cardStyle}>
        <div className={`${cornerClasses} top-0 left-0`} style={corner(135)} />
        <div className={`${cornerClasses} top-0 right-0`} style={corner(225)} />
        <div className={`${cornerClasses} bottom-0 left-0`} style={corner(45)} />
        <div className={`${cornerClasses} bottom-0 right-0`} style={corner(315)} />

        <div className="relative z-10 h-full">
          <div
            ref={frontFrameRef}
            className="w-full h-full border border-[#efe6dc] px-8 py-7 flex flex-col items-center justify-center overflow-hidden"
          >
            <div ref={frontContentRef} className="w-full shrink-0 origin-center text-center">
              <p className="text-[9.2px] leading-[13.8px] uppercase tracking-[0.35em] text-[#a34f20] font-medium">{data.title}</p>
              <div className="mt-3 h-[15px] flex items-center justify-center gap-4 text-[#d9c8b8]">
                <span className="h-px w-10 bg-[#dfc8b7]" />
                <span className="text-[10px] leading-[15px]">◎</span>
                <span className="h-px w-10 bg-[#dfc8b7]" />
              </div>
              <h3 className="serif text-[30px] leading-none mt-4 text-[#1b2330] tracking-tight">{data.subtitle}</h3>
              {data.subtitle2 ? (
                <p className="serif text-[22px] leading-none mt-2 text-[#4a4f58] tracking-tight">{data.subtitle2}</p>
              ) : null}

              <p className="mt-10 text-[12.65px] leading-[18.975px] uppercase tracking-[0.25em] text-[#a34f20]">{data.introText}</p>
              <p className="serif text-[34px] mt-2 text-[#1d2330] leading-none tracking-tight break-words px-1">
                <span className="text-[#e0cdbd] text-[13px] mr-3 align-middle">✦</span>
                {data.recipientName || 'Nombre Destinatario'}
                <span className="text-[#e0cdbd] text-[13px] ml-3 align-middle">✦</span>
              </p>

              <p className="mt-5 text-[14px] leading-[22.75px] italic text-[#626773] max-w-[90%] mx-auto whitespace-pre-line break-words">{data.mainQuote}</p>

              <div className="mt-8 h-4 flex items-center justify-center gap-4 text-[#dbc9b9]">
                <span className="h-px w-10 bg-[#dfc8b7]" />
                <span className="text-xs leading-4">• • •</span>
                <span className="h-px w-10 bg-[#dfc8b7]" />
              </div>

              <p className="mt-5 text-[10.6px] leading-[15.9px] uppercase tracking-[0.25em] text-[#a34f20]">{data.fromLabel}</p>
              <p className="serif text-[34px] mt-2 leading-none tracking-tight break-words px-1">{data.donorName || 'Nombre Remitente'}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cardClasses} style={cardStyle}>
      <div className={`${cornerClasses} top-0 left-0`} style={corner(135)} />
      <div className={`${cornerClasses} top-0 right-0`} style={corner(225)} />

      <div className="relative z-10 h-full flex flex-col">
        <div className="text-center shrink-0">
          <h2 className="serif text-[32px] leading-[38px] text-[#1b2330]">{data.experienceTitle}</h2>
          <div className="mt-2 h-4 flex items-center justify-center gap-4 text-[#d9c8b8]">
            <span className="h-px w-10 bg-[#dfc8b7]" />
            <span className="text-xs leading-4">•</span>
            <span className="h-px w-10 bg-[#dfc8b7]" />
          </div>
        </div>

        <div className="mt-4 shrink-0 border border-[#ead7c8] p-4 text-center">
          <p className="text-[12px] leading-[18px]">{data.includesLabel}</p>
          <p className="mt-4 serif classes-hours-row text-[#b95d12] leading-[1.12] whitespace-nowrap">
            <span className="classes-main text-[44px]">{classesCountLabel(data.numberOfClasses)}</span>
            <span className="classes-hours text-[30px] ml-2 align-baseline">- {data.sessionDuration} h</span>
          </p>
          <p className="mt-6 text-[14px] leading-[21px] text-[#4a4f58]">Fecha de emisión: {data.creationDate}</p>
          {data.voucherCode ? (
            <p className="mt-2 text-[12px] leading-[18px] tracking-[0.08em] text-[#1f2430]">
              Código: <span className="font-semibold">{data.voucherCode}</span>
            </p>
          ) : null}
          <p className="serif text-[19px] leading-none mt-3 text-[#4a4f58]">
            Válida por: {data.validityText.replace(/^.*?:\s*/i, '')}
          </p>
        </div>

        <div ref={bulletsAreaRef} className="mt-5 flex-1 min-h-0 overflow-hidden pb-4">
          <p className="text-[11px] leading-[16.5px] uppercase tracking-[0.2em] text-[#b95d12] font-semibold">{data.contactSubtitle}</p>
          <ul ref={bulletsListRef} className="mt-3 space-y-2 text-[12px] leading-[1.625]">
            <li className="flex gap-3"><span className="text-[#b95d12]">•</span><span className="min-w-0 break-words">{data.experienceIntro}</span></li>
            <li className="flex gap-3"><span className="text-[#b95d12]">•</span><span className="min-w-0 break-words">{data.experienceLocation}</span></li>
            <li className="flex gap-3"><span className="text-[#b95d12]">•</span><span className="min-w-0 break-words">{data.includesDetails}</span></li>
            {data.experienceBullet4 ? (
              <li className="flex gap-3"><span className="text-[#b95d12]">•</span><span className="min-w-0 break-words">{data.experienceBullet4}</span></li>
            ) : null}
          </ul>
        </div>

        <div className="shrink-0 border border-[#eadfce] bg-[#faf7f1] p-4 text-center">
          <p className="text-[11px] leading-[16.5px] uppercase tracking-[0.22em] text-[#b95d12] font-semibold">{data.contactTitle}</p>
          <p className="serif text-[21px] mt-3 leading-none">{data.phone}</p>
          <p className="serif text-[18px] mt-2 leading-none break-all">{data.email}</p>
        </div>

        <div className="mt-4 h-[70px] shrink-0 flex justify-between items-end">
          <div className="flex items-center bg-[#fdfcfa]">
            {data.logoUrl ? (
              <img src={data.logoUrl} alt="Casa Rosier" className="h-[70px] w-auto object-contain object-left" />
            ) : null}
          </div>
          <p className="serif text-[18px] leading-[27px] text-[#1f2430]">{data.website}</p>
        </div>

        <span className="absolute top-5 right-7 text-[#eadfce] text-base leading-6">✦</span>
      </div>
    </div>
  );
};
