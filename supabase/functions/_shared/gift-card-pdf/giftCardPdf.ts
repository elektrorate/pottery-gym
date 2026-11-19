/**
 * Server PDF of the designer faces. Ported unchanged from bono-gift-card
 * `lib/giftCardPdf.ts` (PR #7/#8). Only the asset/fontkit loader was made
 * portable so the same file can run in Node tests, the Vite UI and Deno Edge
 * Functions. The paint code, typography, colours, geometry and assets are
 * the same, so the pages must match pixel for pixel.
 *
 * Coordinates follow the portrait `GiftCardSide` (fixed 480 × 758.4 CSS px):
 * the same box model, type scale and colors the web app paints before
 * html2canvas. Each page is exactly one portrait card face, 120.25 × 190 mm,
 * upright and without margins (see `pdfLayout.ts`).
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { GiftCardData } from './types.ts';
import { classesCountLabel } from './giftCardDefaults.ts';
import { CARD_PX_HEIGHT, CARD_PX_WIDTH, portraitCardPageMm } from './pdfLayout.ts';

type RawFont = {
  ascent: number;
  unitsPerEm: number;
  glyphForCodePoint: (codePoint: number) => { id: number } | null;
};

type FontkitLike = {
  create: (buffer: Uint8Array, postscriptName?: string) => RawFont;
};

const CARD_W = CARD_PX_WIDTH;
const CARD_H = CARD_PX_HEIGHT;
const MM_TO_PT = 72 / 25.4;
const PAGE_W = portraitCardPageMm().pageWidth * MM_TO_PT;
const PAGE_H = portraitCardPageMm().pageHeight * MM_TO_PT;
const SCALE = PAGE_W / CARD_W;

const CREAM = rgb(0xfd / 255, 0xfc / 255, 0xfa / 255);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0x1f / 255, 0x24 / 255, 0x30 / 255);
const INK_NAME = rgb(0x1d / 255, 0x23 / 255, 0x30 / 255);
const INK_TITLE = rgb(0x1b / 255, 0x23 / 255, 0x30 / 255);
const MUTED = rgb(0x4a / 255, 0x4f / 255, 0x58 / 255);
const QUOTE = rgb(0x62 / 255, 0x67 / 255, 0x73 / 255);
const COPPER = rgb(0xa3 / 255, 0x4f / 255, 0x20 / 255);
const COPPER_DEEP = rgb(0xb9 / 255, 0x5d / 255, 0x12 / 255);
const CORNER = rgb(0xf1 / 255, 0xdd / 255, 0xce / 255);
const FRAME = rgb(0xef / 255, 0xe6 / 255, 0xdc / 255);
const CARD_BORDER = rgb(0xeb / 255, 0xe2 / 255, 0xd9 / 255);
const RULE = rgb(0xdf / 255, 0xc8 / 255, 0xb7 / 255);
const ORNAMENT = rgb(0xd9 / 255, 0xc8 / 255, 0xb8 / 255);
const STAR = rgb(0xe0 / 255, 0xcd / 255, 0xbd / 255);
const DOTS = rgb(0xdb / 255, 0xc9 / 255, 0xb9 / 255);
const PANEL_BORDER = rgb(0xea / 255, 0xd7 / 255, 0xc8 / 255);
const CONTACT_BORDER = rgb(0xea / 255, 0xdf / 255, 0xce / 255);
const CONTACT_BG = rgb(0xfa / 255, 0xf7 / 255, 0xf1 / 255);
const BACK_STAR = rgb(0xea / 255, 0xdf / 255, 0xce / 255);

type Rgb = ReturnType<typeof rgb>;

type Face = {
  font: PDFFont;
  /** hhea ascender / unitsPerEm. Baseline sits this far into the em square. */
  ascent: number;
  raw: RawFont;
};

type Faces = {
  sans: Face;
  sansMedium: Face;
  sansSemibold: Face;
  sansItalic: Face;
  serif: Face;
};

const byteCache = new Map<string, Uint8Array>();

