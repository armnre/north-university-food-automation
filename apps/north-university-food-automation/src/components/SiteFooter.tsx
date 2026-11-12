import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { publicInfo } from '../lib/api';

type Info = { supportText: string; helpText: string; policyText: string };
const ENAMAD_ID = import.meta.env.VITE_ENAMAD_ID as string | undefined;
const ENAMAD_CODE = import.meta.env.VITE_ENAMAD_CODE as string | undefined;

/** Public footer (login page): about / contact / rules + e-Namad trust seal — required for e-Namad review. */
export default function SiteFooter() {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState<null | 'about' | 'contact' | 'rules'>(null);
  useEffect(() => { publicInfo({}).then((r) => setInfo(r as Info)).catch(() => setInfo(null)); }, []);
  const pages = {
    about: { title: 'درباره ما', body: info?.helpText || 'سامانه رسمی رزرو، پرداخت اینترنتی و تحویل غذای سلف مرکزی دانشگاه شمال؛ زیر نظر معاونت دانشجویی و فرهنگی دانشگاه.' },
    contact: { title: 'تماس با ما', body: info?.supportText || 'اداره تغذیه دانشگاه شمال' },
    rules: { title: 'قوانین و مقررات', body: info?.policyText || 'رزرو غذا تا ۴۸ ساعت پیش از هر وعده امکان‌پذیر است. مبالغ پرداختی از طریق درگاه رسمی بانک سامان دریافت می‌شود.' },
  } as const;
  return (
    <footer className="mt-6 space-y-3 text-center text-[11px] text-muted-foreground">
      <nav className="flex justify-center gap-4">
        {(Object.keys(pages) as (keyof typeof pages)[]).map((k) => (
          <button key={k} type="button" className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => setOpen(k)}>{pages[k].title}</button>
        ))}
      </nav>
      {ENAMAD_ID && ENAMAD_CODE && (
        <a referrerPolicy="origin" target="_blank" rel="noreferrer" href={`https://trustseal.enamad.ir/?id=${ENAMAD_ID}&Code=${ENAMAD_CODE}`} className="inline-block">
          <img referrerPolicy="origin" src={`https://trustseal.enamad.ir/logo.aspx?id=${ENAMAD_ID}&Code=${ENAMAD_CODE}`} alt="نماد اعتماد الکترونیکی" className="h-20 cursor-pointer" />
        </a>
      )}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{open && pages[open].title}</DialogTitle></DialogHeader>
          <p className="whitespace-pre-line text-sm leading-7">{open && pages[open].body}</p>
        </DialogContent>
      </Dialog>
    </footer>
  );
}
