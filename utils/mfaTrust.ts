/** First-party device trust. Not a session token: the Supabase session stays in storage. */
export const MFA_TRUST_COOKIE = 'pg-mfa-trust';
export const MFA_TRUST_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const secureAttribute = () =>
  typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';

/** Remember when this browser last passed TOTP. Max-Age keeps it across hard reloads. */
export const writeMfaTrust = (userId: string, verifiedAtMs: number) => {
  if (typeof document === 'undefined' || !userId || !Number.isFinite(verifiedAtMs) || verifiedAtMs <= 0) return;
  const value = encodeURIComponent(`${userId}|${Math.round(verifiedAtMs)}`);
  document.cookie = `${MFA_TRUST_COOKIE}=${value}; Path=/; Max-Age=${MFA_TRUST_MAX_AGE_SEC}; SameSite=Lax${secureAttribute()}`;
};

/** Unix ms for this user, or null when the cookie is missing or belongs to someone else. */
export const readMfaTrust = (userId: string): number | null => {
  if (typeof document === 'undefined' || !userId) return null;
  const raw = document.cookie.split('; ').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? null : [part.slice(0, index), part.slice(index + 1)] as const;
  }).find(entry => entry?.[0] === MFA_TRUST_COOKIE)?.[1];
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const split = decoded.lastIndexOf('|');
  if (split <= 0) return null;
  const id = decoded.slice(0, split);
  const verifiedAtMs = Number(decoded.slice(split + 1));
  if (id !== userId || !Number.isFinite(verifiedAtMs) || verifiedAtMs <= 0) return null;
  return verifiedAtMs;
};

export const clearMfaTrust = () => {
  if (typeof document === 'undefined') return;
  document.cookie = `${MFA_TRUST_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
};
