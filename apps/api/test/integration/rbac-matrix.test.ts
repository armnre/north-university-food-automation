import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPermission, ROLE_PERMISSIONS, STAFF_ROLES, type Permission, type Role } from '@food/shared';
import { Client, testApp } from '../helpers/app.js';
import { makeEmployee, makeStaff, makeStudent, STAFF_PASSWORD } from '../helpers/factory.js';

/**
 * Enumerates EVERY registered /api/v1 route and checks each role is allowed/denied exactly as the shared matrix says.
 * A route registered without an access declaration fails at boot (onRoute hook), so it can never slip through.
 */
const DENIED = 'شما به این بخش دسترسی ندارید.';
let t: Awaited<ReturnType<typeof testApp>>;
const clients = new Map<Role, Client>();
const routes: { method: string; url: string; access: string }[] = [];

beforeAll(async () => {
  t = await testApp();
  routes.push(...((t.app as unknown as { routeRegistry: typeof routes }).routeRegistry ?? []));
  for (const role of STAFF_ROLES) {
    const u = await makeStaff(t.db, role);
    const c = new Client(t.app, `10.9.${STAFF_ROLES.indexOf(role)}.1`);
    await c.req('POST', '/api/v1/auth/staff/login', { username: u.username, password: STAFF_PASSWORD });
    clients.set(role, c);
  }
  const s = await makeStudent(t.db);
  const sc = new Client(t.app, '10.9.20.1');
  await sc.req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
  clients.set('Student', sc);
  const e = await makeEmployee(t.db);
  const ec = new Client(t.app, '10.9.21.1');
  await ec.req('POST', '/api/v1/auth/employee/login', { username: e.username, password: STAFF_PASSWORD });
  clients.set('Employee', ec);
});
afterAll(async () => {
  await t.close();
});

describe('role × route matrix', () => {
  it('has a non-empty registry and every route declares access', () => {
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) expect(r.access, `${r.method} ${r.url}`).toBeTruthy();
  });

  it('anonymous requests to protected routes get 401', async () => {
    const anon = new Client(t.app, '10.9.30.1');
    for (const r of routes.filter((x) => x.access !== 'public')) {
      const res = await anon.req(r.method as 'GET', r.url.replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000'), {});
      expect(res.status, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('each role is allowed or forbidden exactly per the matrix', async () => {
    for (const r of routes.filter((x) => x.access !== 'public' && x.access !== 'authenticated')) {
      for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
        const res = await clients.get(role)!.req(r.method as 'GET', r.url.replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000'), {});
        const denied = res.status === 403 && res.body?.error?.message === DENIED;
        if (hasPermission(role, r.access as Permission)) expect(denied, `${role} ${r.method} ${r.url}`).toBe(false);
        else expect(denied, `${role} ${r.method} ${r.url} → ${res.status}`).toBe(true);
      }
    }
  });
});

describe('default deny', () => {
  it('registering a /api/v1 route without access aborts', async () => {
    const x = await testApp();
    expect(() => x.app.get('/api/v1/oops', async () => ({}))).toThrow(/no access declaration/);
    await x.close().catch(() => undefined);
  });
});
