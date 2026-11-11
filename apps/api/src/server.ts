import { loadEnv } from './env.js';
import { createDb, createPool } from './db/client.js';
import { buildApp } from './app.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const app = await buildApp({ env, db: createDb(pool), pool });
await app.listen({ host: env.HOST, port: env.PORT });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
