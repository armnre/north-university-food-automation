import { sql } from 'drizzle-orm';
import { tehranDate } from '@food/shared';
import type { Db, Tx } from '../db/client.js';
import type { Principal } from '../lib/auth.js';
import { sha256 } from '../lib/crypto.js';
import { toDate } from '../lib/customer.js';
import { audit } from './audit.js';
import { getSettings, num } from './settings.js';

export type ScanState = 'ready' | 'delivered' | 'already' | 'cancelled' | 'invalid' | 'wrongCafeteria' | 'wrongDay' | 'expired' | 'outOfWindow';
const OUTCOME: Partial<Record<ScanState, string>> = {
  already: 'AlreadyDelivered',
  cancelled: 'Cancelled',
  invalid: 'NotFound',
  wrongCafeteria: 'WrongCafeteria',
  wrongDay: 'OutOfWindow',
  expired: 'OutOfWindow',
  outOfWindow: 'OutOfWindow',
};

/** Accepts the opaque QR token, or the 8-char manual code with/without `R-` prefix (case-insensitive). */
export function normalizeScan(raw: string): { kind: 'token'; value: string } | { kind: 'code'; value: string } | null {
  const t = String(raw ?? '').trim();
  if (/^[A-Za-z0-9_-]{32}$/.test(t)) return { kind: 'token', value: t };
  const c = t
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^R(?=[A-Z0-9]{8}$)/, '');
  return /^[A-Z0-9]{8}$/.test(c) ? { kind: 'code', value: `R-${c}` } : null;
}

type Row = {
  id: string;
  code: string;
  status: string;
  delivered_at: Date | null;
  delivered_by_name: string | null;
  cafeteria_id: string;
  service_date: string;
  meal_starts_at: Date;
  meal_ends_at: Date;
  owner_number: string | null;
  owner_name: string;
  food_name: string;
  slot: string;
};