export const pdfBundleAssets: Record<string, URL> = {
  'assets/fonts/Montserrat-Regular.ttf': new URL('./assets/fonts/Montserrat-Regular.ttf', import.meta.url),
  'assets/fonts/Montserrat-Medium.ttf': new URL('./assets/fonts/Montserrat-Medium.ttf', import.meta.url),
  'assets/fonts/Montserrat-SemiBold.ttf': new URL('./assets/fonts/Montserrat-SemiBold.ttf', import.meta.url),
  'assets/fonts/Montserrat-Italic.ttf': new URL('./assets/fonts/Montserrat-Italic.ttf', import.meta.url),
  'assets/fonts/CormorantGaramond-Regular.ttf': new URL('./assets/fonts/CormorantGaramond-Regular.ttf', import.meta.url),
  'assets/logos/logo-casa-rosier.png': new URL('./assets/logos/logo-casa-rosier.png', import.meta.url)
};

const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
const isNode = typeof process !== 'undefined' && !!process.versions?.node && !isDeno;

const readAsset = async (relative: string): Promise<Uint8Array> => {
  const cached = byteCache.get(relative);
  if (cached) return cached;
  if (!pdfBundleAssets[relative]) {
    throw new Error(`No se encontró el recurso ${relative}`);
  }
  const url = pdfBundleAssets[relative];
  let bytes: Uint8Array;
  if (isDeno) {
    bytes = await (globalThis as { Deno: { readFile: (path: URL) => Promise<Uint8Array> } }).Deno.readFile(url);
  } else if (isNode) {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    bytes = await fs.readFile(fileURLToPath(url));
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`No se encontró el recurso ${relative}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  byteCache.set(relative, bytes);
  return bytes;
};

const loadFontkit = async (): Promise<FontkitLike> => {
  if (isNode) {
    // @pdf-lib/fontkit is CommonJS. A named ESM import can fail (`Named export
    // 'create' not found`); require is what the original Vercel function uses.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    return require('@pdf-lib/fontkit') as FontkitLike;
  }
  const mod = await import('@pdf-lib/fontkit') as { default?: FontkitLike } & FontkitLike;
  return (mod.default || mod) as FontkitLike;
};

const loadFace = async (pdf: PDFDocument, relative: string, fontkit: FontkitLike): Promise<Face> => {
  const bytes = await readAsset(relative);
  const raw = fontkit.create(bytes);
  const font = await pdf.embedFont(bytes, { subset: true });
  return { font, ascent: raw.ascent / raw.unitsPerEm, raw };
};

const loadFaces = async (pdf: PDFDocument): Promise<Faces> => {
  const fontkit = await loadFontkit();
  pdf.registerFontkit(fontkit as Parameters<PDFDocument['registerFontkit']>[0]);
  const [sans, sansMedium, sansSemibold, sansItalic, serif] = await Promise.all([
    loadFace(pdf, 'assets/fonts/Montserrat-Regular.ttf', fontkit),
    loadFace(pdf, 'assets/fonts/Montserrat-Medium.ttf', fontkit),
    loadFace(pdf, 'assets/fonts/Montserrat-SemiBold.ttf', fontkit),
    loadFace(pdf, 'assets/fonts/Montserrat-Italic.ttf', fontkit),
    loadFace(pdf, 'assets/fonts/CormorantGaramond-Regular.ttf', fontkit)
  ]);
  return { sans, sansMedium, sansSemibold, sansItalic, serif };
};

const upper = (value: string): string => value.toLocaleUpperCase('es-ES');

const glyphs = (value: string): string[] => Array.from(value);

const sanitize = (face: Face, value: string): string => {
  let out = '';
  for (const ch of glyphs(value)) {
    if (ch === '\n' || ch === '\t') {
      out += ch;
      continue;
    }
    const glyph = face.raw.glyphForCodePoint(ch.codePointAt(0) || 0);
    if (glyph && glyph.id !== 0) out += ch;
  }
  return out;
};

const measure = (face: Face, text: string, size: number, trackingEm = 0): number => {
  const tracking = trackingEm * size;
  const chars = glyphs(text);
  let width = 0;
  for (let i = 0; i < chars.length; i += 1) {
    width += face.font.widthOfTextAtSize(chars[i], size);
    if (i < chars.length - 1) width += tracking;
  }
  return width;
};

