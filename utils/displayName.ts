const LOCALE = 'es-ES';

const isLetter = (char: string) => /\p{L}/u.test(char);

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

/**
 * Display a stored person or studio name without rewriting mixed-case text.
 * All-caps and all-lowercase names are title-cased (ROSA ELVIRA → Rosa Elvira).
 */
export const presentDisplayName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const letters = Array.from(trimmed).filter(isLetter).join('');
  if (!letters) return trimmed;
  const upper = letters.toLocaleUpperCase(LOCALE);
  const lower = letters.toLocaleLowerCase(LOCALE);
  if (letters !== upper && letters !== lower) return trimmed;
  return trimmed.replace(/\p{L}+/gu, titleCaseWord);
};
