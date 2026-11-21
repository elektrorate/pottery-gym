const LOCALE = 'es-ES';

const isLetter = (char: string) => /\p{L}/u.test(char);

/** Spanish name particles stay lowercase unless they open the name. */
const NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e']);

/**
 * Display labels for membership tiers. Kept here so this module stays
 * importable by Node's type-stripping test runner (types.ts uses enums).
 * These strings match MEMBERSHIP_PLANS in types.ts.
 */
const PLAN_LABELS: Record<string, string> = {
  plata: 'Plata',
  gold: 'Gold',
  platinum: 'Platinum'
};

const titleCaseWord = (word: string) => {
  let titled = false;
  return Array.from(word).map(char => {
    if (!isLetter(char)) return char;
    if (!titled) {
      titled = true;
      return char.toLocaleUpperCase(LOCALE);
    }
    return char.toLocaleLowerCase(LOCALE);
  }).join('');
};

const isUniformCase = (word: string) => {
  const upper = word.toLocaleUpperCase(LOCALE);
  const lower = word.toLocaleLowerCase(LOCALE);
  return word === upper || word === lower;
};

/**
 * Display a stored person or studio name.
 * Only all-lowercase or all-uppercase words are rewritten. Mixed-case words
 * stay as stored (McDonald, Rosa Elvira Guayanay). Particles such as de, del,
 * la and y stay lowercase when they are not the first word.
 */
export const presentDisplayName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return value;
  let seenWord = false;
  return trimmed.replace(/\p{L}+/gu, word => {
    const first = !seenWord;
    seenWord = true;
    if (!isUniformCase(word)) return word;
    const lower = word.toLocaleLowerCase(LOCALE);
    if (!first && NAME_PARTICLES.has(lower)) return lower;
    return titleCaseWord(word);
  });
};

/** Join name parts and present them. Empty parts are skipped. Does not write storage. */
export const presentPersonName = (...parts: Array<string | null | undefined>) => {
  const joined = parts.map(part => (part ?? '').trim()).filter(Boolean).join(' ');
  return joined ? presentDisplayName(joined) : '';
};

/**
 * First letters of the first two words. Dashes and other punctuation split
 * words, so «Ana-María López» is AM. A single word stays one letter.
 */
export const presentInitials = (name?: string | null, surname?: string | null) => {
  const words = `${name ?? ''} ${surname ?? ''}`.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.slice(0, 2).map(word => {
    const letter = Array.from(presentDisplayName(word)).find(isLetter);
    return letter ? letter.toLocaleUpperCase(LOCALE) : '';
  }).join('');
};

/** Capitalized plan name for display. Unknown tiers are title-cased; empty stays empty. */
export const presentPlanName = (tier: string | null | undefined) => {
  const value = (tier ?? '').trim();
  if (!value) return '';
  return PLAN_LABELS[value] || presentDisplayName(value);
};
