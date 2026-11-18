import { designerStorageKey, type DesignerScope } from './cacheScope';
import type { GiftCardData } from '../types';

export type LocalGiftCardStatus = 'created' | 'sent' | 'redeemed' | 'cancelled';

export interface LocalGiftCardRecord {
  id: string;
  createdAt: string;
  fileName: string;
  voucherCode: string | null;
  formToken: string | null;
  formCompletedAt: string | null;
  status: LocalGiftCardStatus;
  data: GiftCardData;
}

const STORAGE_KEY = 'casa-rosier-gift-card-history-v1';
const MAX_RECORDS = 200;

const isRecord = (value: unknown): value is LocalGiftCardRecord => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<LocalGiftCardRecord>;
  return typeof row.id === 'string'
    && typeof row.createdAt === 'string'
    && typeof row.fileName === 'string'
    && typeof row.status === 'string'
    && !!row.data
    && typeof row.data === 'object';
};

export const loadLocalHistory = (scope: DesignerScope): LocalGiftCardRecord[] => {
  const STORAGE_KEY = designerStorageKey('history', scope);
  if (typeof window === 'undefined' || !STORAGE_KEY) return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).slice(0, MAX_RECORDS);
  } catch (error) {
    console.warn('No se pudo cargar el historial local:', error);
    return [];
  }
};

export const saveLocalHistory = (records: LocalGiftCardRecord[], scope: DesignerScope): void => {
  const STORAGE_KEY = designerStorageKey('history', scope);
  if (typeof window === 'undefined' || !STORAGE_KEY) return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
  } catch (error) {
    console.warn('No se pudo guardar el historial local:', error);
  }
};

export const upsertLocalHistoryRecord = (
  records: LocalGiftCardRecord[],
  record: LocalGiftCardRecord
): LocalGiftCardRecord[] => {
  const without = records.filter((item) => item.id !== record.id && item.voucherCode !== record.voucherCode);
  return [record, ...without].slice(0, MAX_RECORDS);
};
