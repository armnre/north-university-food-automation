/** All money is integer rial carried as bigint on the server and as a decimal string over JSON. */
export type Rial = bigint;

export function parseRial(v: string | number | bigint): Rial {
  if (typeof v === 'bigint') return v;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new Error('INVALID_RIAL');
  return BigInt(s);
}

export const rialToJson = (v: Rial) => v.toString();

/** Safe conversion for UI display; values above 2^53 are not expected for a dining system. */
export function rialToNumber(v: Rial): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('RIAL_OUT_OF_RANGE');
  return Number(v);
}
