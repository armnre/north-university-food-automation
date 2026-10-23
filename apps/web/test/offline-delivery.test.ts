import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeDeliveryToken } from '@food/shared';
import {
  computeBackoffMs,
  flushOfflineQueue,
  getManifestMeta,
  getOfflineDb,
  getOrCreateDeviceId,
  listOfflineQueue,
  resetOfflineDbForTest,
  saveOfflineManifest,
  scanOfflineTicket,
  sha256SubtleHex,
} from '../src/lib/offline-delivery';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('اسکن آفلاین سلف در فرانت‌اند (fake-indexeddb + crypto.subtle)', () => {
  beforeEach(async () => {
    await resetOfflineDbForTest();
  });

  it('نرمال‌سازی توکن برای کد ۸ کاراکتری (با/بدون R-، ارقام فارسی و حروف کوچک) و QR ۴۸ هگز', () => {
    expect(normalizeDeliveryToken('R-abcd1234')).toEqual({ kind: 'code', canonical: 'ABCD1234' });
    expect(normalizeDeliveryToken('abcd1234')).toEqual({ kind: 'code', canonical: 'ABCD1234' });
    expect(normalizeDeliveryToken('  r-۱۲۳۴abcd  ')).toEqual({ kind: 'code', canonical: '1234ABCD' });
    // کدی که خودش ۸ کاراکتر است و با R شروع می‌شود نباید حرف اولش حذف شود
    expect(normalizeDeliveryToken('R7K9M2P4')).toEqual({ kind: 'code', canonical: 'R7K9M2P4' });
    expect(normalizeDeliveryToken('R-R7K9M2P4')).toEqual({ kind: 'code', canonical: 'R7K9M2P4' });

    const qr = 'A1B2C3D4E5F6'.repeat(4);
    expect(normalizeDeliveryToken(qr)).toEqual({ kind: 'qr', canonical: qr.toLowerCase() });

    expect(normalizeDeliveryToken('')).toBeNull();
    expect(normalizeDeliveryToken('123')).toBeNull();
  });

  it('هش SHA-256 با crypto.subtle دقیقاً منطبق بر بردار استاندارد NIST است', async () => {
    expect(await sha256SubtleHex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('سه store (manifest, queue, meta)، شناسهٔ دستگاه پایدار، پذیرش موقت، رد اسکن دوم و ثبت اسکن نامعتبر', async () => {
    const db = await getOfflineDb();
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['manifest', 'meta', 'queue']);

    const device1 = await getOrCreateDeviceId();
    const device2 = await getOrCreateDeviceId();
    expect(device1).toBe(device2);
    expect(device1).toMatch(UUID_V4_RE);

    const rawQr = 'ab12cd34ef56'.repeat(4);
    const rawCode = 'K8P2M9Q4';
    const qrTokenHash = await sha256SubtleHex(rawQr);
    const codeHash = await sha256SubtleHex(rawCode);
    const reservationId = '11111111-2222-4333-8444-555555555555';

    await saveOfflineManifest(
      {
        today: '2026-10-24',
        cafeteriaId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        generatedAt: '2026-10-24T07:30:00.000Z',
        reservations: [
          {
            reservationId,
            qrTokenHash,
            codeHash,
            holderName: 'سارا محمدی',
            holderIdentifier: '401123456',
            foodName: 'چلوکباب کوبیده',
            mealSlot: 'Lunch',
            windowFrom: '2026-10-24T07:30:00.000Z',
            windowTo: '2026-10-24T11:30:00.000Z',
          },
        ],
      },
      '2026-10-24T07:31:00.000Z',
    );

    const meta = await getManifestMeta();
    expect(meta?.ticketCount).toBe(1);
    expect(meta?.syncedAt).toBe('2026-10-24T07:31:00.000Z');

    // ۱) اسکن اول با توکن QR خام ⇒ پذیرش موقت
    const first = await scanOfflineTicket(rawQr, new Date('2026-10-24T08:30:00.000Z'));
    expect(first.result.state).toBe('offlineProvisional');
    expect(first.result.info?.holderName).toBe('سارا محمدی');
    expect(first.queueItem.clientEventId).toMatch(UUID_V4_RE);
    expect(first.queueItem.localOutcome).toBe('ProvisionalAccepted');
    expect(first.queueItem.deviceId).toBe(device1);

    // ۲) اسکن دوم همان بلیت در همان دستگاه، حتی با کد ۸ کاراکتری با پیشوند R- ⇒ رد محلی (تکراری)
    const duplicate = await scanOfflineTicket(`R-${rawCode.toLowerCase()}`, new Date('2026-10-24T08:31:00.000Z'));
    expect(duplicate.result.state).toBe('already');
    expect(duplicate.queueItem.localOutcome).toBe('DuplicateLocal');

    // ۳) حتی اگر مانیفست قبل از همگام‌سازی دوباره ذخیره شود، علامت مصرف محلی حفظ می‌ماند
    await saveOfflineManifest({
      today: '2026-10-24',
      cafeteriaId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      generatedAt: '2026-10-24T08:35:00.000Z',
      reservations: [
        {
          reservationId,
          qrTokenHash,
          codeHash,
          holderName: 'سارا محمدی',
          holderIdentifier: '401123456',
          foodName: 'چلوکباب کوبیده',
          mealSlot: 'Lunch',
          windowFrom: '2026-10-24T07:30:00.000Z',
          windowTo: '2026-10-24T11:30:00.000Z',
        },
      ],
    });
    const stillDuplicate = await scanOfflineTicket(rawCode, new Date('2026-10-24T08:36:00.000Z'));
    expect(stillDuplicate.result.state).toBe('already');

    // ۴) اسکن بلیت ناموجود ⇒ «نامعتبر (آفلاین)» و ثبت در صف
    const invalid = await scanOfflineTicket('ZZZZ9999', new Date('2026-10-24T08:37:00.000Z'));
    expect(invalid.result.state).toBe('invalid');
    expect(invalid.result.message).toBe('نامعتبر (آفلاین)');
    expect(invalid.queueItem.localOutcome).toBe('InvalidOffline');

    const queue = await listOfflineQueue();
    expect(queue).toHaveLength(4);
    // هیچ توکن خامی در صف ذخیره نشده است
    const serialized = JSON.stringify(queue);
    expect(serialized).not.toContain(rawQr);
    expect(serialized).not.toContain(rawCode);
  });

  it('همگام‌سازی دسته‌ای (حداکثر ۵۰ رویداد در هر درخواست)، backoff نمایی در خطا و تشخیص OfflineConflict', async () => {
    // ثبت ۱۲۰ اسکن آفلاین (بیش از دو دستهٔ ۵۰تایی)
    for (let i = 0; i < 120; i += 1) {
      await scanOfflineTicket(`FAKE${String(i).padStart(4, '0')}`, new Date(Date.UTC(2026, 9, 24, 8, 0, i)));
    }

    // تلاش اول با خطای شبکه ⇒ attempts=1 و nextRetryAt در آینده قرار می‌گیرد
    const t0 = Date.UTC(2026, 9, 24, 9, 0, 0);
    const failedRun = await flushOfflineQueue(
      async () => {
        throw new Error('قطع ارتباط شبکه');
      },
      { nowMs: t0 },
    );
    expect(failedRun.sent).toBe(0);
    expect(failedRun.remainingPending).toBe(120);
    expect(failedRun.failedError).toContain('قطع ارتباط');

    // بلافاصله بعد از خطا (بدون force و قبل از سررسید backoff)، ۵۰ آیتم دستهٔ اول دوباره ارسال نمی‌شوند
    const batchSizesWithoutForce: number[] = [];
    await flushOfflineQueue(
      async (events) => {
        batchSizesWithoutForce.push(events.length);
        throw new Error('همچنان قطع');
      },
      { nowMs: t0 + 500 },
    );
    // آیتم‌های ۵۱ تا ۱۲۰ هنوز attempts=0 دارند پس دستهٔ بعدی حداکثر ۵۰تایی است
    expect(batchSizesWithoutForce[0]).toBe(50);

    // ارسال موفق کل ۱۲۰ رویداد با force=true ⇒ دقیقاً ۳ درخواست با اندازه‌های ۵۰، ۵۰، ۲۰
    const sentBatches: number[] = [];
    const okRun = await flushOfflineQueue(
      async (events) => {
        expect(events.length).toBeLessThanOrEqual(50);
        sentBatches.push(events.length);
        return {
          accepted: 0,
          duplicate: 0,
          conflict: 1,
          invalid: events.length - 1,
          results: events.map((ev, idx) => ({
            clientEventId: ev.clientEventId,
            outcome: idx === 0 && sentBatches.length === 1 ? 'OfflineConflict' : 'Invalid',
            message: idx === 0 && sentBatches.length === 1 ? 'لغو در فاصلهٔ آفلاین' : 'نامعتبر',
          })),
        };
      },
      { force: true, nowMs: t0 + computeBackoffMs(2) + 1 },
    );

    expect(sentBatches).toEqual([50, 50, 20]);
    expect(okRun.sent).toBe(120);
    expect(okRun.conflict).toBe(1);
    expect(okRun.remainingPending).toBe(0);

    const finalQueue = await listOfflineQueue();
    expect(finalQueue.filter((q) => q.syncStatus === 'conflict')).toHaveLength(1);
  });
});
