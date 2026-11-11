import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export function systemRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1 FROM system_settings LIMIT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not-ready' });
    }
  });
}
