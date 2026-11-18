/** Initials from a person name: first + last word, accent-stripped. */
export const getNameInitials = (name: string): string => {
  const parts = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return 'XX';
  if (parts.length === 1) {
    const word = parts[0];
    return (word.slice(0, 2) || 'X').padEnd(2, 'X');
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
};

/** Parse es-ES dates (dd/mm/yyyy) or ISO; fallback to today. */
export const formatVoucherDateStamp = (creationDate?: string, now = new Date()): string => {
  const match = creationDate?.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3].length === 2 ? match[3] : match[3].slice(-2);
    return `${day}${month}${year}`;
  }

  const iso = creationDate?.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[3]}${iso[2]}${iso[1].slice(-2)}`;
  }

  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = String(now.getFullYear()).slice(-2);
  return `${day}${month}${year}`;
};

const uniquenessSuffix = (now = new Date()): string => {
  const fromTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = alphabet[fromTime % alphabet.length];
  const b = alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${a}${b}`;
};

/**
 * Unique gift-card code bound to issue date + donor/recipient initials.
 * Example: CR-291026-MR-JP-A7
 */
export const generateVoucherCode = (
  donorName: string,
  recipientName: string,
  creationDate?: string,
  now = new Date()
): string => {
  const dateStamp = formatVoucherDateStamp(creationDate, now);
  const donor = getNameInitials(donorName);
  const recipient = getNameInitials(recipientName);
  return `CR-${dateStamp}-${donor}-${recipient}-${uniquenessSuffix(now)}`;
};