const wrapText = (face: Face, text: string, size: number, maxWidth: number, trackingEm = 0): string[] => {
  const safe = sanitize(face, text);
  const lines: string[] = [];
  const paragraphs = safe.replace(/\r\n/g, '\n').split('\n');
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const pieces = measure(face, word, size, trackingEm) > maxWidth ? breakWord(face, word, size, maxWidth, trackingEm) : [word];
      for (const piece of pieces) {
        const next = current ? `${current} ${piece}` : piece;
        if (!current || measure(face, next, size, trackingEm) <= maxWidth) current = next;
        else {
          lines.push(current);
          current = piece;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
};

const breakWord = (face: Face, word: string, size: number, maxWidth: number, trackingEm: number): string[] => {
  const parts: string[] = [];
  let current = '';
  for (const ch of glyphs(word)) {
    const next = current + ch;
    if (!current || measure(face, next, size, trackingEm) <= maxWidth) current = next;
    else {
      parts.push(current);
      current = ch;
    }
  }
  if (current) parts.push(current);
  return parts;
};

class Surface {
  constructor(private readonly page: PDFPage) {}

  private x(px: number): number {
    return px * SCALE;
  }

  private y(pxFromTop: number): number {
    return PAGE_H - pxFromTop * SCALE;
  }

  private s(px: number): number {
    return px * SCALE;
  }

  fill(color: Rgb): void {
    this.page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color });
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    if (w <= 0 || h <= 0) return;
    this.page.drawRectangle({
      x: this.x(x),
      y: this.y(y + h),
      width: this.s(w),
      height: this.s(h),
      color
    });
  }

  stroke(x: number, y: number, w: number, h: number, color: Rgb, pxWidth = 1): void {
    this.page.drawRectangle({
      x: this.x(x),
      y: this.y(y + h),
      width: this.s(w),
      height: this.s(h),
      borderColor: color,
      borderWidth: Math.max(0.4, this.s(pxWidth))
    });
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, pxWidth = 1): void {
    this.page.drawLine({
      start: { x: this.x(x1), y: this.y(y1) },
      end: { x: this.x(x2), y: this.y(y2) },
      thickness: Math.max(0.4, this.s(pxWidth)),
      color
    });
  }

  circle(cx: number, cy: number, r: number, color: Rgb): void {
    this.page.drawEllipse({
      x: this.x(cx),
      y: this.y(cy),
      xScale: this.s(r),
      yScale: this.s(r),
      color
    });
  }

  ring(cx: number, cy: number, r: number, color: Rgb, pxWidth: number): void {
    this.page.drawEllipse({
      x: this.x(cx),
      y: this.y(cy),
      xScale: this.s(r),
      yScale: this.s(r),
      borderColor: color,
      borderWidth: Math.max(0.35, this.s(pxWidth))
    });
  }

  path(d: string, color: Rgb): void {
    this.page.drawSvgPath(d, {
      x: 0,
      y: PAGE_H,
      scale: SCALE,
      color
    });
  }

  text(
    value: string,
    x: number,
    baseline: number,
    face: Face,
    size: number,
    color: Rgb,
    options: { trackingEm?: number; align?: 'left' | 'center' | 'right' } = {}
  ): number {
    const text = sanitize(face, value);
    if (!text) return 0;
    const trackingEm = options.trackingEm ?? 0;
    const width = measure(face, text, size, trackingEm);
    const align = options.align ?? 'left';
    let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    const tracking = trackingEm * size;
    for (let i = 0; i < glyphs(text).length; i += 1) {
      const ch = glyphs(text)[i];
      this.page.drawText(ch, {
        x: this.x(cursor),
        y: this.y(baseline),
        size: this.s(size),
        font: face.font,
        color
      });
      cursor += face.font.widthOfTextAtSize(ch, size);
      if (i < glyphs(text).length - 1) cursor += tracking;
    }
    return width;
  }
}

const baseline = (top: number, size: number, box: number, face: Face): number => {
  const halfLeading = (box - size) / 2;
  // hhea ascent sits the em square inside the CSS line box. Chrome lets the
  // extra ascender overflow above that box, so the ink reads a little higher.
  const lift = size * (face.ascent > 0.95 ? 0.06 : 0.13);
  return top + halfLeading + face.ascent * size - lift;
};

const starPath = (cx: number, cy: number, radius: number): string => {
  const inner = radius * 0.38;
  const commands: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 4;
    const rad = i % 2 === 0 ? radius : inner;
    const x = cx + Math.cos(angle) * rad;
    const y = cy + Math.sin(angle) * rad;
    commands.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `${commands.join(' ')} Z`;
};

