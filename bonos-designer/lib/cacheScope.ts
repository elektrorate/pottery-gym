export type DesignerScope = { userId: string; sedeId: string } | null;
const PREFIX = 'pottery-designer:v2:';
export const designerStorageKey = (kind: string, scope: DesignerScope): string | null =>
  scope?.userId && scope?.sedeId ? PREFIX + encodeURIComponent(scope.userId) + ':' + encodeURIComponent(scope.sedeId) + ':' + kind : null;
export const clearDesignerCaches = (): void => {
  if (typeof window === 'undefined') return;
  try { for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(PREFIX) || key.startsWith('casa-rosier-gift-card-')) window.localStorage.removeItem(key);
  } } catch { /* Storage can be disabled; in-memory state is cleared separately. */ }
};
export const removeUnscopedDesignerCaches = (): void => {
  if (typeof window === 'undefined') return;
  try { for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith('casa-rosier-gift-card-')) window.localStorage.removeItem(key);
  } } catch { /* Never attach unattributed legacy personal data to a new identity. */ }
};
