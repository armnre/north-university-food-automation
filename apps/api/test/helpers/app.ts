import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { seeded } from './db.js';

export const TEST_ORIGIN = 'http://localhost:3101';

export async function testApp(overrides: Record<string, string> = {}, gateway: import('../../src/services/gateway.js').PaymentGateway | null = null) {
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
  const app = await buildApp({ env, db, pool, gateway });
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
  async upload(url: string, file: { name: string; data: Buffer; type?: string }, fields: Record<string, string> = {}) {
    if (!this.jar.has('__Host-csrf')) this.absorb(await this.app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { 'x-forwarded-for': this.ip } }));
    const b = '----foodtest' + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(
      Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from(`\r\n--${b}--\r\n`),
    );
    const r = await this.app.inject({
      method: 'POST',
      url,
      payload: Buffer.concat(parts),
      headers: {
        'content-type': `multipart/form-data; boundary=${b}`,
        cookie: this.cookieHeader(),
        'x-forwarded-for': this.ip,
        origin: TEST_ORIGIN,
        'x-csrf-token': this.jar.get('__Host-csrf') ?? '',
      },
    });
    this.absorb(r);
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as any) : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  async raw(url: string) {
    const r = await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookieHeader(), 'x-forwarded-for': this.ip } });
    return { status: r.statusCode, headers: r.headers, body: r.rawPayload };
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
