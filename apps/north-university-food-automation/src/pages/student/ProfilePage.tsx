import { Lock } from 'lucide-react';
import { PageHeader, Section } from '../../components/ui-kit';
import { faDigits } from '../../lib/format';
import type { StudentMe } from '../../lib/session';

export default function ProfilePage({ me }: { me: StudentMe }) {
  const rows: [string, string][] = [
    ['نام و نام خانوادگی', me.fullName || '—'],
    ['شماره دانشجویی', faDigits(me.studentNumber)],
    ['کد ملی', faDigits(me.nationalIdMasked)],
    ['دانشکده', me.faculty || '—'],
    ['رشته', me.major || '—'],
    ['مقطع', me.degree || '—'],
    ['سال ورود', me.entryYear ? faDigits(String(me.entryYear)) : '—'],
  ];
  return (
    <>
      <PageHeader title="پروفایل" subtitle="اطلاعات از فایل رسمی معاونت دانشجویی خوانده می‌شود." />
      <Section>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {rows.map(([k, v]) => <div key={k} className="border-b pb-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-1 font-medium">{v}</dd></div>)}
        </dl>
        <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground"><Lock className="h-4 w-4" />برای اصلاح اطلاعات با معاونت دانشجویی تماس بگیرید. این اطلاعات توسط دانشجو قابل تغییر نیست.</p>
      </Section>
    </>
  );
}
