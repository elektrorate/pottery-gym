/** Spanish count labels: «1 clase», «0 clases», «2 clases». */
export function pluralWord(count: number, singular: string, plural: string): string {
  const value = Number(count);
  return Math.abs(Number.isFinite(value) ? value : 0) === 1 ? singular : plural;
}

export function pluralize(count: number, singular: string, plural: string): string {
  const value = Number(count);
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe} ${pluralWord(safe, singular, plural)}`;
}

export const claseLabel = (count: number) => pluralize(count, 'clase', 'clases');
export const alumnoLabel = (count: number) => pluralize(count, 'alumno', 'alumnos');
export const sesionLabel = (count: number) => pluralize(count, 'sesión', 'sesiones');
export const piezaLabel = (count: number) => pluralize(count, 'pieza', 'piezas');
