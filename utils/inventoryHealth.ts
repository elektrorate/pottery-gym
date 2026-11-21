export type InventoryHealth = 'ok' | 'low' | 'critical';

/** Same bands as Inventario → Resumen: agotado and half the minimum are Crítico; at or under the minimum is Stock bajo. */
export const inventoryHealth = (item: { current_quantity: number; min_quantity?: number | null }): InventoryHealth => {
  const minimum = Number(item.min_quantity) || 0;
  if (item.current_quantity <= 0) return 'critical';
  if (!minimum) return 'ok';
  if (item.current_quantity <= minimum * 0.5) return 'critical';
  if (item.current_quantity <= minimum) return 'low';
  return 'ok';
};

export const inventoryAlertLabel = (health: InventoryHealth, quantity: number) => {
  if (quantity <= 0) return 'Agotado';
  if (health === 'critical') return 'Crítico';
  if (health === 'low') return 'Stock bajo';
  return 'Correcto';
};