const corners = (surface: Surface, which: 'all' | 'top'): void => {
  const b = 1;
  const c = 32;
  const right = CARD_W - b;
  const bottom = CARD_H - b;
  surface.path(`M ${b} ${b} L ${b + c} ${b} L ${b} ${b + c} Z`, CORNER);
  surface.path(`M ${right - c} ${b} L ${right} ${b} L ${right} ${b + c} Z`, CORNER);
  if (which === 'all') {
    surface.path(`M ${b} ${bottom - c} L ${b} ${bottom} L ${b + c} ${bottom} Z`, CORNER);
    surface.path(`M ${right} ${bottom - c} L ${right} ${bottom} L ${right - c} ${bottom} Z`, CORNER);
  }
};

const frameCard = (surface: Surface, fill: Rgb, which: 'all' | 'top'): void => {
  surface.fill(fill);
  corners(surface, which);
  surface.stroke(0.5, 0.5, CARD_W - 1, CARD_H - 1, CARD_BORDER, 1);
};

const ruleRow = (
  surface: Surface,
  centerX: number,
  top: number,
  box: number,
  middle: number,
  drawMiddle: (x: number, y: number) => void
): void => {
  const lineW = 40;
  const gap = 16;
  const total = lineW + gap + middle + gap + lineW;
  const left = centerX - total / 2;
  const y = top + box / 2;
  surface.line(left, y, left + lineW, y, RULE, 1);
  drawMiddle(left + lineW + gap + middle / 2, y);
  const right = left + lineW + gap + middle + gap;
  surface.line(right, y, right + lineW, y, RULE, 1);
};

/** Recipient lines, leaving room for the stars on the first and last line. */
const recipientLines = (faces: Faces, name: string, size: number, maxWidth: number): string[] => {
  const starRoom = (size / 34) * (10 + 12);
  return wrapText(faces.serif, name, size, maxWidth - starRoom * 2, -0.025);
};

