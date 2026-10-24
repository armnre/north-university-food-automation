import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { requirePrincipal } from '../lib/auth.js';
import { fail } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { MAX_IMAGE_BYTES, storeFoodImage } from '../services/images.js';

export function uploadRoutes(app: FastifyInstance, db: Db, env: Env) {
  app.post('/api/v1/uploads/food-image', { config: { access: 'catalogWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
    if (!file) fail('BAD_REQUEST', 'فایلی ارسال نشده است.');
    const buf = await file.toBuffer();
    if (file.file.truncated) fail('BAD_REQUEST', 'حجم تصویر بیش از ۲ مگابایت است.');
    const r = await storeFoodImage(env.UPLOAD_DIR, buf);
    await audit(db, {
      actor: p.actor,
      action: 'upload.food-image',
      entityType: 'File',
      entityId: r.fileName,
      data: { processed: r.processed },
      requestId: req.id,
    });
    return { url: `/uploads/foods/${r.fileName}`, processed: r.processed };
  });

  // Uploads live outside the web root and are served only by this strict handler (no directory listing, no traversal).
  app.get('/uploads/foods/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string().regex(/^[0-9a-f-]{36}\.(webp|jpg|png)$/) }).parse(req.params);
    const file = path.join(env.UPLOAD_DIR, 'foods', name);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'فایل پیدا نشد.' } });
    const type = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return reply
      .header('content-type', type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(file));
  });
}
