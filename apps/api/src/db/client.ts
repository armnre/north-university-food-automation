import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

// bigint columns (int8) come back as strings by default; parse as BigInt for exact rial math.
pg.types.setTypeParser(20, (v) => BigInt(v));
// date columns stay as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createPool(url: string, max: number) {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: 'food-api' });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export { schema };
