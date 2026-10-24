import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { seeded } from './db.js';

export const TEST_ORIGIN = 'http://localhost:3101';

export async function testApp(overrides: Record<string, string> = {}) {
  await seeded();
  const env = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: TEST_ORIGIN,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    NATIONAL_ID_PEPPER: 'p'.repeat(40),
    CSRF_SECRET: 'c'.repeat(40),
    SETUP_CODE: 'setup-code-0123456789',
    UPLOAD_DIR: '/tmp/food-test-uploads',
    TRUSTED_PROXY_HOPS: '1',
    ...overrides,
  } as NodeJS.ProcessEnv);
  const pool = createPool(env.DATABASE_URL, 20);
  const db = createDb(pool);
  const app = await buildApp({ env, db, pool });
  return {
    app,
    db,
    pool,
    env,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** Minimal cookie-jar client that performs CSRF double-submit like the browser adapter. */
export class Client {
  jar = new Map<string, string>();
  constructor(
    private app: FastifyInstance,
    public ip = '10.0.0.1',
  ) {}
  private cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private absorb(r: LightMyRequestResponse) {
    for (const c of r.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
  }
  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    if (method !== 'GET' && !this.jar.has('__Host-csrf'))
      this.absorb(await this.app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { 'x-forwarded-for': this.ip } }));
    const r = await this.app.inject({
      method,
      url,
      payload: body as object | undefined,
      headers: {
        cookie: this.cookieHeader(),
        'x-forwarded-for': this.ip,
        origin: TEST_ORIGIN,
        ...(method !== 'GET' ? { 'x-csrf-token': this.jar.get('__Host-csrf') ?? '' } : {}),
        ...headers,
      },
    });
    this.absorb(r);
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as any) : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

export type { Db };
