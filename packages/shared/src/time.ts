export const TEHRAN_TZ = 'Asia/Tehran';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TEHRAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TEHRAN_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Tehran calendar date (YYYY-MM-DD) for an instant. */
export const tehranDate = (at: Date = new Date()) => dateFmt.format(at);

/** Offset of Tehran from UTC in minutes at a given instant (Iran has no DST since 2022, but stay generic). */
export function tehranOffsetMinutes(at: Date): number {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Converts a Tehran wall-clock date + HH:MM to a UTC instant. */
export function tehranWallToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = new Date(Date.UTC(y!, m! - 1, d!, hh!, mm!));
  return new Date(guess.getTime() - tehranOffsetMinutes(guess) * 60000);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}