export async function inspect(db: Db | Tx, p: Principal, raw: string, now = new Date()) {
  const s = normalizeScan(raw);
  if (!s) return { state: 'invalid' as ScanState, info: null, row: null };
  const r = await db.execute<Row>(sql`
    SELECT r.id, r.code, r.status, r.delivered_at, su.full_name AS delivered_by_name, o.cafeteria_id, o.service_date, o.meal_starts_at, o.meal_ends_at,
      st.student_number AS owner_number, COALESCE(st.first_name || ' ' || st.last_name, e.first_name || ' ' || e.last_name, '') AS owner_name, f.name AS food_name, ms.code AS slot
    FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id JOIN foods f ON f.id=o.food_id JOIN meal_slots ms ON ms.id=o.meal_slot_id
    JOIN accounts a ON a.id=r.account_id LEFT JOIN students st ON st.id=a.student_id LEFT JOIN employees e ON e.id=a.employee_id
    LEFT JOIN staff_users su ON su.id=r.delivered_by
    WHERE ${s.kind === 'token' ? sql`r.qr_token = ${s.value}` : sql`r.code = ${s.value}`}`);
  const row = r.rows[0];
  if (!row) return { state: 'invalid' as ScanState, info: null, row: null };
  const settings = await getSettings(db);
  const info = {
    reservationId: row.id,
    code: row.code.replace(/^R-/, ''),
    studentNumber: row.owner_number ?? '',
    studentName: row.owner_name,
    foodName: row.food_name,
    mealType: { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' }[row.slot] ?? row.slot,
    serviceDate: row.service_date,
    deliveredAt: row.delivered_at ? toDate(row.delivered_at).toISOString() : null,
    deliveredBy: row.delivered_by_name ?? null,
  };
  const today = tehranDate(now);
  let state: ScanState = 'ready';
  if (row.status === 'Delivered') state = 'already';
  else if (row.status !== 'Reserved') state = 'cancelled';
  else if (p.role === 'Operator' && p.cafeteriaId && row.cafeteria_id !== p.cafeteriaId) state = 'wrongCafeteria';
  else if (row.service_date < today) state = 'expired';
  else if (row.service_date > today) state = 'wrongDay';
  else {
    const open = toDate(row.meal_starts_at).getTime() - num(settings, 'scan_window_before_minutes') * 60_000;
    const close = toDate(row.meal_ends_at).getTime() + num(settings, 'scan_window_after_minutes') * 60_000;
    if (now.getTime() < open || now.getTime() > close) state = 'outOfWindow';
  }
  return { state, info, row };
}

/** Exactly-once delivery: conditional UPDATE; zero rows → already delivered. Every attempt is logged in `deliveries`. */
export async function confirm(
  db: Db,
  p: Principal,
  raw: string,
  opts: { clientEventId?: string; deviceId?: string; offline?: boolean; scannedAt?: Date } = {},
) {
  return db.transaction(async (tx) => {
    if (opts.clientEventId) {
      const prev = await tx.execute<{ outcome: string; reservation_id: string | null }>(
        sql`SELECT outcome, reservation_id FROM deliveries WHERE client_event_id = ${opts.clientEventId}`,
      );
      if (prev.rows[0])
        return { state: (prev.rows[0].outcome === 'Accepted' ? 'delivered' : 'already') as ScanState, info: null, outcome: prev.rows[0].outcome, replay: true };
    }
    const ins = await inspect(tx, p, raw, opts.offline ? (opts.scannedAt ?? new Date()) : new Date());
    const log = (outcome: string, resId: string | null) =>
      tx.execute(sql`INSERT INTO deliveries (reservation_id, operator_id, cafeteria_id, outcome, client_event_id, device_id, offline, scanned_at)
      VALUES (${resId}, ${p.id}, ${p.cafeteriaId}, ${outcome}::delivery_outcome, ${opts.clientEventId ?? null}, ${opts.deviceId ?? null}, ${opts.offline ?? false}, ${opts.scannedAt ?? new Date()})`);
    if (ins.state !== 'ready' || !ins.row) {
      const outcome = ins.state === 'already' && opts.offline ? 'OfflineConflict' : (OUTCOME[ins.state] ?? 'NotFound');
      await log(outcome, ins.row?.id ?? null);
      return { state: ins.state, info: ins.info, outcome, replay: false };
    }
    const u = await tx.execute<{ delivered_at: Date }>(
      sql`UPDATE reservations SET status='Delivered', delivered_at=now(), delivered_by=${p.id}, updated_at=now() WHERE id=${ins.row.id} AND status='Reserved' RETURNING delivered_at`,
    );
    if (!u.rows[0]) {
      await log(opts.offline ? 'OfflineConflict' : 'AlreadyDelivered', ins.row.id);
      return { state: 'already' as ScanState, info: ins.info, outcome: opts.offline ? 'OfflineConflict' : 'AlreadyDelivered', replay: false };
    }
    await log('Accepted', ins.row.id);
    await tx.execute(
      sql`INSERT INTO reservation_history (reservation_id, from_status, to_status, actor, note) VALUES (${ins.row.id}, 'Reserved', 'Delivered', ${p.actor}, ${opts.offline ? 'offline' : 'scan'})`,
    );
    await audit(tx, { actor: p.actor, action: 'delivery.accept', entityType: 'Reservation', entityId: ins.row.id, data: { offline: !!opts.offline } });
    return {
      state: 'delivered' as ScanState,
      info: { ...ins.info!, deliveredAt: toDate(u.rows[0].delivered_at).toISOString() },
      outcome: 'Accepted',
      deliveredAt: toDate(u.rows[0].delivered_at).toISOString(),
      replay: false,
    };
  });
}

/** Today's Reserved tickets for the operator's cafeteria as sha256(token) only — raw tokens never leave the server. */
export async function offlineManifest(db: Db, p: Principal) {
  const r = await db.execute<{ qr_token: string; code: string; owner: string; food: string; slot: string }>(sql`
    SELECT r.qr_token, r.code, COALESCE(st.student_number, e.username) AS owner, f.name AS food, ms.code AS slot
    FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id JOIN foods f ON f.id=o.food_id JOIN meal_slots ms ON ms.id=o.meal_slot_id
    JOIN accounts a ON a.id=r.account_id LEFT JOIN students st ON st.id=a.student_id LEFT JOIN employees e ON e.id=a.employee_id
    WHERE r.status='Reserved' AND o.service_date=${tehranDate()} AND (${p.cafeteriaId}::uuid IS NULL OR o.cafeteria_id=${p.cafeteriaId}::uuid)`);
  return {
    generatedAt: new Date().toISOString(),
    serviceDate: tehranDate(),
    entries: r.rows.map((x) => ({ tokenHash: sha256(x.qr_token), codeHash: sha256(x.code), owner: x.owner.slice(-4), food: x.food, slot: x.slot })),
  };
}