const paintFront = (surface: Surface, faces: Faces, data: GiftCardData): void => {
  frameCard(surface, CREAM, 'all');

  const frameX = 29;
  const frameY = 29;
  const frameW = CARD_W - 58;
  const frameH = CARD_H - 58;
  surface.stroke(frameX, frameY, frameW, frameH, FRAME, 1);

  const textTop = frameY + 1 + 28;
  const textH = frameH - 2 - 56;
  const textW = frameW - 2 - 64;
  const centerX = CARD_W / 2;
  const quoteMax = textW * 0.9;

  const recipient = data.recipientName.trim() || 'Nombre Destinatario';
  const donor = data.donorName.trim() || 'Nombre Remitente';
  const subtitle2 = data.subtitle2.trim();
  const titleText = upper(data.title || 'TARJETA DE REGALO');
  const subtitleText = data.subtitle || 'Clases de Cerámica';
  const introText = upper(data.introText || '¡Felicidades!');
  const fromText = upper(data.fromLabel);

  let fit = 1;
  let quoteLines: string[] = [];
  let blockH = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = (n: number) => n * fit;
    quoteLines = wrapText(faces.sansItalic, data.mainQuote, size(14), quoteMax);
    const donorLineCount = wrapText(faces.serif, donor, size(34), textW - 8, -0.025).length;
    const recipientLineCount = recipientLines(faces, recipient, size(34), textW - 8).length;
    const count = (text: string, face: Face, n: number, tracking: number) =>
      wrapText(face, text, size(n), textW, tracking).length;
    const titleBlock =
      count(titleText, faces.sansMedium, 9.2, 0.35) * size(13.8) + size(12) + size(15) + size(16) +
      count(subtitleText, faces.serif, 30, -0.025) * size(30) +
      (subtitle2 ? size(8) + count(subtitle2, faces.serif, 22, -0.025) * size(22) : 0);
    const introLines = count(introText, faces.sans, 12.65, 0.25);
    const fromLines = count(fromText, faces.sans, 10.6, 0.25);
    const message =
      introLines * size(18.975) +
      size(8) +
      recipientLineCount * size(34) +
      size(20) +
      quoteLines.length * size(22.75) +
      size(32) +
      size(16) +
      size(20) +
      fromLines * size(15.9) +
      size(8) +
      donorLineCount * size(34);
    blockH = titleBlock + size(40) + message;
    if (blockH <= textH + 0.5 || fit < 0.72) break;
    fit *= (textH / blockH) * 0.98;
  }

  const z = (n: number) => n * fit;
  let y = textTop + Math.max(0, (textH - blockH) / 2);

  const drawCentered = (
    value: string,
    face: Face,
    size: number,
    box: number,
    color: Rgb,
    trackingEm = 0
  ) => {
    surface.text(value, centerX, baseline(y, size, box, face), face, size, color, {
      align: 'center',
      trackingEm
    });
    y += box;
  };

  const drawWrapped = (value: string, face: Face, size: number, box: number, color: Rgb, trackingEm = 0) => {
    for (const line of wrapText(face, value, size, textW, trackingEm)) drawCentered(line, face, size, box, color, trackingEm);
  };

  drawWrapped(titleText, faces.sansMedium, z(9.2), z(13.8), COPPER, 0.35);
  y += z(12);
  ruleRow(surface, centerX, y, z(15), z(10), (mx, my) => {
    surface.ring(mx, my, z(3.15), ORNAMENT, 0.7);
    surface.circle(mx, my, z(0.85), ORNAMENT);
  });
  y += z(15) + z(16);
  drawWrapped(subtitleText, faces.serif, z(30), z(30), INK_TITLE, -0.025);
  if (subtitle2) {
    y += z(8);
    drawWrapped(subtitle2, faces.serif, z(22), z(22), MUTED, -0.025);
  }

  y += z(40);
  drawWrapped(introText, faces.sans, z(12.65), z(18.975), COPPER, 0.25);
  y += z(8);

  // Recipient wraps like the preview: a star before the first line and after the last.
  const nameSize = z(34);
  const starGap = z(12);
  const starW = z(10);
  const starR = nameSize * (4.6 / 34);
  const nameLines = recipientLines(faces, recipient, nameSize, textW - 8);
  nameLines.forEach((line, index) => {
    const lineW = measure(faces.serif, line, nameSize, -0.025);
    const first = index === 0;
    const last = index === nameLines.length - 1;
    const groupW = (first ? starW + starGap : 0) + lineW + (last ? starGap + starW : 0);
    const left = centerX - groupW / 2;
    const textLeft = left + (first ? starW + starGap : 0);
    const nameBaseline = baseline(y, nameSize, nameSize, faces.serif);
    const starCy = y + nameSize * (19.94 / 34) - nameSize * 0.13;
    if (first) surface.path(starPath(left + starW / 2, starCy, starR), STAR);
    surface.text(line, textLeft, nameBaseline, faces.serif, nameSize, INK_NAME, { trackingEm: -0.025 });
    if (last) surface.path(starPath(textLeft + lineW + starGap + starW / 2, starCy, starR), STAR);
    y += nameSize;
  });
  y += z(20);

  for (const line of quoteLines) {
    const box = z(22.75);
    if (line) {
      surface.text(line, centerX, baseline(y, z(14), box, faces.sansItalic), faces.sansItalic, z(14), QUOTE, {
        align: 'center'
      });
    }
    y += box;
  }

  y += z(32);
  const dots = '• • •';
  const dotsW = measure(faces.sans, dots, z(12));
  ruleRow(surface, centerX, y, z(16), dotsW, (mx, my) => {
    const box = z(16);
    const top = my - box / 2;
    surface.text(dots, mx, baseline(top, z(12), box, faces.sans), faces.sans, z(12), DOTS, { align: 'center' });
  });
  y += z(16) + z(20);
  drawWrapped(fromText, faces.sans, z(10.6), z(15.9), COPPER, 0.25);
  y += z(8);
  const donorLines = wrapText(faces.serif, donor, z(34), textW - 8, -0.025);
  for (const line of donorLines) {
    drawCentered(line, faces.serif, z(34), z(34), INK, -0.025);
  }
};

const BACK = {
  contentX: 29,
  contentY: 29,
  contentW: CARD_W - 58,
  footerH: 70,
  footerGap: 16
} as const;

const backFooterTop = (): number => CARD_H - BACK.contentY - BACK.footerH;

