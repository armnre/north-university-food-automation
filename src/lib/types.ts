// Frontend view types mirroring endpoint outputs (endpoints return these shapes).
export type MyReservation = {
  id: string; code: string; status: string; priceAtBooking: number; createdAt: string; serviceDate: string; mealType: string;
  foodName: string; cafeteriaName: string; deliveredAt: string | null; cancelDeadline: string | null; canCancel: boolean; qrToken: string | null;
};
export type MyReservations = { today: string; reservations: MyReservation[] };
export type WalletTx = { id: string; trackingCode: string; type: string; amountRial: number; reason: string; createdAt: string; runningBalance: number };
export type Wallet = { balanceRial: number; transactions: WalletTx[] };
export type MenuOffering = {
  id: string; serviceDate: string; mealType: string; foodName: string; foodDescription: string; cafeteriaName: string; priceRial: number; capacity: number;
  remaining: number; notes: string; reserveDeadline: string | null; cancelDeadline: string | null; open: boolean; myReservationId: string | null; myStatus: string | null; slotTaken: boolean;
};
export type StudentNotifs = { notifications: { id: string; title: string; body: string; createdAt: string; personal: boolean }[]; supportText: string; helpText: string };

export type Offering = {
  id: string; serviceDate: string; mealType: string; foodId: string; foodName: string; foodDescription: string; cafeteriaId: string; cafeteriaName: string;
  priceRial: number; capacity: number; reserved: number; delivered: number; cancelled: number; remaining: number; reserveDeadline: string | null; cancelDeadline: string | null; active: boolean; notes: string;
};
export type Catalog = {
  contractors: { id: string; name: string; contractNumber: string; contactPhone: string; active: boolean }[];
  cafeterias: { id: string; name: string; location: string; active: boolean; contractorId: string | null; contractorName: string }[];
  foods: Food[];
};
export type Food = {
  id: string; name: string; description: string; active: boolean; isDemo: boolean; category: string; defaultPriceRial: number | null; defaultCapacity: number | null; suitableMeals: string[]; imageUrl: string;
};
export type AdminReservation = {
  id: string; code: string; status: string; priceAtBooking: number; createdAt: string; offeringId: string; serviceDate: string; mealType: string; foodName: string;
  cafeteriaName: string; cafeteriaId: string; cancelDeadline: string | null; studentId: string; studentNumber: string; studentName: string; deliveredAt: string | null;
};
export type ScanInfo = { reservationId: string; code: string; studentNumber: string; studentName: string; foodName: string; mealType: string; serviceDate: string };
export type ScanResult = { state: 'ready' | 'delivered' | 'already' | 'cancelled' | 'invalid' | 'wrongCafeteria' | 'wrongDay' | 'expired' | 'network'; info: ScanInfo | null };
