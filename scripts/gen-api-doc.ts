import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { PERMISSIONS } from '../packages/shared/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { createDb } from '../apps/api/src/db/client.js';
import { loadEnv } from '../apps/api/src/env.js';

// Builds the app without connecting (the pool is lazy) and documents every registered /api/v1 route with its access level.
const env = loadEnv({ NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgres://none', NATIONAL_ID_PEPPER: 'x'.repeat(32), CSRF_SECRET: 'x'.repeat(32), UPLOAD_DIR: '/tmp' } as NodeJS.ProcessEnv);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const app = await buildApp({ env, db: createDb(pool), pool, gateway: null });
const reg = (app as unknown as { routeRegistry: { method: string; url: string; access: string }[] }).routeRegistry;
const rows = [...reg].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
  .map((r) => `| \`${r.method}\` | \`${r.url}\` | ${r.access === 'public' ? 'عمومی' : r.access === 'authenticated' ? 'هر کاربر واردشده' : `\`${r.access}\` — ${PERMISSIONS[r.access as keyof typeof PERMISSIONS]}`} |`);
writeFileSync('docs/API.md', `# API\n\n> خودکار از رجیستری routeهای Fastify تولید می‌شود (\`npm run docs:api\`). ${reg.length} route.\n\nهمه‌ی پاسخ‌های خطا: \`{ "error": { "code", "message", "details?" } }\` با پیام فارسی. درخواست‌های تغییردهنده به کوکی نشست \`__Host-sid\` و هدر \`x-csrf-token\` (برابر کوکی \`__Host-csrf\`) نیاز دارند. مبالغ به ریال صحیح‌اند.\n\nمسیرهای بیرون از \`/api/v1\`: \`GET /api/health\`، \`GET /api/ready\`، \`GET /uploads/foods/:name\`.\n\n| متد | مسیر | دسترسی |\n|---|---|---|\n${rows.join('\n')}\n`);
await app.close(); await pool.end();
console.log(`docs/API.md: ${reg.length} routes`);
