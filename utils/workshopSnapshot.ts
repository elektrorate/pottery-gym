export const SNAPSHOT_TABLES = ["students","teachers","sessions","session_students","student_membership_periods","student_membership_class_adjustments","student_manual_credit_entitlements","student_penalty_settlements","student_assigned_classes","gift_cards","gift_card_movements","gift_card_operation_receipts","session_credit_movements","session_operation_receipts","session_business_events","session_business_exceptions","session_business_billing","session_business_penalties","session_business_waivers","session_activity_blocks","inventory_items","inventory_movements","payments","pieces","workshop_schedules","workshop_capacity_defaults","workshop_schedule_exceptions","sede_members","workshop_activities","workshop_activity_events","sedes","packages","session_activity_block_students","mixed_session_reservations"] as const;
export type WorkshopSnapshot = { format: string; version: number; scope: string; sede_id: string; manifest: Record<string, number>; data: Record<string, Record<string, unknown>[]>; integrity?: { algorithm: string; sha256: string }; [key: string]: unknown };
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
}
export function validateSnapshot(value: unknown): asserts value is WorkshopSnapshot {
  const snapshot = value as WorkshopSnapshot;
  if (!snapshot || snapshot.format !== 'pottery-workshop-snapshot' || snapshot.version !== 1 || snapshot.scope !== 'workshop-business-data' || !snapshot.sede_id || !snapshot.manifest || !snapshot.data) throw new Error('Formato de copia no compatible.');
  if (Object.keys(snapshot.data).length !== Object.keys(snapshot.manifest).length || Object.keys(snapshot.data).length !== SNAPSHOT_TABLES.length || SNAPSHOT_TABLES.some(table => !Object.hasOwn(snapshot.data, table))) throw new Error('La copia no contiene todas las entidades del contrato.');
  if (snapshot.data.sedes.length !== 1 || snapshot.data.sedes[0]?.id !== snapshot.sede_id) throw new Error('La copia debe incluir la configuración de una única sede.');
  for (const [table, rows] of Object.entries(snapshot.data)) {
    if (!Array.isArray(rows) || rows.length !== snapshot.manifest[table]) throw new Error(`Recuento incorrecto: ${table}.`);
    const keys = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || (row.sede_id && row.sede_id !== snapshot.sede_id) || (table === 'sedes' && row.id !== snapshot.sede_id)) throw new Error(`Registro de otra sede o inválido: ${table}.`);
      const key = recordKey(table, row);
      if (keys.has(key)) throw new Error(`ID duplicado: ${table}.`); keys.add(key);
    }
  }
  const ids = (table: string) => new Set(snapshot.data[table].map(row => row.id));
  const students = ids('students'), sessions = ids('sessions'), teachers = ids('teachers'), gifts = ids('gift_cards'), items = ids('inventory_items'), periods = ids('student_membership_periods');
  for (const [table,rows] of Object.entries(snapshot.data)) for (const row of rows) {
    for (const [field,parents] of [['student_id',students],['recipient_student_id',students],['session_id',sessions],['teacher_id',teachers],['teacher_substitute_id',teachers],['gift_card_id',gifts],['inventory_item_id',items],['membership_period_id',periods],['current_membership_period_id',periods],['period_id',periods],['manual_credit_id',ids('student_manual_credit_entitlements')],['block_id',ids('session_activity_blocks')],['activity_id',ids('workshop_activities')]] as const) {
      if (row[field] && !parents.has(row[field])) throw new Error('Referencia ausente: '+table+'.'+field);
    }
  }
}
export async function sealSnapshot(value: unknown): Promise<WorkshopSnapshot> {
  validateSnapshot(value);
  const { integrity: ignored, ...body } = value;
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...body, integrity: { algorithm: 'SHA-256', sha256 } } as WorkshopSnapshot;
}
export async function verifySnapshot(value: unknown): Promise<WorkshopSnapshot> {
  validateSnapshot(value);
  if (!value.integrity || value.integrity.algorithm !== 'SHA-256' || (await sealSnapshot(value)).integrity?.sha256 !== value.integrity.sha256) throw new Error('La integridad de la copia no coincide. No se puede restaurar.');
  return value;
}

function recordKey(table: string, row: Record<string, unknown>): string {
  if (row.id) return String(row.id);
  if (table === 'gift_card_operation_receipts' && row.request_key) return String(row.request_key);
  if (table === 'session_activity_block_students' && row.block_id && row.student_id) return `${row.block_id}:${row.student_id}`;
  if (table === 'workshop_activity_events' && row.sede_id && row.request_id) return `${row.sede_id}:${row.request_id}`;
  if (['session_operation_receipts','mixed_session_reservations'].includes(table) && row.session_id && row.request_key) return `${row.session_id}:${row.request_key}`;
  throw new Error('Registro sin identificador: '+table);
}
export function compareSnapshots(current: WorkshopSnapshot, incoming: WorkshopSnapshot) {
  validateSnapshot(current); validateSnapshot(incoming);
  if (current.sede_id !== incoming.sede_id) throw new Error('La copia pertenece a otra sede.');
  return Object.entries(incoming.data).map(([table, rows]) => {
    const existing = new Map((current.data[table] || []).map(row => [recordKey(table, row), canonicalJson(row)]));
    const seen = new Set<string>(); let added = 0, changed = 0, identical = 0;
    for (const row of rows) {
      const key = recordKey(table, row); if (seen.has(key)) throw new Error(`Clave duplicada en ${table}.`); seen.add(key);
      const prior = existing.get(key);
      if (prior === undefined) added++; else if (prior === canonicalJson(row)) identical++; else changed++;
    }
    return { table, added, changed, identical, destinationOnly: [...existing.keys()].filter(key => !seen.has(key)).length };
  });
}
