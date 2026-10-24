import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { requirePrincipal } from '../lib/auth.js';
import { n } from '../lib/customer.js';
import { fail } from '../lib/errors.js';
import { audit } from '../services/audit.js';

const MEAL = z.enum(['Breakfast', 'Lunch', 'Dinner']);
const item = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('contractor'),
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(150),
    contractNumber: z.string().max(80),
    contactPhone: z.string().max(30),
    active: z.boolean(),
  }),
  z.object({
    kind: z.literal('cafeteria'),
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(150),
    location: z.string().max(200),
    contractorId: z.string().uuid().nullable(),
    active: z.boolean(),
  }),
  z.object({
    kind: z.literal('food'),
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(150),
    description: z.string().max(1000),
    active: z.boolean(),
    category: z.string().max(60).optional(),
    defaultPriceRial: z.number().int().min(0).max(100_000_000).nullable().optional(),
    defaultCapacity: z.number().int().min(0).max(100_000).nullable().optional(),
    suitableMeals: z.array(MEAL).optional(),
    imagePath: z.string().max(200).nullable().optional(),
  }),
]);

export function catalogRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/v1/catalog', { config: { access: 'menuRead' } }, async () => {
    const [c, cf, f] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`SELECT id, name, contract_number, contact_phone, active FROM contractors ORDER BY name`),
      db.execute<Record<string, unknown>>(
        sql`SELECT cf.id, cf.name, cf.location, cf.active, cf.contractor_id, c.name AS contractor_name FROM cafeterias cf LEFT JOIN contractors c ON c.id = cf.contractor_id ORDER BY cf.name`,
      ),
      db.execute<Record<string, unknown>>(
        sql`SELECT id, name, description, active, category, default_price_rial, default_capacity, suitable_meals, image_path FROM foods ORDER BY name LIMIT 2000`,
      ),
    ]);
    return {
      contractors: c.rows.map((x) => ({
        id: x.id,
        name: x.name,
        contractNumber: x.contract_number ?? '',
        contactPhone: x.contact_phone ?? '',
        active: x.active,
      })),
      cafeterias: cf.rows.map((x) => ({
        id: x.id,
        name: x.name,
        location: x.location ?? '',
        active: x.active,
        contractorId: x.contractor_id ?? null,
        contractorName: x.contractor_name ?? '',
      })),
      foods: f.rows.map((x) => ({
        id: x.id,
        name: x.name,
        description: x.description ?? '',
        active: x.active,
        isDemo: false,
        category: x.category ?? '',
        defaultPriceRial: x.default_price_rial == null ? null : n(x.default_price_rial as bigint),
        defaultCapacity: x.default_capacity ?? null,
        suitableMeals: x.suitable_meals ?? [],
        imageUrl: x.image_path ? `/uploads/${x.image_path}` : '',
        imagePath: x.image_path ?? null,
      })),
    };
  });

  app.put('/api/v1/catalog', { config: { access: 'catalogWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const it = item.parse(req.body);
    let id: string | undefined;
    if (it.kind === 'contractor') {
      const r = it.id
        ? await db.execute<{ id: string }>(
            sql`UPDATE contractors SET name=${it.name}, contract_number=${it.contractNumber}, contact_phone=${it.contactPhone || null}, active=${it.active}, updated_at=now() WHERE id=${it.id} RETURNING id`,
          )
        : await db.execute<{ id: string }>(
            sql`INSERT INTO contractors (name, contract_number, contact_phone, active) VALUES (${it.name}, ${it.contractNumber}, ${it.contactPhone || null}, ${it.active}) RETURNING id`,
          );
      id = r.rows[0]?.id;
    } else if (it.kind === 'cafeteria') {
      const r = it.id
        ? await db.execute<{ id: string }>(
            sql`UPDATE cafeterias SET name=${it.name}, location=${it.location}, contractor_id=${it.contractorId}, active=${it.active}, updated_at=now() WHERE id=${it.id} RETURNING id`,
          )
        : await db.execute<{ id: string }>(
            sql`INSERT INTO cafeterias (name, location, contractor_id, active) VALUES (${it.name}, ${it.location}, ${it.contractorId}, ${it.active}) RETURNING id`,
          );
      id = r.rows[0]?.id;
    } else {
      if (it.imagePath && !/^[a-z0-9-]+\.(jpg|png|webp)$/.test(it.imagePath)) fail('BAD_REQUEST', 'تصویر نامعتبر است.');
      const meals = `{${(it.suitableMeals ?? []).join(',')}}`;
      const price = it.defaultPriceRial == null ? null : String(it.defaultPriceRial);
      const r = it.id
        ? await db.execute<{ id: string }>(
            sql`UPDATE foods SET name=${it.name}, description=${it.description}, active=${it.active}, category=${it.category ?? null}, default_price_rial=${price}::bigint, default_capacity=${it.defaultCapacity ?? null}, suitable_meals=${meals}::text[], image_path=COALESCE(${it.imagePath ?? null}, image_path), updated_at=now() WHERE id=${it.id} RETURNING id`,
          )
        : await db.execute<{ id: string }>(
            sql`INSERT INTO foods (name, description, active, category, default_price_rial, default_capacity, suitable_meals, image_path) VALUES (${it.name}, ${it.description}, ${it.active}, ${it.category ?? null}, ${price}::bigint, ${it.defaultCapacity ?? null}, ${meals}::text[], ${it.imagePath ?? null}) RETURNING id`,
          );
      id = r.rows[0]?.id;
    }
    if (!id) fail('NOT_FOUND', 'رکورد پیدا نشد.');
    await audit(db, {
      actor: p.actor,
      action: `${it.kind}.${it.id ? 'update' : 'create'}`,
      entityType: it.kind,
      entityId: id,
      data: { name: it.name, active: it.active },
      requestId: req.id,
    });
    return { id };
  });
}
