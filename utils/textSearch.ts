const LOCALE = 'es-ES';

/** Strip accents so «diaz» matches «Díaz» and «nandu» matches «Ñandú». */
export const foldAccents = (value: string | null | undefined) =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/gi, 'n')
    .toLocaleLowerCase(LOCALE)
    .trim();

export const includesFolded = (haystack: string | null | undefined, needle: string | null | undefined) => {
  const query = foldAccents(needle);
  if (!query) return true;
  return foldAccents(haystack).includes(query);
};

export const compareEs = (left: string | null | undefined, right: string | null | undefined) =>
  (left ?? '').localeCompare(right ?? '', LOCALE, { sensitivity: 'base' });