const paintBack = (surface: Surface, faces: Faces, data: GiftCardData): void => {
  frameCard(surface, WHITE, 'top');

  const { contentX, contentY, contentW } = BACK;
  const contentRight = contentX + contentW;
  const centerX = CARD_W / 2;

  // Title + divider
  let y = contentY;
  // 38px line box: html2canvas paints a 1.0 line-height title too low onto the divider.
  surface.text(data.experienceTitle || 'Instrucciones de Uso', centerX, baseline(y, 32, 38, faces.serif), faces.serif, 32, INK_TITLE, {
    align: 'center'
  });
  y += 38 + 8;
  ruleRow(surface, centerX, y, 16, measure(faces.sans, '•', 12), (mx, my) => {
    surface.text('•', mx, baseline(my - 8, 12, 16, faces.sans), faces.sans, 12, ORNAMENT, { align: 'center' });
  });
  y += 16 + 16;

  // Panel: includes, classes, date, code, validity (centred)
  const panelTop = y;
  const innerW = contentW - 2 - 32;
  let py = panelTop + 1 + 16;
  const draws: Array<() => void> = [];
  for (const line of wrapText(faces.sans, data.includesLabel || 'Esta tarjeta incluye:', 12, innerW)) {
    const at = py;
    draws.push(() => surface.text(line, centerX, baseline(at, 12, 18, faces.sans), faces.sans, 12, INK, { align: 'center' }));
    py += 18;
  }
  py += 16;
  const classes = classesCountLabel(data.numberOfClasses);
  const hours = `- ${data.sessionDuration} h`;
  const classesW = measure(faces.serif, classes, 44);
  const hoursW = measure(faces.serif, hours, 30);
  const spaceW = measure(faces.serif, ' ', 16);
  const classesGroup = classesW + spaceW + 8 + hoursW;
  const classesLeft = centerX - classesGroup / 2;
  const classesBox = 44 * 1.12;
  const classesAt = py;
  draws.push(() => {
    const classesBaseline = baseline(classesAt, 44, classesBox, faces.serif);
    surface.text(classes, classesLeft, classesBaseline, faces.serif, 44, COPPER_DEEP);
    surface.text(hours, classesLeft + classesW + spaceW + 8, classesBaseline, faces.serif, 30, COPPER_DEEP);
  });
  py += classesBox + 24;
  for (const line of wrapText(faces.sans, `Fecha de emisión: ${data.creationDate}`, 14, innerW)) {
    const at = py;
    draws.push(() => surface.text(line, centerX, baseline(at, 14, 21, faces.sans), faces.sans, 14, MUTED, { align: 'center' }));
    py += 21;
  }
  if (data.voucherCode) {
    py += 8;
    const at = py;
    const label = 'Código: ';
    const labelW = measure(faces.sans, label, 12, 0.08);
    const codeW = measure(faces.sansSemibold, data.voucherCode, 12, 0.08);
    const left = centerX - (labelW + codeW) / 2;
    draws.push(() => {
      surface.text(label, left, baseline(at, 12, 18, faces.sans), faces.sans, 12, INK, { trackingEm: 0.08 });
      surface.text(data.voucherCode, left + labelW, baseline(at, 12, 18, faces.sansSemibold), faces.sansSemibold, 12, INK, {
        trackingEm: 0.08
      });
    });
    py += 18;
  }
  py += 12;
  const validity = `Válida por: ${data.validityText.replace(/^.*?:\s*/i, '')}`;
  for (const line of wrapText(faces.serif, validity, 19, innerW)) {
    const at = py;
    draws.push(() => surface.text(line, centerX, baseline(at, 19, 19, faces.serif), faces.serif, 19, MUTED, { align: 'center' }));
    py += 19;
  }
  const panelBottom = py + 16 + 1;
  surface.stroke(contentX, panelTop, contentW, panelBottom - panelTop, PANEL_BORDER, 1);
  draws.forEach((draw) => draw());

  // Contact box sits right above the footer (CSS: flex-1 bullets, then box).
  const contactTitle = upper(data.contactTitle || 'Información de contacto');
  const boxInnerW = contentW - 34;
  const phoneLines = wrapText(faces.serif, data.phone, 21, boxInnerW);
  const emailLines = wrapText(faces.serif, data.email, 18, boxInnerW);
  const contactH = 1 + 16 + 16.5 + 12 + phoneLines.length * 21 + 8 + emailLines.length * 18 + 16 + 1;
  const contactBottom = backFooterTop() - BACK.footerGap;
  const contactTop = contactBottom - contactH;
  surface.rect(contentX, contactTop, contentW, contactH, CONTACT_BG);
  surface.stroke(contentX, contactTop, contentW, contactH, CONTACT_BORDER, 1);
  let cy = contactTop + 1 + 16;
  surface.text(contactTitle, centerX, baseline(cy, 11, 16.5, faces.sansSemibold), faces.sansSemibold, 11, COPPER_DEEP, {
    align: 'center',
    trackingEm: 0.22
  });
  cy += 16.5 + 12;
  for (const line of phoneLines) {
    surface.text(line, centerX, baseline(cy, 21, 21, faces.serif), faces.serif, 21, INK, { align: 'center' });
    cy += 21;
  }
  cy += 8;
  for (const line of emailLines) {
    surface.text(line, centerX, baseline(cy, 18, 18, faces.serif), faces.serif, 18, INK, { align: 'center' });
    cy += 18;
  }

  // «Cómo usar tu tarjeta» + bullets between the panel and the contact box.
  let by = panelBottom + 20;
  const bulletsBottom = contactTop - 16;
  const heading = upper(data.contactSubtitle || 'Cómo usar tu tarjeta');
  surface.text(heading, contentX, baseline(by, 11, 16.5, faces.sansSemibold), faces.sansSemibold, 11, COPPER_DEEP, {
    trackingEm: 0.2
  });
  by += 16.5 + 12;

  const bullets = [data.experienceIntro, data.experienceLocation, data.includesDetails, data.experienceBullet4].filter(
    (item) => item && item.trim()
  );
  const bulletGap = 12;
  const bulletMark = '•';
  let bulletSize = 12;
  let bulletLines: string[][] = [];
  for (;;) {
    const markW = measure(faces.sans, bulletMark, bulletSize);
    bulletLines = bullets.map((item) => wrapText(faces.sans, item, bulletSize, contentW - bulletGap - markW));
    const total = bulletLines.reduce((sum, lines) => sum + lines.length * bulletSize * 1.625, 0) + Math.max(0, bulletLines.length - 1) * 8;
    if (by + total <= bulletsBottom + 0.5 || bulletSize <= 9) break;
    bulletSize -= 0.5;
  }
  const bulletBox = bulletSize * 1.625;
  const markW = measure(faces.sans, bulletMark, bulletSize);
  bulletLines.forEach((lines, index) => {
    if (index > 0) by += 8;
    lines.forEach((line, lineIndex) => {
      if (by + bulletBox > bulletsBottom + 0.5) return;
      if (lineIndex === 0) {
        surface.text(bulletMark, contentX, baseline(by, bulletSize, bulletBox, faces.sans), faces.sans, bulletSize, COPPER_DEEP);
      }
      surface.text(line, contentX + markW + bulletGap, baseline(by, bulletSize, bulletBox, faces.sans), faces.sans, bulletSize, INK);
      by += bulletBox;
    });
  });

  // Small star, top right (CSS: absolute top-5 right-7, 16px glyph).
  surface.path(starPath(contentRight - 28 - 6.7, contentY + 20 + 12, 5.4), BACK_STAR);
};

