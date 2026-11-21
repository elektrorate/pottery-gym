/**
 * Supabase auth storage that survives a hard reload.
 * localStorage is the live copy. A SameSite=Lax cookie with Max-Age of 30 days
 * is the fallback when that copy is missing after a reload. There is no server
 * middleware: the SPA reads this storage itself.
 */
const CHUNK = 3000;
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

const secureAttribute = () =>
  typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';

const readCookieMap = () => {
  const map = new Map<string, string>();
  if (typeof document === 'undefined' || !document.cookie) return map;
  for (const part of document.cookie.split('; ')) {
    const index = part.indexOf('=');
    if (index > 0) map.set(part.slice(0, index), part.slice(index + 1));
  }
  return map;
};

const writeCookie = (name: string, value: string) => {
  document.cookie = `${name}=${value}; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax${secureAttribute()}`;
};

const deleteCookie = (name: string) => {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
};

const cookieNamesFor = (key: string, cookies: Map<string, string>) =>
  [...cookies.keys()].filter(name => name === key || name.startsWith(`${key}.`));

export const createDurableAuthStorage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => ({
  getItem(key) {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored != null) return stored;
    } catch { /* fall through to the cookie */ }
    const cookies = readCookieMap();
    const single = cookies.get(key);
    const chunks: string[] = [];
    if (!single) {
      for (let index = 0; cookies.has(`${key}.${index}`); index += 1) chunks.push(cookies.get(`${key}.${index}`)!);
    }
    const encoded = single ?? (chunks.length ? chunks.join('') : null);
    if (!encoded) return null;
    try {
      const value = decodeURIComponent(encoded);
      try { window.localStorage.setItem(key, value); } catch { /* cookie still holds it */ }
      return value;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* cookie still persists the session */ }
    const encoded = encodeURIComponent(value);
    const pieces: string[] = [];
    for (let index = 0; index < encoded.length; index += CHUNK) pieces.push(encoded.slice(index, index + CHUNK));
    const cookies = readCookieMap();
    for (const name of cookieNamesFor(key, cookies)) deleteCookie(name);
    if (pieces.length <= 1) writeCookie(key, pieces[0] ?? '');
    else pieces.forEach((piece, index) => writeCookie(`${key}.${index}`, piece));
  },
  removeItem(key) {
    try { window.localStorage.removeItem(key); } catch { /* still drop the cookie */ }
    for (const name of cookieNamesFor(key, readCookieMap())) deleteCookie(name);
  }
});
