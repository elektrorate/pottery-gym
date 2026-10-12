import type { CapacityDefaults, ClassSession, WorkshopCapacityDefault } from '../types';

export type SessionAvailability = 'available' | 'last_places' | 'full' | 'over_capacity' | 'blocked';

export interface SessionOccupancy {
  capacity: number;
  enrolled: number;
  remaining: number;
  ratio: number;
  visualPercentage: number;
  availability: SessionAvailability;
}

const normalizeName = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();

export const capacityDefaultsToMap = (defaults: WorkshopCapacityDefault[] | CapacityDefaults): CapacityDefaults =>
  Array.isArray(defaults)
    ? defaults.reduce<CapacityDefaults>((result, item) => ({ ...result, [item.classType]: item.capacity }), {})
    : defaults;

export const getSessionEnrolledCount = (session: ClassSession): number => {
  const enrolled = new Set<string>();
    session.students.forEach((name, index) => {
        const id = session.studentIds?.[index];
        if (id && session.attendancePolicyVersion === 2 && session.businessStateByStudentId?.[id]?.reservationState === 'cancelled') return;
    enrolled.add(id || normalizeName(name));
  });
  return enrolled.size;
};

export const getSessionOccupancy = (session: ClassSession, defaults: CapacityDefaults = {}): SessionOccupancy => {
  if (session.classType === 'feriado') {
    return { capacity: 0, enrolled: 0, remaining: 0, ratio: 0, visualPercentage: 0, availability: 'blocked' };
  }
  const capacity = Math.max(1, Math.round(session.capacity ?? defaults[session.classType] ?? 8));
  const enrolled = getSessionEnrolledCount(session);
  const remaining = capacity - enrolled;
  const ratio = enrolled / capacity;
  const availability: SessionAvailability = enrolled > capacity
    ? 'over_capacity'
    : enrolled === capacity
      ? 'full'
      : remaining <= 2
        ? 'last_places'
        : 'available';
  return { capacity, enrolled, remaining, ratio, visualPercentage: Math.min(100, Math.max(0, ratio * 100)), availability };
};

export const sessionAvailabilityLabel: Record<SessionAvailability, string> = {
  available: 'Disponible',
  last_places: 'Últimas plazas',
  full: 'Completa',
  over_capacity: 'Exceso de inscritos',
  blocked: 'Bloqueada'
};

export const sessionAvailabilityTone: Record<SessionAvailability, string> = {
  available: 'text-[#20663B] bg-[#E7F0E8] border-[#BFDECB]',
  last_places: 'text-[#916438] bg-[#F5E8D4] border-[#EBD5AC]',
  full: 'text-[#9E3B2B] bg-[#F8E1DA] border-[#EFC9BE]',
  over_capacity: 'text-[#7B3F22] bg-[#F3D1B5] border-[#DDA06D]',
  blocked: 'text-neutral-textHelper bg-neutral-sec border-neutral-border'
};
