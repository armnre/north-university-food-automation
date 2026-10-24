import type { Env } from '../env.js';

export type SmsSender = (to: string, body: string) => Promise<void>;

/** Console provider logs only (dev/staging); kavenegar sends for real. Secrets are never logged. */
export function smsFromEnv(env: Env, log: { info: (o: object, m: string) => void }): SmsSender {
  if (env.SMS_PROVIDER === 'kavenegar' && env.KAVENEGAR_API_KEY) {
    const key = env.KAVENEGAR_API_KEY;
    return async (to, body) => {
      const params = new URLSearchParams({ receptor: to, message: body });
      if (env.KAVENEGAR_SENDER) params.set('sender', env.KAVENEGAR_SENDER);
      const res = await fetch(`https://api.kavenegar.com/v1/${key}/sms/send.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`kavenegar HTTP ${res.status}`);
    };
  }
  return async (to, body) => log.info({ to: to.replace(/\d(?=\d{4})/g, '*'), len: body.length }, 'sms (console)');
}
