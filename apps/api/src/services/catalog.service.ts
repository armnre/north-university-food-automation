import { eq } from 'drizzle-orm';
import { cafeterias, contractors, foods, mealSlots, offeringPriceHistory } from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import type { Actor, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';

/** کاتالوگ: پیمانکاران، سلف‌ها، غذاها و وعده‌ها (CRUD با غیرفعال‌سازی به‌جای حذف). */

export type CatalogList = Awaited<ReturnType<typeof listCatalog>>;

export async function listCatalog(target: Tx | ServiceDeps['db']) {
  const [contractorRows, cafeteriaRows, foodRows, slotRows] = await Promise.all([
    target.select().from(contractors).orderBy(contractors.name),
    target.select().from(cafeterias).orderBy(cafeterias.name),
    target.select().from(foods).orderBy(foods.name),
    target.select().from(mealSlots).orderBy(mealSlots.sortOrder),
  ]);

  const contractorName = new Map(contractorRows.map((c) => [c.id, c.name]));
  return {
    contractors: contractorRows.map((c) => ({
      id: c.id,
      name: c.name,
      contractNumber: c.contractNumber,
      contactPhone: c.contactPhone,
      contractFrom: c.contractFrom,
      contractTo: c.contractTo,
      isActive: c.isActive,
    })),
    cafeterias: cafeteriaRows.map((c) => ({
      id: c.id,
      name: c.name,
      location: c.location,
      contractorId: c.contractorId,
      contractorName: (c.contractorId && contractorName.get(c.contractorId)) || '',
      isActive: c.isActive,
    })),
    foods: foodRows.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      category: f.category,
      imagePath: f.imagePath,
      calories: f.calories,
      defaultPriceRial: f.defaultPriceRial == null ? null : Number(f.defaultPriceRial),
      defaultCapacity: f.defaultCapacity,
      isActive: f.isActive,
    })),
    mealSlots: slotRows.map((s) => ({
      id: s.id,
      code: s.code,
      title: s.title,
      startTime: String(s.startTime),
      endTime: String(s.endTime),
      isActive: s.isActive,
    })),
  };
}

export type CatalogItemInput =
  | {
      kind: 'contractor';
      id?: string;
      name: string;
      contractNumber: string;
      contactPhone?: string;
      contractFrom?: string;
      contractTo?: string;
      isActive: boolean;
    }
  | { kind: 'cafeteria'; id?: string; name: string; location: string; contractorId?: string | null; isActive: boolean }
  | {
      kind: 'food';
      id?: string;
      name: string;
      description: string;
      category?: string;
      imagePath?: string;
      calories?: number | null;
      defaultPriceRial?: number | null;
      defaultCapacity?: number | null;
      isActive: boolean;
    };

/** ساخت یا به‌روزرسانی یک آیتم کاتالوگ (بدون حذف فیزیکی). */
export async function saveCatalogItem(
  deps: ServiceDeps,
  input: { item: CatalogItemInput; actor: Actor; ip: string },
): Promise<{ id: string }> {
  const { item, actor, ip } = input;

  return deps.db.transaction(async (tx) => {
    let id: string;
    let before: Record<string, unknown> | null = null;

    if (item.kind === 'contractor') {
      if (item.id) {
        const existing = await tx.select().from(contractors).where(eq(contractors.id, item.id)).limit(1);
        if (!existing[0]) fail('NOT_FOUND', 'پیمانکار یافت نشد.');
        before = { name: existing[0].name, contractNumber: existing[0].contractNumber, isActive: existing[0].isActive };
        await tx
          .update(contractors)
          .set({
            name: item.name.trim(),
            contractNumber: item.contractNumber.trim(),
            contactPhone: item.contactPhone?.trim() || null,
            contractFrom: item.contractFrom ?? null,
            contractTo: item.contractTo ?? null,
            isActive: item.isActive,
          })
          .where(eq(contractors.id, item.id));
        id = item.id;
      } else {
        const [created] = await tx
          .insert(contractors)
          .values({
            name: item.name.trim(),
            contractNumber: item.contractNumber.trim(),
            contactPhone: item.contactPhone?.trim() || null,
            contractFrom: item.contractFrom ?? null,
            contractTo: item.contractTo ?? null,
            isActive: item.isActive,
          })
          .returning({ id: contractors.id });
        id = created!.id;
      }
    } else if (item.kind === 'cafeteria') {
      if (item.id) {
        const existing = await tx.select().from(cafeterias).where(eq(cafeterias.id, item.id)).limit(1);
        if (!existing[0]) fail('NOT_FOUND', 'سلف یافت نشد.');
        before = { name: existing[0].name, contractorId: existing[0].contractorId, isActive: existing[0].isActive };
        await tx
          .update(cafeterias)
          .set({ name: item.name.trim(), location: item.location.trim(), contractorId: item.contractorId ?? null, isActive: item.isActive })
          .where(eq(cafeterias.id, item.id));
        id = item.id;
      } else {
        const [created] = await tx
          .insert(cafeterias)
          .values({
            name: item.name.trim(),
            location: item.location.trim(),
            contractorId: item.contractorId ?? null,
            isActive: item.isActive,
          })
          .returning({ id: cafeterias.id });
        id = created!.id;
      }
    } else {
      if (item.id) {
        const existing = await tx.select().from(foods).where(eq(foods.id, item.id)).limit(1);
        if (!existing[0]) fail('NOT_FOUND', 'غذا یافت نشد.');
        before = { name: existing[0].name, defaultPriceRial: existing[0].defaultPriceRial, isActive: existing[0].isActive };
        await tx
          .update(foods)
          .set({
            name: item.name.trim(),
            description: item.description,
            category: item.category?.trim() ?? '',
            imagePath: item.imagePath?.trim() || null,
            calories: item.calories ?? null,
            defaultPriceRial: item.defaultPriceRial ?? null,
            defaultCapacity: item.defaultCapacity ?? null,
            isActive: item.isActive,
          })
          .where(eq(foods.id, item.id));
        id = item.id;
      } else {
        const [created] = await tx
          .insert(foods)
          .values({
            name: item.name.trim(),
            description: item.description,
            category: item.category?.trim() ?? '',
            imagePath: item.imagePath?.trim() || null,
            calories: item.calories ?? null,
            defaultPriceRial: item.defaultPriceRial ?? null,
            defaultCapacity: item.defaultCapacity ?? null,
            isActive: item.isActive,
          })
          .returning({ id: foods.id });
        id = created!.id;
      }
    }

    await writeAudit(tx, {
      actor,
      action: `${item.kind}.${item.id ? 'update' : 'create'}`,
      targetType: item.kind,
      targetId: id,
      details: { name: item.name, isActive: item.isActive, before },
      ip,
    });

    return { id };
  });
}

