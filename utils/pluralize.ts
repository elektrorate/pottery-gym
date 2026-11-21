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

/** Explicit class counter: «Quedan 3 de 4 clases», «Queda 1 de 4 clases». */
export function quedanDeClases(remaining: number, total: number): string {
  const left = Number.isFinite(remaining) ? remaining : 0;
  const all = Number.isFinite(total) ? total : 0;
  const verb = left === 1 ? 'Queda' : 'Quedan';
  return `${verb} ${left} de ${all} ${pluralWord(all, 'clase', 'clases')}`;
}
export const alumnoLabel = (count: number) => pluralize(count, 'alumno', 'alumnos');
export const sesionLabel = (count: number) => pluralize(count, 'sesión', 'sesiones');
export const piezaLabel = (count: number) => pluralize(count, 'pieza', 'piezas');
