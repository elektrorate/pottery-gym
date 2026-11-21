export const secondarySections = ['pieces', 'gift_card_movements', 'inventory_items', 'inventory_movements', 'workshop_schedules', 'workshop_capacity_defaults', 'workshop_schedule_exceptions'] as const;
export type SecondarySection = typeof secondarySections[number];
export type SectionLoadState = { status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error'; hasData: boolean; error?: string; updatedAt?: string };
export type SectionLoads = Partial<Record<SecondarySection, SectionLoadState>>;

export function describeLoadError(error: unknown): string {
  const value = error as { message?: string; code?: string; name?: string };
  if (value?.code === '42501' || /permission denied|row.level security/i.test(value?.message || '')) return 'No tienes permiso para consultar esta sección.';
  if (['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(value?.code || '')) return 'Esta sección no está disponible en esta versión. Avise a quien administra el taller.';
  if (/timeout|tiempo|abort|fetch|network/i.test(value?.message || '') || value?.name === 'AbortError') return 'No se pudo completar la conexión. Reintenta la carga.';
  return 'No se pudieron cargar los datos de esta sección. Reintenta la carga.';
}

export function nextSectionState(previous: SectionLoadState | undefined): SectionLoadState {
  return { ...previous, status: previous?.hasData ? 'refreshing' : 'loading', hasData: previous?.hasData ?? false, error: undefined };
}
