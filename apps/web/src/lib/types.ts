// Frontend view types mirroring endpoint outputs (endpoints return these shapes).
export type MyReservation = {
  id: string; code: string; status: string; priceRial: number; createdAt: string; serviceDate: string; mealSlot: string;
  foodName: string; cafeteriaName: string; deliveredAt: string | null; cancelDeadline: string | null; qrToken: string | null;
  mealSlotTitle: string;
};
export type MyReservations = { today: string; reservations: MyReservation[] };
export type WalletTx = { id: string; trackingCode: string; type: string; typeLabel?: string; amountRial: number; reason: string; createdAt: string; balanceAfter: number };
export type Wallet = { balanceRial: number; transactions: WalletTx[] };
export type MenuOffering = {
  id: string; serviceDate: string; mealSlot: string; mealSlotTitle: string; myPriceRial: number | null; status: string; foodName: string; foodDescription: string; cafeteriaName: string; priceRial: number; capacity: number;
  remaining: number; notes: string; reserveDeadline: string | null; cancelDeadline: string | null; open: boolean; myReservationId: string | null; myStatus: string | null; imagePath?: string | null;
};
export type StudentNotifs = { notifications: { id: string; title: string; body: string; createdAt: string; personal: boolean }[]; supportText: string; helpText: string };

export type Offering = {
  id: string; serviceDate: string; mealSlot: string; mealSlotTitle: string; foodId: string; foodName: string; foodDescription: string;
  cafeteriaId: string; cafeteriaName: string; priceRial: number; capacity: number; reserved: number; delivered: number; cancelled: number;
  noShow: number; remaining: number; reserveOpensAt: string; reserveDeadline: string; cancelDeadline: string | null; status: string;
  active: boolean; notes: string; statusReason: string | null;
  prices: { customerGroup: string; priceRial: number }[]; myPriceRial: number | null;
};
export type Catalog = {
  contractors: { id: string; name: string; contractNumber: string; contactPhone: string | null; isActive: boolean }[];
  cafeterias: { id: string; name: string; location: string; isActive: boolean; contractorId: string | null; contractorName: string }[];
  foods: Food[];
  mealSlots: { id: string; code: string; title: string; startTime: string; endTime: string; isActive: boolean }[];
};
export type Food = {
  id: string; name: string; description: string; isActive: boolean; category: string; defaultPriceRial: number | null;
  defaultCapacity: number | null; calories: number | null; imagePath: string | null;
};
export type AdminReservation = {
  id: string; code: string; status: string; priceRial: number; createdAt: string; offeringId: string; serviceDate: string; mealSlot: string; foodName: string;
  cafeteriaName: string; cafeteriaId: string; cancelDeadline: string | null; accountId: string; customerGroup: string; holderIdentifier: string; holderName: string; deliveredAt: string | null; canCancel: boolean;
};
export type ScanInfo = { reservationId: string; code: string; holderIdentifier: string; holderName: string; foodName: string; mealSlot: string; mealSlotTitle: string; cafeteriaName: string; serviceDate: string };
export type ScanResult = {
  state: 'ready' | 'delivered' | 'already' | 'cancelled' | 'invalid' | 'wrongCafeteria' | 'wrongDay' | 'expired' | 'outsideWindow' | 'noShow' | 'offlineConflict' | 'network';
  info: ScanInfo | null; message: string; deliveredAt: string | null; deliveredBy: string | null;
};