/** سلف پیش‌فرض (حالت تک‌سلفی): اولین سلف فعال. */
export async function defaultCafeteriaId(target: Tx | ServiceDeps['db']): Promise<string> {
  const rows = await target.select({ id: cafeterias.id }).from(cafeterias).where(eq(cafeterias.isActive, true)).limit(1);
  if (rows[0]) return rows[0].id;
  const any = await target.select({ id: cafeterias.id }).from(cafeterias).limit(1);
  if (any[0]) return any[0].id;
  const [created] = await target
    .insert(cafeterias)
    .values({ name: 'سلف مرکزی', location: '', isActive: true })
    .returning({ id: cafeterias.id });
  return created!.id;
}

export async function getMealSlotByCode(
  target: Tx | ServiceDeps['db'],
  code: string,
): Promise<{ id: string; title: string; startTime: string; endTime: string } | null> {
  const rows = await target.select().from(mealSlots).where(eq(mealSlots.code, code)).limit(1);
  const row = rows[0];
  return row ? { id: row.id, title: row.title, startTime: String(row.startTime), endTime: String(row.endTime) } : null;
}

/** ویرایش ساعت وعده‌ها (از صفحهٔ تنظیمات). */
export async function updateMealSlots(
  deps: ServiceDeps,
  input: { slots: { id: string; title: string; startTime: string; endTime: string; isActive: boolean }[]; actor: Actor; ip: string },
): Promise<number> {
  let updated = 0;
  await deps.db.transaction(async (tx) => {
    for (const slot of input.slots) {
      const existing = await tx.select().from(mealSlots).where(eq(mealSlots.id, slot.id)).limit(1);
      if (!existing[0]) throw new AppError('NOT_FOUND', 'وعدهٔ انتخاب‌شده یافت نشد.');
      if (slot.endTime <= slot.startTime) {
        throw new AppError('VALIDATION', `ساعت پایان «${slot.title}» باید بعد از ساعت شروع آن باشد.`);
      }
      await tx
        .update(mealSlots)
        .set({ title: slot.title.trim(), startTime: slot.startTime, endTime: slot.endTime, isActive: slot.isActive })
        .where(eq(mealSlots.id, slot.id));
      updated += 1;
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: 'settings.meal_slots.update',
      targetType: 'MealSlot',
      targetId: '',
      details: { slots: input.slots },
      ip: input.ip,
    });
  });
  return updated;
}

/** ثبت تاریخچهٔ تغییر قیمت (پس از انتشار وعده). */
export async function recordPriceHistory(
  target: Tx,
  input: {
    offeringId: string;
    customerGroup: string;
    fromPriceRial: number | null;
    toPriceRial: number;
    changedBy: string | null;
    reason: string | null;
  },
): Promise<void> {
  await target.insert(offeringPriceHistory).values({
    offeringId: input.offeringId,
    customerGroup: input.customerGroup,
    fromPriceRial: input.fromPriceRial,
    toPriceRial: input.toPriceRial,
    changedBy: input.changedBy,
    reason: input.reason,
  });
}
