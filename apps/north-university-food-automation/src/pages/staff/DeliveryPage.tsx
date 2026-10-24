import { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { BarcodeDetector } from 'barcode-detector/pure';
import { AlertTriangle, Ban, Camera, CameraOff, CheckCircle2, Clock, Keyboard, Loader2, MapPinOff, RotateCcw, WifiOff, XCircle } from 'lucide-react';
import { deliveryConfirm, deliveryScan, deliveryStats } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { cn } from '@project/components/lib/utils';
import { PageHeader, Section, StatCard } from '../../components/ui-kit';
import { MEALS, faDate, faDateTime, faDigits, faNum } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { ScanResult } from '../../lib/types';

const STATES: Record<ScanResult['state'], { title: string; cls: string; icon: React.ReactNode }> = {
  ready: { title: 'رزرو معتبر و آماده‌ی تحویل', cls: 'border-[hsl(var(--info))] bg-[hsl(var(--info)/0.08)]', icon: <CheckCircle2 className="h-10 w-10 text-[hsl(var(--info))]" /> },
  delivered: { title: 'تحویل با موفقیت ثبت شد', cls: 'border-[hsl(var(--success))] bg-[hsl(var(--success)/0.1)]', icon: <CheckCircle2 className="h-10 w-10 text-[hsl(var(--success))]" /> },
  already: { title: 'این رزرو قبلاً تحویل شده است', cls: 'border-destructive bg-destructive/10', icon: <Ban className="h-10 w-10 text-destructive" /> },
  cancelled: { title: 'رزرو لغو یا رد شده است', cls: 'border-destructive bg-destructive/10', icon: <XCircle className="h-10 w-10 text-destructive" /> },
  invalid: { title: 'کد نامعتبر است', cls: 'border-destructive bg-destructive/10', icon: <AlertTriangle className="h-10 w-10 text-destructive" /> },
  wrongCafeteria: { title: 'این رزرو متعلق به سلف دیگری است', cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]', icon: <MapPinOff className="h-10 w-10 text-[hsl(var(--warning))]" /> },
  wrongDay: { title: 'این رزرو برای روز دیگری است', cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]', icon: <Clock className="h-10 w-10 text-[hsl(var(--warning))]" /> },
  expired: { title: 'رزرو منقضی شده است', cls: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]', icon: <Clock className="h-10 w-10 text-[hsl(var(--warning))]" /> },
  network: { title: 'خطا در ارتباط با سرور', cls: 'border-destructive bg-destructive/10', icon: <WifiOff className="h-10 w-10 text-destructive" /> },
};

export default function DeliveryPage() {
  const { token } = useSession();
  const stats = useLoad(async (t) => (await deliveryStats({ token: t })) as { today: string; cafeteriaName: string; byMeal: { meal: string; reserved: number; delivered: number }[]; recent: { at: string; code: string; studentNumber: string; food: string; meal: string }[] });
  const [camera, setCamera] = useState(false);
  const [camError, setCamError] = useState('');
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const webcamRef = useRef<Webcam>(null);
  const lastRef = useRef('');

  const scan = useCallback(async (value: string) => {
    if (!value || busy) return;
    setBusy(true); setQr(value);
    try { setResult((await deliveryScan({ token, qrToken: value })) as ScanResult); }
    catch { setResult({ state: 'network', info: null }); }
    finally { setBusy(false); }
  }, [token, busy]);

  const confirm = async () => {
    setBusy(true);
    try { setResult((await deliveryConfirm({ token, qrToken: qr })) as ScanResult); stats.reload(); }
    catch { setResult({ state: 'network', info: null }); }
    finally { setBusy(false); }
  };
  const next = () => { setResult(null); setQr(''); setManual(''); lastRef.current = ''; };

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
          if (v && v !== lastRef.current) { lastRef.current = v; scan(v); return; }
        } catch { /* frame not ready */ }
      }
      if (!stop) setTimeout(tick, 250);
    };
    tick();
    return () => { stop = true; };
  }, [camera, result, scan]);

  const s = result ? STATES[result.state] : null;
  return (
    <>
      <PageHeader title="تحویل غذا" subtitle={stats.data ? `${stats.data.cafeteriaName} · ${faDate(stats.data.today)}` : undefined} />
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          {!result && (
            <Section>
              <div className="flex gap-2">
                <Button className="h-12 flex-1 text-base" variant={camera ? 'outline' : 'default'} onClick={() => { setCamera(!camera); setCamError(''); }}>{camera ? <><CameraOff className="ms-2 h-5 w-5" />توقف دوربین</> : <><Camera className="ms-2 h-5 w-5" />اسکن با دوربین</>}</Button>
              </div>
              {camera && (
                <div className="relative mt-4 overflow-hidden rounded-xl bg-black">
                  <Webcam ref={webcamRef} audio={false} videoConstraints={{ facingMode: 'environment' }} className="aspect-square w-full object-cover" onUserMediaError={() => { setCamError('دسترسی به دوربین ممکن نیست. از ورود دستی کد استفاده کنید.'); setCamera(false); }} />
                  <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-[hsl(var(--sidebar-primary))]" />
                </div>
              )}
              {camError && <p className="mt-3 text-sm text-destructive">{camError}</p>}
              <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); scan(manual.trim()); }}>
                <label htmlFor="manual" className="flex items-center gap-1.5 text-sm text-muted-foreground"><Keyboard className="h-4 w-4" />ورود دستی / اسکنر بارکد سخت‌افزاری</label>
                <div className="flex gap-2"><Input id="manual" dir="ltr" className="h-11 font-mono" placeholder="کد تحویل ۸ رقمی یا محتوای QR" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" /><Button type="submit" className="h-11" disabled={!manual.trim() || busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'بررسی'}</Button></div>
              </form>
            </Section>
          )}
          {result && s && (
            <div className={cn('rounded-2xl border-2 p-6', s.cls)} role="status" aria-live="assertive">
              <div className="flex items-center gap-4">{s.icon}<h2 className="text-xl font-bold">{s.title}</h2></div>
              {result.info && (
                <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">دانشجو</dt><dd className="font-semibold">{result.info.studentName}</dd></div>
                  <div><dt className="text-muted-foreground">شماره دانشجویی</dt><dd className="num font-semibold">{faDigits(result.info.studentNumber)}</dd></div>
                  <div><dt className="text-muted-foreground">غذا</dt><dd className="font-semibold">{result.info.foodName}</dd></div>
                  <div><dt className="text-muted-foreground">وعده</dt><dd className="font-semibold">{MEALS[result.info.mealType]} · {faDate(result.info.serviceDate)}</dd></div>
                </dl>
              )}
              <div className="mt-6 flex gap-2">
                {result.state === 'ready' && <Button className="h-12 flex-1 text-base" onClick={confirm} disabled={busy}>{busy && <Loader2 className="ms-2 h-5 w-5 animate-spin" />}ثبت تحویل</Button>}
                {result.state === 'network' && <Button className="h-12 flex-1" onClick={() => scan(qr)} disabled={busy}><RotateCcw className="ms-2 h-4 w-4" />تلاش دوباره</Button>}
                <Button variant="outline" className="h-12 flex-1 text-base" onClick={next} disabled={busy}>اسکن بعدی</Button>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {(stats.data?.byMeal ?? []).map((m) => <StatCard key={m.meal} label={MEALS[m.meal] ?? m.meal} value={`${faNum(m.delivered)} / ${faNum(m.reserved)}`} hint="تحویل / رزرو" />)}
            {stats.data && stats.data.byMeal.length === 0 && <p className="col-span-2 text-sm text-muted-foreground">برای امروز وعده‌ای در این سلف تعریف نشده است.</p>}
          </div>
          <Section title="آخرین تحویل‌ها">
            {!stats.data?.recent.length ? <p className="text-sm text-muted-foreground">هنوز تحویلی ثبت نشده است.</p> : (
              <ul className="divide-y text-sm">{stats.data.recent.map((r) => <li key={r.code + r.at} className="flex justify-between py-2"><span>{r.food} <span className="text-muted-foreground">· {MEALS[r.meal]}</span></span><span className="num text-muted-foreground">{faDigits(r.studentNumber)} · {faDateTime(r.at).split('،').pop()}</span></li>)}</ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
