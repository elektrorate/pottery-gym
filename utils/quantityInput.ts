export type ParsedQuantity = { ok: true; value: number } | { ok: false; raw: string };

/**
 * Spanish quantities. A comma is the decimal separator («2,5» = 2.5).
 * It is never dropped, so «2,5» cannot become 25. A dot is also a decimal
 * mark when it is the only separator. Negatives stay negative for the caller
 * to reject; this function does not apply Math.abs.
 */
export const parseSpanishQuantity = (raw: string | number | null | undefined): ParsedQuantity => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, raw: String(raw) };
  }
  const text = String(raw ?? '').trim().replace(/\s/g, '');
  if (!text) return { ok: false, raw: text };
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) return { ok: false, raw: text };
  const normalized = text.replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, raw: text };
  return { ok: true, value };
};

export const formatQuantityInput = (value: number) =>
  Number.isFinite(value) ? String(value).replace('.', ',') : '';