const drawLogo = async (pdf: PDFDocument, page: PDFPage, faces: Faces, data: GiftCardData): Promise<void> => {
  const contentX = BACK.contentX;
  const contentRight = BACK.contentX + BACK.contentW;
  const logoTop = backFooterTop();
  const logoH = BACK.footerH;
  try {
    const bytes = await readAsset('assets/logos/logo-casa-rosier.png');
    const image = await pdf.embedPng(bytes);
    const logoW = logoH * (image.width / image.height);
    page.drawImage(image, {
      x: contentX * SCALE,
      y: PAGE_H - (logoTop + logoH) * SCALE,
      width: logoW * SCALE,
      height: logoH * SCALE
    });
  } catch (error) {
    console.error('[giftCardPdf] logo omitido', error);
  }

  const surface = new Surface(page);
  const website = sanitize(faces.serif, data.website || 'www.casarosierceramica.com');
  let size = 18;
  const maxW = BACK.contentW - 140;
  while (size > 11 && measure(faces.serif, website, size) > maxW) size -= 0.5;
  const box = size * 1.5;
  const top = logoTop + logoH - box;
  surface.text(website, contentRight, baseline(top, size, box, faces.serif), faces.serif, size, INK, { align: 'right' });
};

export const buildGiftCardPdfBytes = async (data: GiftCardData): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Bono Casa Rosier ${data.voucherCode || ''}`.trim());
  pdf.setAuthor('Casa Rosier');
  const faces = await loadFaces(pdf);

  const front = pdf.addPage([PAGE_W, PAGE_H]);
  paintFront(new Surface(front), faces, data);

  const back = pdf.addPage([PAGE_W, PAGE_H]);
  paintBack(new Surface(back), faces, data);
  await drawLogo(pdf, back, faces, data);

  return pdf.save();
};
