// providers/tests/signature.test.ts
//
// The shared signature primitives, tested at their own level.
//
// These cases are cheap here and expensive anywhere else: secret rotation, a
// duplicated header, a timestamp that starts with digits and then stops being a
// number. Each one is a real way a webhook endpoint is bypassed or wedged, and
// none of them is visible from a test that only checks the happy path.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { parseSignatureHeader, singleHeader, verifyTimestampedHmac } from '../signature';

const SECRET = 'whsec_test';
const OTHER = 'whsec_rotated';
const BODY = new TextEncoder().encode('{"id":"evt_1"}');

const digest = (secret: string, ts: number) =>
  createHmac('sha256', secret)
    .update(`${ts}.${Buffer.from(BODY).toString('utf8')}`)
    .digest('hex');

const verify = (header: string, nowMs = 1_000_000 * 1000) =>
  verifyTimestampedHmac({
    body: BODY,
    header,
    secret: SECRET,
    pairSeparator: ',',
    payloadSeparator: '.',
    timestampKey: 't',
    signatureKey: 'v1',
    now: () => nowMs,
  });

describe('singleHeader', () => {
  it('is case-insensitive, because header casing is the proxy s choice', () => {
    assert.equal(singleHeader({ 'Stripe-Signature': 'x' }, 'stripe-signature'), 'x');
  });

  it('refuses a repeated header rather than picking one', () => {
    // Choosing the first or the last lets whoever can inject a header decide
    // which signature gets checked.
    assert.equal(singleHeader({ 'x-sig': ['a', 'b'] }, 'x-sig'), null);
    assert.equal(singleHeader({ 'X-Sig': 'a', 'x-sig': 'b' }, 'x-sig'), null);
  });

  it('accepts a single-element array, which is how some frameworks hand it over', () => {
    assert.equal(singleHeader({ 'x-sig': ['a'] }, 'x-sig'), 'a');
  });
});

describe('parseSignatureHeader', () => {
  it('accumulates repeated keys, which is how a secret rotation is delivered', () => {
    const parsed = parseSignatureHeader('t=1,v1=aa,v1=bb', ',');
    assert.deepEqual(parsed.get('v1'), ['aa', 'bb']);
  });

  it('ignores a header long enough to be a denial of service', () => {
    // Parsing happens before authentication: the one place an unauthenticated
    // caller decides how much work we do.
    assert.equal(parseSignatureHeader(`t=1,v1=${'a'.repeat(5000)}`, ',').size, 0);
  });
});

describe('verifyTimestampedHmac', () => {
  it('accepts a correct signature', () => {
    assert.deepEqual(verify(`t=1000000,v1=${digest(SECRET, 1_000_000)}`), {
      ok: true,
      timestamp: 1_000_000,
    });
  });

  it('accepts either digest during a rotation', () => {
    const header = `t=1000000,v1=${digest(OTHER, 1_000_000)},v1=${digest(SECRET, 1_000_000)}`;
    assert.equal(verify(header).ok, true);
  });

  it('rejects a digest for a different body', () => {
    const wrong = createHmac('sha256', SECRET).update('1000000.{}').digest('hex');
    assert.deepEqual(verify(`t=1000000,v1=${wrong}`), { ok: false, reason: 'mismatch' });
  });

  it('rejects a timestamp that only starts out numeric', () => {
    // `parseInt('1000000abc')` is 1000000, so a permissive parse would verify a
    // payload the sender never signed.
    assert.deepEqual(verify(`t=1000000abc,v1=${digest(SECRET, 1_000_000)}`), {
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a header with no digest', () => {
    assert.deepEqual(verify('t=1000000'), { ok: false, reason: 'malformed' });
  });

  it('rejects non-hex where a digest belongs', () => {
    assert.deepEqual(verify('t=1000000,v1=zzzz'), { ok: false, reason: 'mismatch' });
  });

  it('separates stale from mismatched', () => {
    const header = `t=1000000,v1=${digest(SECRET, 1_000_000)}`;
    assert.deepEqual(verify(header, (1_000_000 + 301) * 1000), {
      ok: false,
      reason: 'stale',
    });
    // Inside tolerance, either side of now.
    assert.equal(verify(header, (1_000_000 + 299) * 1000).ok, true);
    assert.equal(verify(header, (1_000_000 - 299) * 1000).ok, true);
  });

  it('checks freshness only after the signature holds', () => {
    // Otherwise an unauthenticated caller can learn our clock by timing which
    // rejection it gets.
    assert.deepEqual(verify('t=1,v1=deadbeef', 999_999_999_999), {
      ok: false,
      reason: 'mismatch',
    });
  });
});
