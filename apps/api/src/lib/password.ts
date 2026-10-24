import argon2 from 'argon2';

// OWASP-recommended Argon2id baseline (19 MiB, t=2, p=1). argon2's prebuilt binary does not require AVX2.
export const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= argon2.hash(`dummy-${Math.random()}`, ARGON2_OPTS));

export const hashPassword = (pw: string) => argon2.hash(pw, ARGON2_OPTS);

/** Always runs a verify (against a dummy hash for unknown users) to equalise timing. */
export async function verifyPassword(hash: string | null | undefined, pw: string): Promise<boolean> {
  try {
    const ok = await argon2.verify(hash ?? (await dummyHash()), pw);
    return !!hash && ok;
  } catch {
    return false;
  }
}

export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 10) return 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.';
  if (pw.length > 128) return 'رمز عبور بیش از حد طولانی است.';
  return null;
}
