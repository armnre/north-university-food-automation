import { Lock } from 'lucide-react';
import { PageHeader, Section } from '../../components/ui-kit';
import { faDigits } from '../../lib/format';
import { CUSTOMER_KIND_LABEL, ID_LABEL, isStudent, type StudentMe } from '../../lib/session';

export default function ProfilePage({ me }: { me: StudentMe }) {
  const student = isStudent(me);
  const kind = me.customerKind ?? 'Student';
  const rows: [string, string][] = student ? [
    ['نام و نام خانوادگی', me.fullName || '—'],
    ['شماره دانشجویی', faDigits(me.studentNumber)],
    ['کد ملی', faDigits(me.nationalIdMasked)],
    ['دانشکده', me.faculty || '—'],
    ['رشته', me.major || '—'],
    ['مقطع', me.degree || '—'],
    ['سال ورود', me.entryYear ? faDigits(String(me.entryYear)) : '—'],
  ] : [
    ['نام و نام خانوادگی', me.fullName || '—'],
    ['نوع کاربر', CUSTOMER_KIND_LABEL[kind] ?? kind],
    [ID_LABEL[kind] ?? 'نام کاربری', faDigits(me.studentNumber)],
  ];
  return (
    <>
      <PageHeader title="پروفایل" subtitle={student ? 'اطلاعات از فایل رسمی معاونت دانشجویی خوانده می‌شود.' : 'اطلاعات از فهرست رسمی کارکنان و اعضای هیئت علمی دانشگاه خوانده می‌شود.'} />
      <Section>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {rows.map(([k, v]) => <div key={k} className="border-b pb-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-1 font-medium">{v}</dd></div>)}
        </dl>
        <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground"><Lock className="h-4 w-4" />{student ? 'برای اصلاح اطلاعات با معاونت دانشجویی تماس بگیرید. این اطلاعات توسط دانشجو قابل تغییر نیست.' : 'برای اصلاح اطلاعات با واحد اداری دانشگاه تماس بگیرید.'}</p>
      </Section>
    </>
  );
}
