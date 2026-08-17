// providers/signature.ts
//
// Webhook signature primitives, shared by every adapter that signs with a
// timestamped HMAC.
//
// Two providers use the same construction with different punctuation: a header
// of `key=value` pairs carrying a timestamp and one or more digests, over a
// payload that joins the timestamp to the raw body. Stripe separates pairs with
// `,` and joins with `.`; Paddle separates with `;` and joins with `:`. Nothing
// else differs, so the difference is two configuration fields rather than two
// implementations, and a bug fixed here is fixed for both.
//
// Everything in this file operates on bytes. The moment a body has been through
// JSON.parse and back it is a different byte sequence — different key order,
// different whitespace, different number formatting — and no signature over it
// can match. That failure has no useful error message, which is why the types
// upstream make the object form unrepresentable rather than documenting it.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A signature header long enough to be an attack is not a signature.
 *
 * Parsing is linear, but it happens before authentication — the one place where
 * an unauthenticated caller controls how much work we do. Cheap bound, applied
 * first.
 */
const MAX_HEADER_BYTES = 4096;

/** How far out of step a timestamp may be before a signature is treated as a
 *  replay. Five minutes is the interoperable default; a clock further out than
 *  this is a machine problem, not a security event. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Read exactly one header value, case-insensitively.
 *
 * A repeated signature header returns null rather than picking one. Choosing
 * the first, or the last, lets an attacker who can inject a header decide which
 * signature is checked; refusing the request is the only answer that does not
 * depend on the proxy in front of us.
 */
export const singleHeader = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null => {
  const wanted = name.toLowerCase();
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) return value.length === 1 ? (value[0] ?? null) : null;
    if (found !== null) return null;
    found = value;
  }
  return found;
};

/**
 * Parse `a=1,b=2,b=3` into `{ a: ['1'], b: ['2', '3'] }`.
 *
 * Repeated keys accumulate because that is how signature rotation works: during
 * a secret roll the provider sends both digests under the same key and the
 * caller must accept either.
 */
export const parseSignatureHeader = (header: string, pairSeparator: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  if (header.length > MAX_HEADER_BYTES) return out;
  for (const part of header.split(pairSeparator)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    const existing = out.get(key);
    if (existing) existing.push(value);
    else out.set(key, [value]);
  }
  return out;
};

/**
 * Compare a computed digest against a candidate.
 *
 * Length is compared first and is not secret: the digest length is fixed by the
 * algorithm, so leaking it leaks nothing. The bytes are then compared in
 * constant time, because a byte-by-byte `===` on a hex string tells an attacker
 * how many leading characters were right, and that is enough to forge one
 * character at a time.
 */
export const hexEquals = (computed: Buffer, candidate: string): boolean => {
  if (!/^[0-9a-fA-F]*$/.test(candidate)) return false;
  const given = Buffer.from(candidate, 'hex');
  if (given.length !== computed.length) return false;
  return timingSafeEqual(given, computed);
};

export interface TimestampedHmacInput {
  body: Uint8Array;
  header: string;
  secret: string;
  /** Character between `key=value` pairs in the header. */
  pairSeparator: string;
  /** Character joining the timestamp to the body in the signed payload. */
  payloadSeparator: string;
  /** Header key holding the timestamp. */
  timestampKey: string;
  /** Header key holding the digest. */
  signatureKey: string;
  toleranceSeconds?: number;
  /** Injected so tests are not a function of the wall clock. Never used for
   *  anything that becomes a billing boundary. */
  now?: () => number;
}

export type SignatureVerdict =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'malformed' | 'mismatch' | 'stale' };

/**
 * Verify a timestamped HMAC-SHA256 signature.
 *
 * Returns a verdict rather than throwing, so the caller decides the error
 * shape. `stale` is separated from `mismatch` because the operational response
 * differs: a burst of stale signatures means clock skew somewhere, while a
 * burst of mismatches means the wrong secret or someone probing.
 */
export const verifyTimestampedHmac = (input: TimestampedHmacInput): SignatureVerdict => {
  const parsed = parseSignatureHeader(input.header, input.pairSeparator);
  const timestampRaw = parsed.get(input.timestampKey)?.[0];
  const candidates = parsed.get(input.signatureKey) ?? [];
  if (timestampRaw === undefined || candidates.length === 0) return { ok: false, reason: 'malformed' };

  // Reject before parsing rather than trusting parseInt to stop at the first
  // non-digit: `12abc` is not a timestamp and should not verify as 12.
  if (!/^\d{1,15}$/.test(timestampRaw)) return { ok: false, reason: 'malformed' };
  const timestamp = Number(timestampRaw);

  const signed = Buffer.concat([
    Buffer.from(`${timestampRaw}${input.payloadSeparator}`, 'utf8'),
    Buffer.from(input.body),
  ]);
  const computed = createHmac('sha256', input.secret).update(signed).digest();

  // No short-circuit: check every candidate and combine the results, so the
  // time taken does not reveal which digest matched during a secret rotation.
  let matched = false;
  for (const candidate of candidates) matched = hexEquals(computed, candidate) || matched;
  if (!matched) return { ok: false, reason: 'mismatch' };

  // Freshness is checked only after the signature holds. Checking it first
  // would let an unauthenticated caller learn our clock.
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return { ok: false, reason: 'stale' };

  return { ok: true, timestamp };
};
