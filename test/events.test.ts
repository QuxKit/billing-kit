// Ingest tests. These run against a real Postgres, on purpose.
//
// The interesting behaviour here is not in the TypeScript — it is in what
// `ON CONFLICT DO UPDATE` does under a concurrent transaction, and whether the
// partitioned table actually routes rows. A mock executor would assert that we
// send the SQL we decided to send, which is a test of a decision, not of a
// system. Everything the mock could tell us we already know from reading the
// file.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import { queryUsage, record, recordMany, validateEvent } from '../src/events';
import { Quantity } from '../src/money';
import type { SqlExecutor, UsageEvent } from '../src/types';
import { SKIP_REASON, setupDatabase, type Harness } from './pg-executor';

const NOW = new Date('2026-08-13T12:00:00Z');

let n = 0;
function anEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  n += 1;
  return {
    tenantId: 'tenant-1',
    subjectId: 'subject-1',
    source: 'api',
    externalId: `req-${n}`,
    metric: 'tokens.input',
    quantity: Quantity.fromBigInt(100n),
    occurredAt: new Date('2026-08-13T10:00:00Z'),
    ...overrides,
  };
}

describe('validateEvent', () => {
  it('names the field and the reason, not just "invalid"', () => {
    assert.throws(
      () => validateEvent(anEvent({ externalId: '' }), NOW),
      (e: unknown) => BillingError.hasCode(e, 'invalid_event') && e.failure.field === 'externalId',
    );
    assert.throws(
      () => validateEvent(anEvent({ metric: 'x'.repeat(300) }), NOW),
      (e: unknown) => BillingError.hasCode(e, 'invalid_event') && e.failure.field === 'metric',
    );
  });

  it('rejects a quantity that is not exact', () => {
    assert.throws(
      () => validateEvent(anEvent({ quantity: 1.5 as unknown as Quantity }), NOW),
      (e: unknown) => BillingError.hasCode(e, 'invalid_event') && e.failure.field === 'quantity',
    );
  });

  it('rejects an event dated past the clock-skew bound', () => {
    // An event from the future lands in a window that will be sealed and
    // invoiced before its real time arrives. There is no correcting it later.
    assert.throws(
      () => validateEvent(anEvent({ occurredAt: new Date('2026-08-20T00:00:00Z') }), NOW),
      (e: unknown) => BillingError.hasCode(e, 'invalid_event') && e.failure.field === 'occurredAt',
    );
    // Inside the bound is fine: producers are allowed to be a little wrong.
    validateEvent(anEvent({ occurredAt: new Date('2026-08-13T18:00:00Z') }), NOW);
  });

  it('rejects an invalid Date rather than storing it as NULL', () => {
    assert.throws(
      () => validateEvent(anEvent({ occurredAt: new Date('nonsense') }), NOW),
      (e: unknown) => BillingError.hasCode(e, 'invalid_event'),
    );
  });
});

const harness = await setupDatabase();

// Top level, not inside a suite: the pool is shared by every suite in this
// file, and closing it in the first one leaves the rest talking to a dead pool.
after(async () => {
  await harness?.close();
});

