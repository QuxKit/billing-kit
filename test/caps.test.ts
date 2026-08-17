// Input caps: the bounds that turn "unbounded" into a typed refusal.
//
// Pure, because every check here fires before a statement is sent. The
// executor doubles below either refuse to be called at all (the cap is checked
// first) or feed the paging loop full pages forever, which is the one input
// that proves the loop has a ceiling.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import { RECORD_MANY_MAX, recordMany } from '../src/events';
import { ENTRIES_MAX_ROWS, entries } from '../src/ledger';
import { Quantity } from '../src/money';
import type { SqlExecutor, UsageEvent } from '../src/types';

const NOW = new Date('2026-08-13T12:00:00Z');

const neverCalled: SqlExecutor = {
  query: async () => {
    throw new Error('the cap must be checked before any SQL is sent');
  },
  transaction: async () => {
    throw new Error('the cap must be checked before any SQL is sent');
  },
};

const anEvent = (i: number): UsageEvent => ({
  tenantId: 't',
  subjectId: 's',
  source: 'api',
  externalId: `req-${i}`,
  metric: 'tokens.input',
  quantity: Quantity.fromBigInt(1n),
  occurredAt: NOW,
});

describe('recordMany batch cap', () => {
  it('refuses a batch above RECORD_MANY_MAX with batch_too_large, before touching the database', async () => {
    const events = Array.from({ length: RECORD_MANY_MAX + 1 }, (_, i) => anEvent(i));
    await assert.rejects(
      recordMany(neverCalled, events, NOW),
      (e: unknown) =>
        BillingError.hasCode(e, 'batch_too_large') &&
        e.failure.operation === 'recordMany' &&
        e.failure.size === RECORD_MANY_MAX + 1 &&
        e.failure.max === RECORD_MANY_MAX,
    );
  });

  it('is exactly RECORD_MANY_MAX, not one less', async () => {
    // At the cap the check passes and the call proceeds to the database — which
    // this double refuses, so a rejection with the double's message is the proof.
    const events = Array.from({ length: RECORD_MANY_MAX }, (_, i) => anEvent(i));
    await assert.rejects(recordMany(neverCalled, events, NOW), /before any SQL/);
  });
});

describe('entries() hard bound', () => {
  it('refuses an explicit limit above ENTRIES_MAX_ROWS with result_too_large', async () => {
    await assert.rejects(
      entries(neverCalled, { tenantId: 't', subjectId: 's', limit: ENTRIES_MAX_ROWS + 1 }),
      (e: unknown) =>
        BillingError.hasCode(e, 'result_too_large') &&
        e.failure.what === 'ledger_entries' &&
        e.failure.max === ENTRIES_MAX_ROWS &&
        e.failure.requested === ENTRIES_MAX_ROWS + 1,
    );
    await assert.rejects(entries(neverCalled, { tenantId: 't', subjectId: 's', limit: -1 }), (e: unknown) =>
      BillingError.hasCode(e, 'result_too_large'),
    );
  });

  it('stops the unbounded walk at ENTRIES_MAX_ROWS with an error, never a short array', async () => {
    // A ledger that never ends: every page comes back full. Rows are shaped
    // like the driver's output so toEntry() accepts them.
    let page = 0;
    const endless: SqlExecutor = {
      query: async <T>(_text: string, params?: readonly unknown[]): Promise<T[]> => {
        page += 1;
        const size = 1000;
        const rows = Array.from({ length: size }, (_, i) => ({
          id: `e-${page}-${i}`,
          transaction_id: '00000000-0000-0000-0000-000000000000',
          tenant_id: params?.[0],
          subject_id: params?.[1],
          account: 'cash',
          currency: 'USD',
          amount_minor: '1',
          leg_no: i,
          source_kind: 'payment',
          source_id: 'p',
          posted_at: NOW,
          memo: null,
        }));
        return rows as T[];
      },
      transaction: async () => {
        throw new Error('not used');
      },
    };
    await assert.rejects(
      entries(endless, { tenantId: 't', subjectId: 's' }),
      (e: unknown) => BillingError.hasCode(e, 'result_too_large') && e.failure.requested === undefined,
    );
    assert.equal(page, ENTRIES_MAX_ROWS / 1000, 'walked exactly to the bound and no further');
  });
});
