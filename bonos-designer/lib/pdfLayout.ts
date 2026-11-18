/**
 * Geometry shared by the on-screen card, every designer PDF (desktop and
 * mobile) and the bot API PDF.
 *
 * The card is a PORTRAIT design: 120.25mm × 190mm (the old landscape paper,
 * swapped), ratio 1:1.58. Each PDF page is exactly one card face, upright,
 * with no margins and no rotation.
 *
 * The layout is authored in CSS pixels at a fixed width (`CARD_PX_WIDTH`) so
 * text wraps the same way in the preview, the html2canvas capture and the
 * vector PDF painted by `giftCardPdf.ts`.
 */
export const CARD_RATIO = 1.58;
export const CARD_HEIGHT_MM = 190;
export const CARD_WIDTH_MM = CARD_HEIGHT_MM / CARD_RATIO;

export const CARD_PX_WIDTH = 480;
export const CARD_PX_HEIGHT = CARD_PX_WIDTH * CARD_RATIO;

export interface CardPageMm {
  pageWidth: number;
  pageHeight: number;
}

/** PDF page = one portrait card face, no margins. */
export const portraitCardPageMm = (): CardPageMm => ({
  pageWidth: CARD_WIDTH_MM,
  pageHeight: CARD_HEIGHT_MM
});