describe('ingest', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;
  let db: SqlExecutor;

  before(() => {
    db = h.db;
  });

  it('records an event and reports it as fresh', async () => {
    const event = anEvent();
    const result = await record(db, event, NOW);

    assert.equal(result.deduplicated, false);
    assert.ok(result.eventId);
    assert.equal(result.occurredAt.toISOString(), event.occurredAt.toISOString());
    assert.ok(result.receivedAt instanceof Date, 'received_at comes from the database clock');
  });

  it('treats a replay as success, not as a conflict', async () => {
    const event = anEvent();
    const first = await record(db, event, NOW);
    const second = await record(db, event, NOW);

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.eventId, first.eventId, 'the replay resolves to the original event');
  });

  it('deduplicates on the caller key even when the payload differs', async () => {
    // The external id is the contract. A retry that rebuilt its body slightly
    // differently is still the same event, and billing it twice is the failure.
    const event = anEvent();
    await record(db, event, NOW);
    const second = await record(db, { ...event, quantity: Quantity.fromBigInt(999n) }, NOW);

    assert.equal(second.deduplicated, true);

    const stored = await queryUsage(db, {
      tenantId: event.tenantId,
      subjectId: event.subjectId,
      window: { start: new Date('2026-08-13T00:00:00Z'), end: new Date('2026-08-14T00:00:00Z') },
    });
    const mine = stored.filter((s) => s.externalId === event.externalId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.quantity.toDecimalString(), '100.000000000000');
  });

  it('scopes the dedupe key by tenant and source', async () => {
    // Two tenants using the same request id is normal. Colliding them would
    // silently drop one tenant's usage.
    const shared = { externalId: 'shared-id', metric: 'tokens.input' };
    const a = await record(db, anEvent({ ...shared, tenantId: 'tenant-a' }), NOW);
    const b = await record(db, anEvent({ ...shared, tenantId: 'tenant-b' }), NOW);
    const c = await record(db, anEvent({ ...shared, tenantId: 'tenant-a', source: 'batch' }), NOW);

    assert.equal(a.deduplicated, false);
    assert.equal(b.deduplicated, false, 'a different tenant is a different event');
    assert.equal(c.deduplicated, false, 'a different source is a different event');
  });

  it('stores the exact quantity, not a float of it', async () => {
    const event = anEvent({ quantity: Quantity.fromDecimalString('0.000000000001') });
    await record(db, event, NOW);

    const rows = await queryUsage(db, {
      tenantId: event.tenantId,
      subjectId: event.subjectId,
      window: { start: new Date('2026-08-13T00:00:00Z'), end: new Date('2026-08-14T00:00:00Z') },
    });
    const mine = rows.find((r) => r.externalId === event.externalId);
    assert.equal(mine?.quantity.toDecimalString(), '0.000000000001');
  });

  it('keeps both clocks, because the gap between them is lateness', async () => {
    const event = anEvent({ occurredAt: new Date('2026-08-13T09:15:30.123Z') });
    const result = await record(db, event, NOW);
    assert.equal(result.occurredAt.toISOString(), '2026-08-13T09:15:30.123Z');
    assert.notEqual(result.receivedAt.getTime(), result.occurredAt.getTime());
  });

  it('routes rows to the partition for their occurred_at', async () => {
    const event = anEvent({ occurredAt: new Date('2026-07-04T00:00:00Z') });
    await record(db, event, NOW);

    const rows = await db.query<{ partition: string }>(
      `SELECT tableoid::regclass::text AS partition
         FROM billing.usage_events WHERE external_id = $1`,
      [event.externalId],
    );
    // `_2026m07`, not `_202607`. The `m` separator is what sql/011_partitions.sql
    // has always produced for `charges`; the core tables used the bare form, so
    // the schema had two conventions and billing.metering_health() measures
    // partition runway by parsing these names. One convention, and this is the
    // one that was already load-bearing.
    assert.equal(rows[0]?.partition, 'billing.usage_events_2026m07');
  });

  it('refuses an UPDATE at the database, not only in the API', async () => {
    const event = anEvent();
    await record(db, event, NOW);
    await assert.rejects(
      () => db.query('UPDATE billing.usage_events SET metric = $1 WHERE external_id = $2', ['x', event.externalId]),
      /append-only/,
    );
  });

  it('resolves a concurrent replay to one event, not two and not an error', async () => {
    // The race the claim is designed for: a client retries before the first
    // attempt has committed. `ON CONFLICT DO NOTHING` returns no row here and a
    // follow-up SELECT cannot see the uncommitted insert either, leaving no
    // correct branch. `DO UPDATE` waits for the other transaction and then
    // answers truthfully.
    const event = anEvent();
    const [a, b] = await Promise.all([record(db, event, NOW), record(db, event, NOW)]);

    assert.deepEqual([a.deduplicated, b.deduplicated].sort(), [false, true]);
    assert.equal(a.eventId, b.eventId, 'both callers learn the same event id');

    const stored = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM billing.usage_events WHERE external_id = $1',
      [event.externalId],
    );
    assert.equal(stored[0]?.count, '1');
  });

  it('leaves no claimed key behind when the event insert fails', async () => {
    // The claim and the insert are one transaction. If they were not, a crash
    // between them would claim a key with no event behind it, and no number of
    // retries could ever record that event again.
    //
    // This used to date the event to 2001 and rely on "no partition of relation"
    // to make the insert fail. That hole is now closed — usage_events has a
    // DEFAULT partition, so an out-of-range date lands rather than throwing, and
    // the test stopped failing for the reason it was written.
    //
    // Failing the insert directly is what it always meant anyway. The property
    // is that the claim rolls back when the insert fails, whatever the reason;
    // borrowing a specific database error made the test hostage to that error
    // continuing to exist, and it did not.
    const event = anEvent();

    const failingInsert = (inner: SqlExecutor): SqlExecutor => ({
      query: (text, params) => {
        if (text.includes('INSERT INTO billing.usage_events')) {
          return Promise.reject(new Error('deliberate: the event insert failed'));
        }
        return inner.query(text, params);
      },
      transaction: (fn) => inner.transaction((tx) => fn(failingInsert(tx))),
    });

    await assert.rejects(() => record(failingInsert(db), event, NOW), /deliberate/);

    const keys = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM billing.usage_event_keys WHERE external_id = $1',
      [event.externalId],
    );
    assert.equal(keys[0]?.count, '0', 'the claim rolled back with the failed insert');
  });

  it('routes an event too old for any month partition into the default', async () => {
    // The counterpart to what the test above used to rely on. A backdated event
    // is not an error: a reconciliation job replaying a quarter is ordinary, and
    // rejecting it loses usage that really happened. It lands in the DEFAULT
    // partition, which is a safety net rather than a destination — see A5.
    const event = anEvent({ occurredAt: new Date('2001-01-01T00:00:00Z') });

    const result = await record(db, event, NOW);
    assert.equal(result.deduplicated, false);

    const where = await db.query<{ relname: string }>(
      `SELECT c.relname FROM billing.usage_events e
         JOIN pg_class c ON c.oid = e.tableoid
        WHERE e.external_id = $1`,
      [event.externalId],
    );
    assert.match(where[0]!.relname, /_default$/, 'a backdated event belongs in the default partition');
  });
});

