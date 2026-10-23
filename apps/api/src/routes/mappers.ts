import type { OfferingRow } from '../repositories/offering.repo.js';
import type { ReservationRow } from '../repositories/reservation.repo.js';

/** نگاشت ردیف‌های repository به DTOهای قرارداد REST (بدون منطق کسب‌وکار). */

export function mapOfferingToDto(row: OfferingRow, myPriceRial: number | null = null) {
  return {
    id: row.id,
    serviceDate: row.serviceDate,
    mealSlot: row.mealSlot,
    mealSlotTitle: row.mealSlotTitle,
    foodId: row.foodId,
    foodName: row.foodName,
    foodDescription: row.foodDescription,
    cafeteriaId: row.cafeteriaId,
    cafeteriaName: row.cafeteriaName,
    capacity: row.capacity,
    reserved: row.reservedCount,
    delivered: row.delivered,
    cancelled: row.cancelled,
    noShow: row.noShow,
    remaining: row.remaining,
    status: row.status,
    notes: row.notes,
    reserveOpensAt: row.reserveOpensAt.toISOString(),
    reserveDeadline: row.reserveDeadline.toISOString(),
    cancelDeadline: row.cancelDeadline ? row.cancelDeadline.toISOString() : null,
    prices: row.prices.map((p) => ({ customerGroup: p.customerGroup, priceRial: p.priceRial })),
    myPriceRial: myPriceRial ?? row.prices[0]?.priceRial ?? null,
    priceRial: row.prices.find((p) => p.customerGroup === 'Student')?.priceRial ?? row.prices[0]?.priceRial ?? 0,
    active: row.status === 'Published',
    statusReason: row.statusReason,
  };
}

export function mapReservationToDto(row: ReservationRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    priceRial: row.priceRial,
    createdAt: row.createdAt.toISOString(),
    offeringId: row.offeringId,
    serviceDate: row.serviceDate,
    mealSlot: row.mealSlot,
    foodName: row.foodName,
    cafeteriaId: row.cafeteriaId,
    cafeteriaName: row.cafeteriaName,
    cancelDeadline: row.offeringCancelDeadline ? row.offeringCancelDeadline.toISOString() : null,
    accountId: row.accountId,
    customerGroup: row.customerGroup,
    holderName: row.holderName,
    holderIdentifier: row.holderIdentifier,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
  };
}
