import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { normalizeDeliveryToken } from '@food/shared';
import type { OfflineManifestResponseDto, OfflineSyncEventPayload, OfflineSyncResponseDto } from './api';
import type { ScanResult } from './types';

/**
 * موتور اسکن و صف آفلاین سلف در مرورگر (IndexedDB با `idb`).
 *
 * سه store استاندارد:
 *  - `manifest`: کلید `hash` (`sha256(token)`) + نمایهٔ `by_reservation`؛ هیچ توکن خامی ذخیره نمی‌شود.
 *  - `queue`: رویدادهای اسکن آفلاین (هم معتبر موقت و هم نامعتبر/تکراری) با `clientEventId` (UUID v4).
 *  - `meta`: `device_id` پایدار دستگاه و زمان آخرین دریافت مانیفست.
 */

export const OFFLINE_DB_NAME = 'food-offline-delivery-v1';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_SYNC_BATCH_LIMIT = 50;
export const MANIFEST_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type OfflineLocalOutcome = 'ProvisionalAccepted' | 'DuplicateLocal' | 'InvalidOffline';
export type OfflineSyncStatus = 'pending' | 'synced' | 'conflict' | 'rejected';

export type ManifestRecord = {
  hash: string;
  tokenKind: 'qr' | 'code';
  reservationId: string;
  holderName: string;
  holderIdentifier: string;
  foodName: string;
  mealSlot: string;
  windowFrom: string;
  windowTo: string;
  today: string;
  cafeteriaId: string;
  consumedAt: string | null;
};

export type OfflineQueueRecord = {
  clientEventId: string;
  reservationId: string | null;
  qrTokenHash: string;
  scannedAt: string;
  deviceId: string;
  localOutcome: OfflineLocalOutcome;
  localMessage: string;
  holderName: string | null;
  holderIdentifier: string | null;
  foodName: string | null;
  mealSlot: string | null;
  serviceDate: string | null;
  syncStatus: OfflineSyncStatus;
  serverOutcome: string | null;
  serverMessage: string | null;
  attempts: number;
  nextRetryAt: number;
};

export type DeviceMetaRecord = {
  key: 'device_id';
  deviceId: string;
  createdAt: string;
};

export type ManifestMetaRecord = {
  key: 'manifest_meta';
  today: string;
  cafeteriaId: string;
  generatedAt: string;
  syncedAt: string;
  ticketCount: number;
};

type MetaRecord = DeviceMetaRecord | ManifestMetaRecord;

interface OfflineDeliveryDb extends DBSchema {
  manifest: {
    key: string;
    value: ManifestRecord;
    indexes: { by_reservation: string };
  };
  queue: {
    key: string;
    value: OfflineQueueRecord;
    indexes: { by_sync_status: OfflineSyncStatus };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDeliveryDb>> | null = null;

export function getOfflineDb(): Promise<IDBPDatabase<OfflineDeliveryDb>> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineDeliveryDb>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('manifest')) {
          const manifestStore = db.createObjectStore('manifest', { keyPath: 'hash' });
          manifestStore.createIndex('by_reservation', 'reservationId', { unique: false });
        }
        if (!db.objectStoreNames.contains('queue')) {
          const queueStore = db.createObjectStore('queue', { keyPath: 'clientEventId' });
          queueStore.createIndex('by_sync_status', 'syncStatus', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/** صرفاً برای جداسازی تست‌های واحد (`fake-indexeddb`). */
export async function resetOfflineDbForTest(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('خطا در پاک‌سازی دیتابیس تست'));
  });
}