describe('recordMany', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;

  it('records a batch and reports each position', async () => {
    const events = [anEvent(), anEvent(), anEvent()];
    const results = await recordMany(h.db, events, NOW);

    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.deduplicated), [false, false, false]);
    assert.equal(new Set(results.map((r) => r.eventId)).size, 3);
  });

  it('collapses a duplicate inside one batch instead of failing the batch', async () => {
    // Postgres rejects a statement whose ON CONFLICT DO UPDATE would touch the
    // same row twice. Without the in-batch collapse, one caller's retry loop
    // rejects every good event alongside it.
    const dup = anEvent();
    const results = await recordMany(h.db, [dup, anEvent(), dup], NOW);

    assert.deepEqual(results.map((r) => r.deduplicated), [false, false, true]);
    assert.equal(results[0]!.eventId, results[2]!.eventId);

    const stored = await h.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM billing.usage_events WHERE external_id = $1',
      [dup.externalId],
    );
    assert.equal(stored[0]?.count, '1');
  });

  it('reports positions already recorded by an earlier call', async () => {
    const old = anEvent();
    await record(h.db, old, NOW);

    const fresh = anEvent();
    const results = await recordMany(h.db, [old, fresh], NOW);
    assert.deepEqual(results.map((r) => r.deduplicated), [true, false]);
  });

  it('preserves order between input and output', async () => {
    const events = [anEvent(), anEvent(), anEvent(), anEvent()];
    const results = await recordMany(h.db, events, NOW);

    const stored = await h.db.query<{ external_id: string; id: string }>(
      'SELECT external_id, id::text AS id FROM billing.usage_events WHERE external_id = ANY($1)',
      [events.map((e) => e.externalId)],
    );
    const idByExternal = new Map(stored.map((s) => [s.external_id, s.id]));
    for (let i = 0; i < events.length; i++) {
      assert.equal(results[i]!.eventId, idByExternal.get(events[i]!.externalId));
    }
  });

  it('is a no-op on an empty batch', async () => {
    assert.deepEqual(await recordMany(h.db, [], NOW), []);
  });

  it('validates the whole batch before writing any of it', async () => {
    const good = anEvent();
    await assert.rejects(
      () => recordMany(h.db, [good, anEvent({ metric: '' })], NOW),
      (e: unknown) => BillingError.hasCode(e, 'invalid_event'),
    );
    const stored = await h.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM billing.usage_events WHERE external_id = $1',
      [good.externalId],
    );
    assert.equal(stored[0]?.count, '0', 'a bad event later in the batch must not half-write it');
  });
});

describe('queryUsage', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;

  it('uses a half-open window so boundaries cannot double-count', async () => {
    const subjectId = 'boundary-subject';
    const at = new Date('2026-08-13T11:00:00Z');
    await record(h.db, anEvent({ subjectId, occurredAt: at }), NOW);

    const before = await queryUsage(h.db, {
      tenantId: 'tenant-1',
      subjectId,
      window: { start: new Date('2026-08-13T10:00:00Z'), end: at },
    });
    const after = await queryUsage(h.db, {
      tenantId: 'tenant-1',
      subjectId,
      window: { start: at, end: new Date('2026-08-13T12:00:00Z') },
    });

    assert.equal(before.length, 0, 'end is exclusive');
    assert.equal(after.length, 1, 'start is inclusive');
  });

  it('refuses a window that ends before it starts', async () => {
    await assert.rejects(
      () =>
        queryUsage(h.db, {
          tenantId: 'tenant-1',
          subjectId: 'subject-1',
          window: { start: new Date('2026-08-13T12:00:00Z'), end: new Date('2026-08-13T10:00:00Z') },
        }),
      (e: unknown) => BillingError.hasCode(e, 'window_invalid'),
    );
  });
});
