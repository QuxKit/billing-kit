// The bound instance.
//
// Two of these need a real database and two do not, and the split is not
// arbitrary: binding the clock is a property of the wrapper and can be shown
// with a fake executor, while `transaction` is a claim about what Postgres does
// on ROLLBACK and cannot be.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { queryUsage } from '../src/events';
import { createBilling } from '../src/instance';
import { Quantity } from '../src/money';
import type { SqlExecutor, UsageEvent } from '../src/types';
import { type Harness, SKIP_REASON, setupDatabase } from './pg-executor';

let n = 0;
function anEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  n += 1;
  return {
    tenantId: 'tenant-instance',
    subjectId: 'subject-1',
    source: 'api',
    externalId: `inst-${n}`,
    metric: 'tokens.input',
    quantity: Quantity.fromBigInt(100n),
    occurredAt: new Date('2026-08-13T12:00:00Z'),
    ...overrides,
  };
}

describe('createBilling — without a database', () => {
  /**
   * Records the `now` each call was given.
   *
   * A fake executor is the right tool for exactly this question: the assertion
   * is about what the wrapper passed, not about what the database did with it.
   */
  function spyExecutor(): { db: SqlExecutor; nows: Date[] } {
    const nows: Date[] = [];
    const db: SqlExecutor = {
      query: async () => [],
      transaction: async (fn) => fn(db),
    };
    return { db, nows };
  }

  it('reads the clock per call, not once at construction', async () => {
    // The failure this catches: capturing `clock()` when the instance is built.
    // A worker constructed at boot would then stamp every event for the rest of
    // its life with the moment the process started, and nothing downstream
    // would look wrong — the events would simply all share a timestamp.
    const ticks = [
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-12-01T00:00:00Z'),
    ];
    let i = 0;
    const seen: Date[] = [];

    const db: SqlExecutor = {
      query: async () => [],
      transaction: async (fn) => fn(db),
    };

    const billing = createBilling({
      db,
      clock: () => {
        const t = ticks[Math.min(i, ticks.length - 1)]!;
        i += 1;
        seen.push(t);
        return t;
      },
    });

    // `validateEvent` rejects events far from `now`, which is what makes this
    // observable: each call is validated against a different clock reading, so
    // an event dated for tick 2 only survives if tick 2 is what was read.
    await assert.rejects(() => billing.record(anEvent({ occurredAt: ticks[2] })));
    assert.equal(seen.length, 1, 'first call should read the clock once');

    await assert.rejects(() => billing.record(anEvent({ occurredAt: ticks[0] })));
    assert.equal(seen.length, 2, 'second call should read the clock again');
    assert.notEqual(seen[0]!.getTime(), seen[1]!.getTime(), 'a captured clock would repeat');
  });

  it('exposes the executor and clock it was built with', () => {
    // So the free functions remain reachable from an instance — the wrapper is
    // sugar, and code that needs the argument should not have to keep a second
    // reference to the pool.
    const { db } = spyExecutor();
    const clock = () => new Date('2026-03-03T03:03:03Z');
    const billing = createBilling({ db, clock });

    assert.equal(billing.db, db);
    assert.equal(billing.clock().toISOString(), '2026-03-03T03:03:03.000Z');
  });
});

// Top level, as in the other suites: the pool is shared, and `skip` has to be
// evaluated against a harness that already exists. Passing SKIP_REASON
// unconditionally reads as a guard and is simply always truthy — the suite then
// skips even when the database is up, which is how this file first "passed".
const harness = await setupDatabase();

after(async () => {
  await harness?.close();
});

describe('createBilling — against Postgres', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;

  it('records through the instance without threading db or now', async () => {
    const billing = createBilling({ db: h.db });

    const event = anEvent();
    const result = await billing.record(event);

    assert.equal(result.deduplicated, false);
    const stored = await billing.queryUsage({
      tenantId: event.tenantId,
      subjectId: event.subjectId,
      window: { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') },
    });
    assert.ok(stored.some((s) => s.externalId === event.externalId));
  });

  it('rolls back everything in a transaction that throws', async () => {
    const billing = createBilling({ db: h.db });

    const first = anEvent();
    const second = anEvent();

    // The reason `transaction` exists: two writes that must not be able to
    // disagree. If the callback fails after the first, the first must not
    // survive — otherwise a ledger can describe usage that was never recorded.
    await assert.rejects(
      billing.transaction(async (tx) => {
        await tx.record(first);
        await tx.record(second);
        throw new Error('deliberate');
      }),
      /deliberate/,
    );

    const stored = await queryUsage(h.db, {
      tenantId: first.tenantId,
      subjectId: first.subjectId,
      window: { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') },
    });
    const ids = new Set(stored.map((s) => s.externalId));
    assert.equal(ids.has(first.externalId), false, 'first write survived a rollback');
    assert.equal(ids.has(second.externalId), false, 'second write survived a rollback');
  });

  it('commits both writes when the transaction returns', async () => {
    const billing = createBilling({ db: h.db });

    const first = anEvent();
    const second = anEvent();

    await billing.transaction(async (tx) => {
      await tx.record(first);
      await tx.record(second);
    });

    const stored = await billing.queryUsage({
      tenantId: first.tenantId,
      subjectId: first.subjectId,
      window: { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') },
    });
    const ids = new Set(stored.map((s) => s.externalId));
    assert.ok(ids.has(first.externalId));
    assert.ok(ids.has(second.externalId));
  });
});
