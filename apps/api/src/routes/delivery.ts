import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { tehranDate } from '@food/shared';
import type { Db } from '../db/client.js';
import { requirePrincipal } from '../lib/auth.js';
import { iso, MEAL_TYPE } from '../lib/customer.js';
import { confirm, inspect, offlineManifest } from '../services/delivery.js';

export function deliveryRoutes(app: FastifyInstance, db: Db) {
  const scan = { config: { access: 'deliveryScan' as const } };
  const body = z.object({ qrToken: z.string().max(200) });

  app.post('/api/v1/delivery/scan', scan, async (req) => {
    const r = await inspect(db, requirePrincipal(req), body.parse(req.body).qrToken);
    return { state: r.state, info: r.info };
  });

  app.post('/api/v1/delivery/confirm', scan, async (req) => {
    const r = await confirm(db, requirePrincipal(req), body.parse(req.body).qrToken);
    return { state: r.state, info: r.info, deliveredAt: 'deliveredAt' in r ? r.deliveredAt : undefined };
  });

  app.get('/api/v1/delivery/offline-manifest', scan, async (req) => offlineManifest(db, requirePrincipal(req)));

  app.post('/api/v1/delivery/sync', scan, async (req) => {
    const p = requirePrincipal(req);
    const b = z
      .object({
        deviceId: z.string().min(8).max(64),
        events: z.array(z.object({ clientEventId: z.string().uuid(), qrToken: z.string().max(200), scannedAt: z.string().datetime() })).max(50),
      })
      .parse(req.body);
    const results = [];
    for (const e of b.events) {
      const r = await confirm(db, p, e.qrToken, { clientEventId: e.clientEventId, deviceId: b.deviceId, offline: true, scannedAt: new Date(e.scannedAt) });
      results.push({ clientEventId: e.clientEventId, outcome: r.outcome, state: r.state, replay: r.replay });
    }
    return { results };
  });

  app.get('/api/v1/delivery/stats', scan, async (req) => {
    const p = requirePrincipal(req);
    const today = tehranDate();
    const caf = p.cafeteriaId;
    const [stats, recent, cafe] = await Promise.all([
      db.execute<{ slot: string; reserved: number; delivered: number }>(sql`
        SELECT ms.code AS slot, count(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved, count(r.id) FILTER (WHERE r.status='Delivered')::int AS delivered
        FROM meal_offerings o JOIN meal_slots ms ON ms.id=o.meal_slot_id LEFT JOIN reservations r ON r.offering_id=o.id
        WHERE o.service_date=${today} AND (${caf}::uuid IS NULL OR o.cafeteria_id=${caf}::uuid) GROUP BY ms.code, ms.sort_order ORDER BY ms.sort_order`),
      db.execute<Record<string, unknown>>(sql`
        SELECT d.created_at AS at, r.code, COALESCE(st.student_number, e.username) AS owner, f.name AS food, ms.code AS slot
        FROM deliveries d JOIN reservations r ON r.id=d.reservation_id JOIN meal_offerings o ON o.id=r.offering_id JOIN foods f ON f.id=o.food_id JOIN meal_slots ms ON ms.id=o.meal_slot_id
        JOIN accounts a ON a.id=r.account_id LEFT JOIN students st ON st.id=a.student_id LEFT JOIN employees e ON e.id=a.employee_id
        WHERE d.outcome='Accepted' AND o.service_date=${today} AND (${caf}::uuid IS NULL OR o.cafeteria_id=${caf}::uuid) ORDER BY d.created_at DESC LIMIT 20`),
      caf ? db.execute<{ name: string }>(sql`SELECT name FROM cafeterias WHERE id=${caf}`) : Promise.resolve({ rows: [] as { name: string }[] }),
    ]);
    return {
      today,
      cafeteriaName: cafe.rows[0]?.name ?? (caf ? '' : 'همه سلف‌ها'),
      byMeal: stats.rows.map((x) => ({ meal: MEAL_TYPE[x.slot] ?? x.slot, reserved: x.reserved, delivered: x.delivered })),
      recent: recent.rows.map((x) => ({
        at: iso(x.at as Date),
        code: String(x.code).replace(/^R-/, ''),
        studentNumber: x.owner,
        food: x.food,
        meal: MEAL_TYPE[x.slot as string] ?? x.slot,
      })),
    };
  });
}
