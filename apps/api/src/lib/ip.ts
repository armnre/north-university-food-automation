import type { FastifyRequest } from 'fastify';

/**
 * Single source of the client IP. Reads X-Forwarded-For from the END of the chain, skipping
 * `hops - 1` trusted proxies (nginx appends the real peer last), falling back to the socket address.
 */
export function getClientIp(req: FastifyRequest, hops: number): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return socketIp;
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;
  return chain[Math.max(0, chain.length - hops)] ?? socketIp;
}