/** محاسبهٔ `SHA-256` هگزادسیمال با `crypto.subtle` استاندارد مرورگر. */
export async function sha256SubtleHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i += 1) {
    hex += arr[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** ساخت یا بازیابی `device_id` پایدار (UUID v4) در store `meta`. */
export async function getOrCreateDeviceId(): Promise<string> {
  const db = await getOfflineDb();
  const existing = await db.get('meta', 'device_id');
  if (existing && existing.key === 'device_id' && existing.deviceId) {
    return existing.deviceId;
  }
  const deviceId = globalThis.crypto.randomUUID();
  await db.put('meta', {
    key: 'device_id',
    deviceId,
    createdAt: new Date().toISOString(),
  });
  return deviceId;
}

export async function getManifestMeta(): Promise<ManifestMetaRecord | null> {
  const db = await getOfflineDb();
  const rec = await db.get('meta', 'manifest_meta');
  return rec && rec.key === 'manifest_meta' ? rec : null;
}

/**
 * ذخیرهٔ مانیفست جدید در `manifest` و `meta`.
 * اگر بلیتی در صف محلی هنوز در حالت `ProvisionalAccepted` ارسال‌نشده یا همگام‌شده باشد،
 * علامت `consumedAt` آن حفظ می‌شود تا اسکن تکراری در همین دستگاه همچنان مسدود بماند.
 */
export async function saveOfflineManifest(payload: OfflineManifestResponseDto, syncedAt = new Date().toISOString()): Promise<ManifestMetaRecord> {
  const db = await getOfflineDb();
  const tx = db.transaction(['manifest', 'queue', 'meta'], 'readwrite');
  const manifestStore = tx.objectStore('manifest');
  const queueStore = tx.objectStore('queue');
  const metaStore = tx.objectStore('meta');

  const locallyConsumed = new Map<string, string>();
  const allQueue = await queueStore.getAll();
  for (const item of allQueue) {
    if (item.reservationId && item.localOutcome === 'ProvisionalAccepted') {
      locallyConsumed.set(item.reservationId, item.scannedAt);
    }
  }

  await manifestStore.clear();
  for (const r of payload.reservations) {
    const consumedAt = locallyConsumed.get(r.reservationId) ?? null;
    const base = {
      reservationId: r.reservationId,
      holderName: r.holderName,
      holderIdentifier: r.holderIdentifier,
      foodName: r.foodName,
      mealSlot: r.mealSlot,
      windowFrom: r.windowFrom,
      windowTo: r.windowTo,
      today: payload.today,
      cafeteriaId: payload.cafeteriaId,
      consumedAt,
    };
    await manifestStore.put({ ...base, hash: r.qrTokenHash, tokenKind: 'qr' });
    if (r.codeHash && r.codeHash !== r.qrTokenHash) {
      await manifestStore.put({ ...base, hash: r.codeHash, tokenKind: 'code' });
    }
  }

  const meta: ManifestMetaRecord = {
    key: 'manifest_meta',
    today: payload.today,
    cafeteriaId: payload.cafeteriaId,
    generatedAt: payload.generatedAt,
    syncedAt,
    ticketCount: payload.reservations.length,
  };
  await metaStore.put(meta);
  await tx.done;
  return meta;
}

/**
 * اجرای اسکن آفلاین روی مانیفست IndexedDB:
 *  - نرمال‌سازی توکن (با/بدون `R-`، کد ۸ کاراکتری یا QR ۴۸ کاراکتری)
 *  - هش با `crypto.subtle`
 *  - پذیرش موقت + علامت‌گذاری محلی، یا رد محلی (`نامعتبر (آفلاین)` / تکراری)
 *  - ثبت همگی (معتبر و نامعتبر) در `queue` با `clientEventId` (UUID v4)
 */
export async function scanOfflineTicket(
  rawInput: string,
  now = new Date(),
): Promise<{ result: ScanResult; queueItem: OfflineQueueRecord }> {
  const deviceId = await getOrCreateDeviceId();
  const normalized = normalizeDeliveryToken(rawInput);
  const hashInput = normalized ? normalized.canonical : String(rawInput ?? '').trim();
  const qrTokenHash = await sha256SubtleHex(hashInput);
  const scannedAt = now.toISOString();
  const clientEventId = globalThis.crypto.randomUUID();

  const db = await getOfflineDb();
  const tx = db.transaction(['manifest', 'queue'], 'readwrite');
  const manifestStore = tx.objectStore('manifest');
  const queueStore = tx.objectStore('queue');

  if (!normalized) {
    const queueItem: OfflineQueueRecord = {
      clientEventId,
      reservationId: null,
      qrTokenHash,
      scannedAt,
      deviceId,
      localOutcome: 'InvalidOffline',
      localMessage: 'نامعتبر (آفلاین) — قالب کد یا QR معتبر نیست.',
      holderName: null,
      holderIdentifier: null,
      foodName: null,
      mealSlot: null,
      serviceDate: null,
      syncStatus: 'pending',
      serverOutcome: null,
      serverMessage: null,
      attempts: 0,
      nextRetryAt: 0,
    };
    await queueStore.put(queueItem);
    await tx.done;
    return {
      result: {
        state: 'invalid',
        info: null,
        message: 'نامعتبر (آفلاین)',
        deliveredAt: null,
        deliveredBy: null,
      },
      queueItem,
    };
  }

  const entry = await manifestStore.get(qrTokenHash);
  if (!entry) {
    const queueItem: OfflineQueueRecord = {
      clientEventId,
      reservationId: null,
      qrTokenHash,
      scannedAt,
      deviceId,
      localOutcome: 'InvalidOffline',
      localMessage: 'نامعتبر (آفلاین) — در مانیفست رزروهای امروز این سلف یافت نشد.',
      holderName: null,
      holderIdentifier: null,
      foodName: null,
      mealSlot: null,
      serviceDate: null,
      syncStatus: 'pending',
      serverOutcome: null,
      serverMessage: null,
      attempts: 0,
      nextRetryAt: 0,
    };
    await queueStore.put(queueItem);
    await tx.done;
    return {
      result: {
        state: 'invalid',
        info: null,
        message: 'نامعتبر (آفلاین)',
        deliveredAt: null,
        deliveredBy: null,
      },
      queueItem,
    };
  }

  const siblingEntries = await manifestStore.index('by_reservation').getAll(entry.reservationId);
  const previousConsumedAt = siblingEntries.find((s) => s.consumedAt != null)?.consumedAt ?? null;
  const scanInfo = {
    reservationId: entry.reservationId,
    code: '—',
    holderName: entry.holderName,
    holderIdentifier: entry.holderIdentifier,
    foodName: entry.foodName,
    mealSlot: entry.mealSlot,
    cafeteriaName: 'سلف جاری (آفلاین)',
    serviceDate: entry.today,
  };

  if (previousConsumedAt) {
    const queueItem: OfflineQueueRecord = {
      clientEventId,
      reservationId: entry.reservationId,
      qrTokenHash,
      scannedAt,
      deviceId,
      localOutcome: 'DuplicateLocal',
      localMessage: 'تکراری (آفلاین) — این بلیت قبلاً در همین دستگاه اسکن شده است.',
      holderName: entry.holderName,
      holderIdentifier: entry.holderIdentifier,
      foodName: entry.foodName,
      mealSlot: entry.mealSlot,
      serviceDate: entry.today,
      syncStatus: 'pending',
      serverOutcome: null,
      serverMessage: null,
      attempts: 0,
      nextRetryAt: 0,
    };
    await queueStore.put(queueItem);
    await tx.done;
    return {
      result: {
        state: 'already',
        info: scanInfo,
        message: 'این بلیت قبلاً در همین دستگاه در حالت آفلاین پذیرش شده است.',
        deliveredAt: previousConsumedAt,
        deliveredBy: null,
      },
      queueItem,
    };
  }

  for (const sibling of siblingEntries) {
    await manifestStore.put({ ...sibling, consumedAt: scannedAt });
  }

  const queueItem: OfflineQueueRecord = {
    clientEventId,
    reservationId: entry.reservationId,
    qrTokenHash,
    scannedAt,
    deviceId,
    localOutcome: 'ProvisionalAccepted',
    localMessage: 'پذیرش موقت آفلاین (در انتظار همگام‌سازی نهایی با سرور)',
    holderName: entry.holderName,
    holderIdentifier: entry.holderIdentifier,
    foodName: entry.foodName,
    mealSlot: entry.mealSlot,
    serviceDate: entry.today,
    syncStatus: 'pending',
    serverOutcome: null,
    serverMessage: null,
    attempts: 0,
    nextRetryAt: 0,
  };
  await queueStore.put(queueItem);
  await tx.done;

  return {
    result: {
      state: 'offlineProvisional',
      info: scanInfo,
      message: 'پذیرش آفلاین موقت است و پس از اتصال به سرور قطعی می‌شود.',
      deliveredAt: scannedAt,
      deliveredBy: null,
    },
    queueItem,
  };
}

export async function listOfflineQueue(): Promise<OfflineQueueRecord[]> {
  const db = await getOfflineDb();
  const all = await db.getAll('queue');
  return all.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

export function computeBackoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1), 7);
  return Math.min(300_000, 1_000 * 2 ** exp);
}

