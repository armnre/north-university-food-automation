import { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { BarcodeDetector } from 'barcode-detector/pure';
import {
  AlertTriangle,
  Ban,
  Camera,
  CameraOff,
  CheckCircle2,
  Clock,
  CloudUpload,
  Database,
  Keyboard,
  Loader2,
  MapPinOff,
  RefreshCw,
  RotateCcw,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, deliveryConfirm, deliveryScan, deliveryStats, offlineManifest, offlineSync } from '../../lib/api';
import {
  MANIFEST_REFRESH_INTERVAL_MS,
  flushOfflineQueue,
  getManifestMeta,
  getOrCreateDeviceId,
  listOfflineQueue,
  saveOfflineManifest,
  scanOfflineTicket,
  type ManifestMetaRecord,
  type OfflineQueueRecord,
} from '../../lib/offline-delivery';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { cn } from '@project/components/lib/utils';
import { PageHeader, Pill, Section, StatCard } from '../../components/ui-kit';
import { MEALS, errMsg, faDate, faDateTime, faDigits, faNum } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { ScanResult } from '../../lib/types';

const STATES: Record<ScanResult['state'], { title: string; cls: string; icon: React.ReactNode }> = {
  ready: {
    title: 'رزرو معتبر و آماده‌ی تحویل',
    cls: 'border-[hsl(var(--info))] bg-[hsl(var(--info)/0.08)]',
    icon: <CheckCircle2 className="h-10 w-10 text-[hsl(var(--info))]" />,
  },
  delivered: {
    title: 'تحویل با موفقیت ثبت شد',
    cls: 'border-[hsl(var(--success))] bg-[hsl(var(--success)/0.1)]',
    icon: <CheckCircle2 className="h-10 w-10 text-[hsl(var(--success))]" />,
  },
  offlineProvisional: {
    title: 'پذیرش موقت (آفلاین) ثبت شد',
    cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.12)]',
    icon: <CheckCircle2 className="h-10 w-10 text-[hsl(var(--warning))]" />,
  },
  already: {
    title: 'این رزرو قبلاً تحویل یا اسکن شده است',
    cls: 'border-destructive bg-destructive/10',
    icon: <Ban className="h-10 w-10 text-destructive" />,
  },
  cancelled: {
    title: 'رزرو لغو یا رد شده است',
    cls: 'border-destructive bg-destructive/10',
    icon: <XCircle className="h-10 w-10 text-destructive" />,
  },
  invalid: {
    title: 'کد نامعتبر است',
    cls: 'border-destructive bg-destructive/10',
    icon: <AlertTriangle className="h-10 w-10 text-destructive" />,
  },
  wrongCafeteria: {
    title: 'این رزرو متعلق به سلف دیگری است',
    cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]',
    icon: <MapPinOff className="h-10 w-10 text-[hsl(var(--warning))]" />,
  },
  wrongDay: {
    title: 'این رزرو برای روز دیگری است',
    cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]',
    icon: <Clock className="h-10 w-10 text-[hsl(var(--warning))]" />,
  },
  expired: {
    title: 'رزرو منقضی شده است',
    cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]',
    icon: <Clock className="h-10 w-10 text-[hsl(var(--warning))]" />,
  },
  outsideWindow: {
    title: 'خارج از بازهٔ زمانی تحویل',
    cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]',
    icon: <AlertTriangle className="h-10 w-10 text-[hsl(var(--warning))]" />,
  },
  noShow: {
    title: 'این رزرو «عدم مراجعه» شده است',
    cls: 'border-destructive bg-destructive/10',
    icon: <Ban className="h-10 w-10 text-destructive" />,
  },
  offlineConflict: {
    title: 'تعارض همگام‌سازی آفلاین',
    cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]',
    icon: <AlertTriangle className="h-10 w-10 text-[hsl(var(--warning))]" />,
  },
  network: {
    title: 'خطا در ارتباط با سرور',
    cls: 'border-destructive bg-destructive/10',
    icon: <WifiOff className="h-10 w-10 text-destructive" />,
  },
};

