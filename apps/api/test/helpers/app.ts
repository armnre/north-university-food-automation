import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { readEnv, testEnv, type AppEnv } from '../../src/config/env.js';
import { buildApp, type AppInstance } from '../../src/app.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { createSilentLogger } from '../../src/lib/logger.js';
import { getTestDb, testDatabaseUrl } from './db.js';
import { invalidateSettingsCacheForDb } from '../../src/services/settings.service.js';

/**
 * ساخت نمونهٔ اپ برای تست‌های یکپارچه (با `app.inject` — بدون شبکه).
 * env تستی کامل است تا مسیر «fail-fast نبودِ کلید» هم قابل تست باشد.
 */

export type TestApp = {
  app: AppInstance;
  db: Db;
  env: AppEnv;
  log: Logger;
  close: () => Promise<void>;
};

export async function buildTestApp(overrides: Partial<Record<string, string>> = {}): Promise<TestApp> {
  const envResult = readEnv(testEnv({ DATABASE_URL: testDatabaseUrl(), ...overrides }) as NodeJS.ProcessEnv);
  if (!envResult.ok) throw new Error(`env تست نامعتبر: ${envResult.issues.join(' | ')}`);
  const env = envResult.env;
  const log = createSilentLogger();
  const db = getTestDb();
  invalidateSettingsCacheForDb(db);
  const app = await buildApp({ env, db, logger: log });
  await app.ready();
  return {
    app,
    db,
    env,
    log,
    close: async () => {
      await app.close();
    },
  };
}

