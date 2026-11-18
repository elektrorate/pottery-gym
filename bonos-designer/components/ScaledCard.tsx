import React, { useLayoutEffect, useRef, useState } from 'react';
import { CARD_PX_HEIGHT, CARD_PX_WIDTH } from '../lib/pdfLayout';

/**
 * Shows the fixed-size portrait card (480 × 758.4 px) scaled down to the
 * available width, so the preview wraps text exactly like the PDF.
 */
export const ScaledCard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const update = () => setScale(Math.min(1, outer.clientWidth / CARD_PX_WIDTH));
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(outer);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div ref={outerRef} className="scaled-card w-full print:h-auto" style={{ height: CARD_PX_HEIGHT * scale }}>
      <div
        className="scaled-card-inner mx-auto origin-top-left"
        style={{ width: CARD_PX_WIDTH, transform: scale < 1 ? `scale(${scale})` : undefined }}
      >
        {children}
      </div>
    </div>
  );
};