const QUEUE_BADGE: Record<OfflineQueueRecord['syncStatus'], { label: string; tone: 'warning' | 'success' | 'danger' | 'muted' }> = {
  pending: { label: 'در انتظار ارسال', tone: 'warning' },
  synced: { label: 'ثبت نهایی در سرور', tone: 'success' },
  conflict: { label: 'تعارض آفلاین', tone: 'danger' },
  rejected: { label: 'ردشده (ثبت در ممیزی)', tone: 'muted' },
};

export default function DeliveryPage() {
  const stats = useLoad(
    async () =>
      (await deliveryStats()) as {
        today: string;
        cafeteriaName: string;
        byMeal: { mealSlot: string; reserved: number; delivered: number }[];
        recent: { at: string; code: string; holderIdentifier: string; holderName: string; food: string; mealSlot: string }[];
      },
  );
  const [online, setOnline] = useState<boolean>(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [manifestMeta, setManifestMeta] = useState<ManifestMetaRecord | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [queueItems, setQueueItems] = useState<OfflineQueueRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [camera, setCamera] = useState(false);
  const [camError, setCamError] = useState('');
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const webcamRef = useRef<Webcam>(null);
  const lastRef = useRef('');
  const syncInFlightRef = useRef(false);

  const reloadLocalState = useCallback(async () => {
    await getOrCreateDeviceId();
    const [meta, queue] = await Promise.all([getManifestMeta(), listOfflineQueue()]);
    setManifestMeta(meta);
    setQueueItems(queue);
  }, []);

  const refreshManifest = useCallback(
    async (silent = true) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      setManifestLoading(true);
      try {
        const data = await offlineManifest();
        const savedMeta = await saveOfflineManifest(data);
        setManifestMeta(savedMeta);
        setOnline(true);
        if (!silent) {
          toast.success(`مانیفست آفلاین به‌روزرسانی شد (${faDigits(String(savedMeta.ticketCount))} بلیت).`);
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'NETWORK') {
          setOnline(false);
        } else if (!silent) {
          toast.error(errMsg(err));
        }
      } finally {
        setManifestLoading(false);
      }
    },
    [],
  );

  const runSync = useCallback(
    async (force = false, silent = true) => {
      if (syncInFlightRef.current) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      syncInFlightRef.current = true;
      setSyncing(true);
      try {
        const summary = await flushOfflineQueue((events) => offlineSync(events), { force });
        await reloadLocalState();
        if (summary.sent > 0) {
          stats.reload();
          void refreshManifest(true);
        }
        if (summary.conflict > 0) {
          toast.warning(`${faDigits(String(summary.conflict))} تعارض همگام‌سازی آفلاین شناسایی شد؛ لطفاً فهرست تعارض‌ها را بررسی کنید.`);
        } else if (!silent && summary.sent > 0) {
          toast.success(`${faDigits(String(summary.sent))} رویداد آفلاین با سرور همگام‌سازی شد.`);
        } else if (!silent && summary.failedError) {
          toast.error(summary.failedError);
        }
      } finally {
        syncInFlightRef.current = false;
        setSyncing(false);
      }
    },
    [refreshManifest, reloadLocalState, stats],
  );

  // بارگذاری اولیه، به‌روزرسانی ۵ دقیقه‌ای مانیفست و گوش دادن به رویدادهای online/offline/visibilitychange
  useEffect(() => {
    void reloadLocalState();
    void (async () => {
      await runSync(false, true);
      await refreshManifest(true);
    })();

    const onOnline = () => {
      setOnline(true);
      void (async () => {
        await runSync(true, false);
        await refreshManifest(true);
        stats.reload();
      })();
    };
    const onOffline = () => setOnline(false);
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void runSync(false, true);
      }
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);

    const manifestTimer = window.setInterval(() => {
      if (navigator.onLine) {
        void refreshManifest(true);
      }
    }, MANIFEST_REFRESH_INTERVAL_MS);

    const backoffTimer = window.setInterval(() => {
      if (navigator.onLine) {
        void runSync(false, true);
      }
    }, 10_000);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(manifestTimer);
      window.clearInterval(backoffTimer);
    };
  }, [refreshManifest, reloadLocalState, runSync, stats]);

  const performOfflineScan = useCallback(
    async (value: string) => {
      const { result: offResult } = await scanOfflineTicket(value);
      setResult(offResult);
      await reloadLocalState();
    },
    [reloadLocalState],
  );

  const scan = useCallback(
    async (value: string) => {
      if (!value || busy) return;
      setBusy(true);
      setQr(value);
      try {
        if (!navigator.onLine || !online) {
          await performOfflineScan(value);
          return;
        }
        setResult((await deliveryScan({ qrToken: value })) as ScanResult);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'NETWORK') {
          setOnline(false);
          await performOfflineScan(value);
        } else {
          setResult({ state: 'network', info: null, message: errMsg(err), deliveredAt: null, deliveredBy: null });
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, online, performOfflineScan],
  );

  const confirm = async () => {
    setBusy(true);
    try {
      if (!navigator.onLine || !online) {
        await performOfflineScan(qr);
        return;
      }
      const deviceId = await getOrCreateDeviceId();
      setResult(
        (await deliveryConfirm({
          qrToken: qr,
          clientEventId: globalThis.crypto.randomUUID(),
          deviceId,
          scannedAt: new Date().toISOString(),
        })) as ScanResult,
      );
      stats.reload();
      void refreshManifest(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NETWORK') {
        setOnline(false);
        await performOfflineScan(qr);
      } else {
        setResult({ state: 'network', info: null, message: errMsg(err), deliveredAt: null, deliveredBy: null });
      }
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    setResult(null);
    setQr('');
    setManual('');
    lastRef.current = '';
  };

  useEffect(() => {
    if (!camera || result) return;
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let stop = false;
    const tick = async () => {
      const video = webcamRef.current?.video;
      if (!stop && video && video.readyState >= 2) {
        try {
          const codes = await detector.detect(video);
          const v = codes[0]?.rawValue;
          if (v && v !== lastRef.current) {
            lastRef.current = v;
            void scan(v);
            return;
          }
        } catch {
          /* frame not ready */
        }
      }
      if (!stop) setTimeout(tick, 250);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [camera, result, scan]);

  const pendingCount = queueItems.filter((q) => q.syncStatus === 'pending').length;
  const conflictItems = queueItems.filter((q) => q.syncStatus === 'conflict');
  const s = result ? STATES[result.state] : null;

  return (
    <>
      <PageHeader
        title="تحویل غذا"
        subtitle={stats.data ? `${stats.data.cafeteriaName} · ${faDate(stats.data.today)}` : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="delivery-connection-badge"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold',
                online
                  ? 'border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.12)] text-foreground'
                  : 'border-destructive/50 bg-destructive/10 text-destructive',
              )}
            >
              {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {online ? 'آنلاین' : 'آفلاین'}
              {' · '}
              {faDigits(String(pendingCount))} رویداد در صف
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshManifest(false)}
              disabled={!online || manifestLoading}
            >
              {manifestLoading ? <Loader2 className="ms-1.5 h-3.5 w-3.5 animate-spin" /> : <Database className="ms-1.5 h-3.5 w-3.5" />}
              به‌روزرسانی مانیفست
            </Button>
            <Button
              size="sm"
              onClick={() => void runSync(true, false)}
              disabled={!online || syncing || pendingCount === 0}
            >
              {syncing ? <Loader2 className="ms-1.5 h-3.5 w-3.5 animate-spin" /> : <CloudUpload className="ms-1.5 h-3.5 w-3.5" />}
              همگام‌سازی اکنون
            </Button>
          </div>
        }
      />

      {(!online || pendingCount > 0 || result?.state === 'offlineProvisional') && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.12)] px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2.5 font-medium">
            <AlertTriangle className="h-5 w-5 shrink-0 text-[hsl(var(--warning))]" />
            <span>
              <strong>پذیرش آفلاین موقت است:</strong> تا زمان اتصال مجدد به سرور و همگام‌سازی صف، تحویل‌ها بر پایهٔ آخرین مانیفست ذخیره‌شده انجام می‌شود.
            </span>
          </div>
          {manifestMeta && (
            <span className="text-xs text-muted-foreground">
              مانیفست محلی: {faDigits(String(manifestMeta.ticketCount))} بلیت · آخرین دریافت: {faDateTime(manifestMeta.syncedAt)}
            </span>
          )}
        </div>
      )}

      {conflictItems.length > 0 && (
        <div
          role="alert"
          className="mb-5 rounded-2xl border-2 border-destructive bg-destructive/10 p-4"
        >
          <div className="mb-2 flex items-center gap-2 font-bold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span>هشدار تعارض همگام‌سازی آفلاین ({faDigits(String(conflictItems.length))} مورد نیازمند پیگیری)</span>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            بلیت‌های زیر در حالت آفلاین اسکن شدند، اما هنگام اتصال به سرور مشخص شد قبلاً لغو شده یا در دستگاه/سلف دیگری تحویل ثبت شده بودند:
          </p>
          <ul className="space-y-2 text-xs">
            {conflictItems.map((c) => (
              <li key={c.clientEventId} className="rounded-xl border border-destructive/40 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                  <span>
                    {c.holderName || 'نامشخص'} {c.holderIdentifier ? `(${faDigits(c.holderIdentifier)})` : ''} — {c.foodName || '—'}
                  </span>
                  <Pill tone="danger">{c.serverOutcome === 'OfflineConflict' ? 'OfflineConflict' : (c.serverOutcome ?? 'تعارض')}</Pill>
                </div>
                <div className="mt-1 text-muted-foreground">
                  اسکن در {faDateTime(c.scannedAt)} · پیام سرور: <strong className="text-foreground">{c.serverMessage || c.localMessage}</strong>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          {!result && (
            <Section>
              <div className="flex gap-2">
                <Button
                  className="h-12 flex-1 text-base"
                  variant={camera ? 'outline' : 'default'}
                  onClick={() => {
                    setCamera(!camera);
                    setCamError('');
                  }}
                >
                  {camera ? (
                    <>
                      <CameraOff className="ms-2 h-5 w-5" />
                      توقف دوربین
                    </>
                  ) : (
                    <>
                      <Camera className="ms-2 h-5 w-5" />
                      اسکن با دوربین
                    </>
                  )}
                </Button>
              </div>
              {camera && (
                <div className="relative mt-4 overflow-hidden rounded-xl bg-black">
                  <Webcam
                    ref={webcamRef}
                    audio={false}
                    videoConstraints={{ facingMode: 'environment' }}
                    className="aspect-square w-full object-cover"
                    onUserMediaError={() => {
                      setCamError('دسترسی به دوربین ممکن نیست. از ورود دستی کد استفاده کنید.');
                      setCamera(false);
                    }}
                  />
                  <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-[hsl(var(--sidebar-primary))]" />
                </div>
              )}
              {camError && <p className="mt-3 text-sm text-destructive">{camError}</p>}
              <form
                className="mt-4 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void scan(manual.trim());
                }}
              >
                <label htmlFor="manual" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Keyboard className="h-4 w-4" />
                  ورود دستی / اسکنر بارکد سخت‌افزاری {online ? '' : '(حالت آفلاین فعال)'}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="manual"
                    dir="ltr"
                    className="h-11 font-mono"
                    placeholder="کد تحویل ۸ کاراکتری یا محتوای QR"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    autoComplete="off"
                  />
                  <Button type="submit" className="h-11" disabled={!manual.trim() || busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : online ? 'بررسی' : 'اسکن آفلاین'}
                  </Button>
                </div>
              </form>
              {manifestMeta && (
                <p className="mt-3 text-xs text-muted-foreground">
                  پشتیبان آفلاین آماده است: {faDigits(String(manifestMeta.ticketCount))} بلیت رزرو امروز (آخرین دریافت:{' '}
                  {faDateTime(manifestMeta.syncedAt)})
                </p>
              )}
            </Section>
          )}
          {result && s && (
            <div className={cn('rounded-2xl border-2 p-6', s.cls)} role="status" aria-live="assertive">
              <div className="flex items-center gap-4">
                {s.icon}
                <div>
                  <h2 className="text-xl font-bold">{s.title}</h2>
                  {result.message && <p className="mt-1 text-sm text-muted-foreground">{result.message}</p>}
                </div>
              </div>
              {result.info && (
                <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">مشتری</dt>
                    <dd className="font-semibold">{result.info.holderName}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">شماره شناسایی</dt>
                    <dd className="num font-semibold">{faDigits(result.info.holderIdentifier)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">غذا</dt>
                    <dd className="font-semibold">{result.info.foodName}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">وعده</dt>
                    <dd className="font-semibold">
                      {MEALS[result.info.mealSlot] ?? result.info.mealSlot} · {faDate(result.info.serviceDate)}
                    </dd>
                  </div>
                </dl>
              )}
              <div className="mt-6 flex gap-2">
                {result.state === 'ready' && (
                  <Button className="h-12 flex-1 text-base" onClick={() => void confirm()} disabled={busy}>
                    {busy && <Loader2 className="ms-2 h-5 w-5 animate-spin" />}
                    ثبت تحویل
                  </Button>
                )}
                {result.state === 'network' && (
                  <Button className="h-12 flex-1" onClick={() => void scan(qr)} disabled={busy}>
                    <RotateCcw className="ms-2 h-4 w-4" />
                    تلاش دوباره
                  </Button>
                )}
                <Button variant="outline" className="h-12 flex-1 text-base" onClick={next} disabled={busy}>
                  اسکن بعدی
                </Button>
              </div>
            </div>
          )}

          <Section
            title={`صف رویدادهای آفلاین (${faDigits(String(queueItems.length))})`}
            actions={
              pendingCount > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void runSync(true, false)} disabled={!online || syncing}>
                  <RefreshCw className={cn('ms-1.5 h-3.5 w-3.5', syncing && 'animate-spin')} />
                  ارسال صف ({faDigits(String(pendingCount))})
                </Button>
              ) : undefined
            }
          >
            {queueItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">هیچ رویداد آفلاینی در این دستگاه ثبت نشده است.</p>
            ) : (
              <ul className="divide-y text-xs">
                {queueItems.slice(0, 25).map((item) => {
                  const badge = QUEUE_BADGE[item.syncStatus];
                  return (
                    <li key={item.clientEventId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div>
                        <div className="font-semibold">
                          {item.holderName
                            ? `${item.holderName} (${faDigits(item.holderIdentifier ?? '')}) · ${item.foodName ?? ''}`
                            : 'بلیت ناشناس / نامعتبر'}
                        </div>
                        <div className="mt-0.5 text-muted-foreground">
                          {faDateTime(item.scannedAt)} · {item.serverMessage || item.localMessage}
                        </div>
                      </div>
                      <Pill tone={badge.tone}>{badge.label}</Pill>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {(stats.data?.byMeal ?? []).map((m) => (
              <StatCard
                key={m.mealSlot}
                label={MEALS[m.mealSlot] ?? m.mealSlot}
                value={`${faNum(m.delivered)} / ${faNum(m.reserved)}`}
                hint="تحویل / رزرو"
              />
            ))}
            {stats.data && stats.data.byMeal.length === 0 && (
              <p className="col-span-2 text-sm text-muted-foreground">برای امروز وعده‌ای در این سلف تعریف نشده است.</p>
            )}
          </div>
          <Section title="آخرین تحویل‌های ثبت‌شده در سرور">
            {!stats.data?.recent.length ? (
              <p className="text-sm text-muted-foreground">هنوز تحویلی ثبت نشده است.</p>
            ) : (
              <ul className="divide-y text-sm">
                {stats.data.recent.map((r) => (
                  <li key={r.code + r.at} className="flex justify-between py-2">
                    <span>
                      {r.food} <span className="text-muted-foreground">· {MEALS[r.mealSlot] ?? r.mealSlot}</span>
                    </span>
                    <span className="num text-muted-foreground">
                      {faDigits(r.holderIdentifier)} · {faDateTime(r.at).split('،').pop()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