/**
 * همگام‌سازی دسته‌ای صف آفلاین با سرور (حداکثر ۵۰ رویداد در هر درخواست، idempotent و با backoff نمایی).
 */
export async function flushOfflineQueue(
  sendBatch: (events: OfflineSyncEventPayload[]) => Promise<OfflineSyncResponseDto>,
  options: { force?: boolean; batchSize?: number; nowMs?: number } = {},
): Promise<{
  sent: number;
  accepted: number;
  conflict: number;
  remainingPending: number;
  failedError: string | null;
}> {
  const nowMs = options.nowMs ?? Date.now();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? OFFLINE_SYNC_BATCH_LIMIT, OFFLINE_SYNC_BATCH_LIMIT));
  const db = await getOfflineDb();

  const pendingAll = await db.getAllFromIndex('queue', 'by_sync_status', 'pending');
  const due = pendingAll
    .filter((item) => Boolean(options.force) || item.nextRetryAt <= nowMs)
    .sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));

  let sent = 0;
  let accepted = 0;
  let conflict = 0;
  let failedError: string | null = null;

  for (let offset = 0; offset < due.length; offset += batchSize) {
    const chunk = due.slice(offset, offset + batchSize);
    const payload: OfflineSyncEventPayload[] = chunk.map((item) => ({
      clientEventId: item.clientEventId,
      reservationId: item.reservationId,
      qrTokenHash: item.qrTokenHash,
      scannedAt: item.scannedAt,
      deviceId: item.deviceId,
      localOutcome: item.localOutcome,
    }));

    try {
      const response = await sendBatch(payload);
      const byId = new Map(response.results.map((r) => [r.clientEventId, r]));
      const tx = db.transaction('queue', 'readwrite');
      for (const item of chunk) {
        const res = byId.get(item.clientEventId);
        const outcome = res?.outcome ?? 'Accepted';
        const message = res?.message ?? '';
        let syncStatus: OfflineSyncStatus;
        if (outcome === 'OfflineConflict') {
          syncStatus = 'conflict';
          conflict += 1;
        } else if (item.localOutcome === 'ProvisionalAccepted' && outcome !== 'Accepted' && outcome !== 'Duplicate') {
          // اگر کلاینت پذیرش موقت داده بود ولی سرور به هر دلیل (بازصدور QR / لغو / سلف دیگر) رد کرد، باید به عنوان تعارض برجسته شود
          syncStatus = 'conflict';
          conflict += 1;
        } else if (item.localOutcome === 'ProvisionalAccepted') {
          syncStatus = 'synced';
          accepted += 1;
        } else {
          syncStatus = 'rejected';
        }
        await tx.store.put({
          ...item,
          syncStatus,
          serverOutcome: outcome,
          serverMessage: message,
          attempts: item.attempts + 1,
          nextRetryAt: 0,
        });
      }
      await tx.done;
      sent += chunk.length;
    } catch (err) {
      failedError = err instanceof Error ? err.message : 'خطا در همگام‌سازی صف آفلاین';
      const tx = db.transaction('queue', 'readwrite');
      for (const item of chunk) {
        const nextAttempts = item.attempts + 1;
        await tx.store.put({
          ...item,
          attempts: nextAttempts,
          nextRetryAt: nowMs + computeBackoffMs(nextAttempts),
        });
      }
      await tx.done;
      break;
    }
  }

  const remaining = await db.getAllFromIndex('queue', 'by_sync_status', 'pending');
  return { sent, accepted, conflict, remainingPending: remaining.length, failedError };
}