/** ساخت اپ با pool مستقل (برای تست‌هایی که app را می‌بندند). */
export async function buildIsolatedApp(overrides: Partial<Record<string, string>> = {}): Promise<TestApp> {
  const envResult = readEnv(testEnv({ DATABASE_URL: testDatabaseUrl(), ...overrides }) as NodeJS.ProcessEnv);
  if (!envResult.ok) throw new Error(`env تست نامعتبر: ${envResult.issues.join(' | ')}`);
  const env = envResult.env;
  const log = createSilentLogger();
  const pool = createPool(testDatabaseUrl(), 12, 'food-test-isolated');
  const db = createDb(pool);
  invalidateSettingsCacheForDb(db);
  const app = (await buildApp({ env, db, logger: log })) as unknown as FastifyInstance & AppInstance;
  await app.ready();
  return {
    app: app as AppInstance,
    db,
    env,
    log,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// کلاینت تست با «jar» کوکی و مدیریت خودکار CSRF
// ---------------------------------------------------------------------------

export type TestClient = {
  get: <T = unknown>(url: string, query?: Record<string, unknown>) => Promise<TestResponse<T>>;
  post: <T = unknown>(url: string, body?: unknown) => Promise<TestResponse<T>>;
  put: <T = unknown>(url: string, body?: unknown) => Promise<TestResponse<T>>;
  patch: <T = unknown>(url: string, body?: unknown) => Promise<TestResponse<T>>;
  delete: <T = unknown>(url: string, body?: unknown) => Promise<TestResponse<T>>;
  upload: <T = unknown>(
    url: string,
    file: { name: string; buffer: Buffer; mimeType?: string },
    query?: Record<string, unknown>,
  ) => Promise<TestResponse<T>>;
  raw: (
    method: string,
    url: string,
    options?: { body?: unknown; headers?: Record<string, string>; query?: Record<string, unknown> },
  ) => Promise<TestResponse<unknown>>;
  cookies: () => Record<string, string>;
  csrf: () => string;
};

export type TestResponse<T> = {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
};

/**
 * کلاینت تست:
 *  - کوکی‌های پاسخ را نگه می‌دارد (نشست و CSRF)
 *  - برای متدهای غیر GET هدر `X-CSRF-Token` را از کوکی `csrf` می‌سازد
 *  - `Origin` هم‌دامنه ارسال می‌کند
 */
export function createTestClient(
  app: AppInstance,
  options: { origin?: string; host?: string; userAgent?: string; headers?: Record<string, string> } = {},
): TestClient {
  const jar: Record<string, string> = {};
  const origin = options.origin ?? 'http://localhost:3001';
  const host = options.host ?? 'localhost:3001';
  const userAgent = options.userAgent ?? 'vitest-agent';

  const absorbCookies = (headers: Record<string, string | string[] | undefined>): void => {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const cookieHeader of list) {
      const [pair] = String(cookieHeader).split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index <= 0 || !pair) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(String(cookieHeader))) delete jar[name];
      else jar[name] = value;
    }
  };

  const send = async (
    method: string,
    url: string,
    init: { body?: unknown; headers?: Record<string, string>; query?: Record<string, unknown> } = {},
  ): Promise<TestResponse<unknown>> => {
    const headers: Record<string, string> = {
      origin,
      host,
      'user-agent': userAgent,
      ...options.headers,
      ...init.headers,
    };
    const cookieHeader = Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    if (cookieHeader) headers.cookie = cookieHeader;
    if (method.toUpperCase() !== 'GET' && jar.csrf && !('x-csrf-token' in headers)) headers['x-csrf-token'] = jar.csrf;

    const response = await app.inject({
      method: method.toUpperCase() as 'GET',
      url,
      query: init.query as Record<string, string> | undefined,
      payload: init.body === undefined ? undefined : (init.body as object | string),
      headers,
    });

    absorbCookies(response.headers as unknown as Record<string, string | string[] | undefined>);

    const raw = response.body ?? '';
    const parsed: unknown = raw && typeof raw === 'string' ? tryParse(raw) : raw;
    return {
      status: response.statusCode,
      body: parsed,
      headers: response.headers as Record<string, string | string[] | undefined>,
      raw: String(raw),
    };
  };

  const client: TestClient = {
    get: (url, query) => send('GET', url, { query }) as never,
    post: (url, body) => send('POST', url, { body }) as never,
    put: (url, body) => send('PUT', url, { body }) as never,
    patch: (url, body) => send('PATCH', url, { body }) as never,
    delete: (url, body) => send('DELETE', url, { body }) as never,
    upload: async (url, file, query) => {
      const boundary = `----vitest${Date.now()}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mimeType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}\r\n\r\n`,
        'utf8',
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const payload = Buffer.concat([head, Buffer.from(new Uint8Array(file.buffer)), tail]);
      const headers: Record<string, string> = {
        origin,
        host,
        'user-agent': userAgent,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      };
      const cookieHeader = Object.entries(jar)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
      if (cookieHeader) headers.cookie = cookieHeader;
      if (jar.csrf) headers['x-csrf-token'] = jar.csrf;

      const queryString = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}` : '';
      const response = await app.inject({ method: 'POST', url: `${url}${queryString}`, payload, headers });
      absorbCookies(response.headers as unknown as Record<string, string | string[] | undefined>);
      const raw = response.body ?? '';
      const parsed: unknown = tryParse(String(raw));
      return {
        status: response.statusCode,
        body: parsed,
        headers: response.headers as Record<string, string | string[] | undefined>,
        raw: String(raw),
      } as never;
    },
    raw: (method, url, init) => send(method, url, init),
    cookies: () => ({ ...jar }),
    csrf: () => jar.csrf ?? '',
  };

  return client;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** گرفتن کوکی CSRF با یک GET بی‌خطر. */
export async function primeCsrf(client: TestClient): Promise<string> {
  await client.get('/api/v1/auth/setup-status');
  return client.csrf();
}

/** ورود به‌عنوان دانشجو و برگرداندن کلاینت احراز‌هویت‌شده. */
export async function loginStudent(
  app: AppInstance,
  studentNumber: string,
  nationalId: string,
  options: { userAgent?: string } = {},
): Promise<TestClient> {
  const client = createTestClient(app, { userAgent: options.userAgent });
  await primeCsrf(client);
  const response = await client.post('/api/v1/auth/student/login', { studentNumber, nationalId });
  if (response.status !== 200) {
    throw new Error(`ورود دانشجو ناموفق بود (${response.status}): ${response.raw}`);
  }
  return client;
}

/** ورود به‌عنوان کارکنان. */
export async function loginStaff(app: AppInstance, username: string, password: string): Promise<TestClient> {
  const client = createTestClient(app);
  await primeCsrf(client);
  const response = await client.post('/api/v1/auth/staff/login', { username, password });
  if (response.status !== 200) {
    throw new Error(`ورود کارکنان ناموفق بود (${response.status}): ${response.raw}`);
  }
  return client;
}

/** ورود به‌عنوان کارمند (مشتری سلف). */
export async function loginEmployee(app: AppInstance, username: string, password: string): Promise<TestClient> {
  const client = createTestClient(app);
  await primeCsrf(client);
  const response = await client.post('/api/v1/auth/employee/login', { username, password });
  if (response.status !== 200) {
    throw new Error(`ورود کارمند ناموفق بود (${response.status}): ${response.raw}`);
  }
  return client;
}
