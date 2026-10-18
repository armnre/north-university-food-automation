import { zite } from 'zitejs/db';
import { first, tehranToday } from './core';

export type ScanState = 'ready' | 'delivered' | 'already' | 'cancelled' | 'invalid' | 'wrongCafeteria' | 'wrongDay' | 'expired';

/** Server-side QR validation shared by scan & confirm. The QR holds only a random token. */
export async function inspectToken(token: string, operatorCafeteriaId: string | undefined) {
  const t = String(token ?? '').trim();
  let res;
  if (/^[a-f0-9]{48}$/.test(t)) res = await zite.reservations.findOne({ filters: { qrToken: t } });
  else {
    // Manual delivery code: accepted with or without the internal "R-" prefix, case-insensitive.
    const c = t.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^R(?=[A-Z0-9]{8}$)/, '');
    if (!/^[A-Z0-9]{8}$/.test(c)) return { state: 'invalid' as ScanState };
    res = await zite.reservations.findOne({ filters: { code: `R-${c}` } });
  }
  if (!res) return { state: 'invalid' as ScanState };
  const [offering, student] = await Promise.all([
    zite.mealOfferings.findOne({ id: first(res.offering)! }),
    zite.students.findOne({ id: first(res.student)!, fields: ['studentNumber', 'fullName'] }),
  ]);
  const food = offering ? await zite.foods.findOne({ id: first(offering.food)!, fields: ['name'] }) : undefined;
  const serviceDate = String(offering?.serviceDate ?? '').slice(0, 10);
  const today = tehranToday();
  const info = {
    reservationId: res.id, code: res.code ?? '', studentNumber: student?.studentNumber ?? '', studentName: student?.fullName ?? '',
    foodName: food?.name ?? '', mealType: offering?.mealType ?? '', serviceDate,
  };
  let state: ScanState = 'ready';
  if (res.status === 'Delivered') state = 'already';
  else if (res.status === 'Cancelled' || res.status === 'Rejected') state = 'cancelled';
  else if (operatorCafeteriaId && first(offering?.cafeteria) !== operatorCafeteriaId) state = 'wrongCafeteria';
  else if (serviceDate < today) state = 'expired';
  else if (serviceDate > today) state = 'wrongDay';
  return { state, info, res };
}
