// Dunning against Postgres: the case, the sweep, and the two ways this module
// can hurt a real customer.
//
// The properties that matter are not in the policy — that is pure and tested in
// dunning.test.ts. They are in the row and the locks: one case per debt however
// many times the webhook arrives, a paid case that stops being swept, a
// provider-led case that is never acted on, and one step per sweep so a cron
// that was down for a week does not fire the whole ladder into one inbox.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  advanceDunning,
  closeCase,
  type DunningPolicy,
  dueCases,
  getCase,
  listCases,
  openCase,
} from '../src/dunning/index.ts';
import { Money } from '../src/money';
import type { SqlExecutor } from '../src/types';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL, unreachable } from './pg-executor';

const NOW = new Date('2026-08-19T12:00:00Z');
const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const hoursAfter = (from: Date, hours: number) => new Date(from.getTime() + hours * 3_600_000);

const POLICY: DunningPolicy = {
  steps: [
    { afterHours: 0, actions: ['notify', 'flag_past_due'] },
    { afterHours: 72, actions: ['notify', 'retry_payment'] },
  ],
  onExhausted: { afterHours: 48, actions: ['suspend_entitlements', 'write_off'] },
};

const SELF_SERVE = { retriesPayments: false };
const PROVIDER_LED = { retriesPayments: true };

const sweepOpts = (over: Partial<Parameters<typeof advanceDunning>[1]> = {}) => ({
  policy: () => POLICY,
  capabilities: () => SELF_SERVE,
  lease: false as const,
  ...over,
});

async function setup(): Promise<{ db: SqlExecutor; close(): Promise<void> } | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    unreachable(SKIP_REASON, error);
    return null;
  }
  const ddl = (f: string) => readFile(fileURLToPath(new URL(`../sql/${f}`, import.meta.url)), 'utf8');
  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(await ddl('001_core.sql'));
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [NOW]);
  await pool.query(await ddl('020_subscriptions.sql'));
  await pool.query(await ddl('030_provider_events.sql'));
  await pool.query(await ddl('031_invoices.sql'));
  await pool.query(await ddl('033_tax_lines.sql'));
  await pool.query(await ddl('034_dunning.sql'));
  await pool.query(await ddl('034_dunning.sql')); // idempotent
  return { db: fromPool(pool), close: () => pool.end() };
}

const harness = await setup();
after(async () => {
  await harness?.close();
});

let n = 0;
/** A fresh settlement ref per case. The table is unique on it, so tests that
 *  shared one would pass or fail depending on their order. */
const ref = (): string => {
  n += 1;
  return `in_${n}`;
};

describe('dunning cases', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;

  const open = (settlementRef: string, over: Record<string, unknown> = {}, now = NOW) =>
    openCase(
      db,
      {
        tenantId: 'acme',
        subjectId: 'ada',
        settlementRef,
        provider: 'stripe',
        amount: usd('100.00'),
        reason: 'card_declined',
        ...over,
      },
      POLICY,
      now,
    );

  it('opens one case per debt, however many times the webhook arrives', async () => {
    const r = ref();
    const first = await open(r);
    assert.equal(first.opened, true);
    assert.equal(first.case.state, 'open');
    assert.equal(first.case.attempts, 0);
    assert.deepEqual(first.case.nextActionAt, NOW);

    const again = await open(r);
    assert.equal(again.opened, false, 'a redelivered webhook is a no-op that reports itself');
    assert.equal(again.case.id, first.case.id);
  });

  it('refreshes the reason on a repeat without restarting the ladder', async () => {
    const r = ref();
    await open(r);
    await advanceDunning(db, sweepOpts({ now: NOW }));

    const midway = await getCase(db, { tenantId: 'acme', settlementRef: r });
    assert.equal(midway?.attempts, 1);

    // The provider retried a day later and failed again. Same debt.
    await open(r, { reason: 'insufficient_funds' }, hoursAfter(NOW, 24));
    const after = await getCase(db, { tenantId: 'acme', settlementRef: r });
    assert.equal(after?.lastReason, 'insufficient_funds');
    assert.equal(after?.attempts, 1, 'the ladder does not restart');
    assert.deepEqual(after?.nextActionAt, midway?.nextActionAt, 'and the wake-up stands');
  });

  it('closes on recovery and stops being due', async () => {
    const r = ref();
    await open(r);
    const closed = await closeCase(db, { tenantId: 'acme', settlementRef: r }, 'recovered', NOW);
    assert.equal(closed?.state, 'recovered');
    assert.deepEqual(closed?.closedAt, NOW);
    assert.equal(closed?.nextActionAt, null);

    const due = await dueCases(db, { tenantId: 'acme', now: hoursAfter(NOW, 1_000) });
    assert.equal(
      due.some((c) => c.settlementRef === r),
      false,
      'a paid case is never swept again',
    );
  });

  it('answers null when closing a case that never failed', async () => {
    assert.equal(await closeCase(db, { tenantId: 'acme', settlementRef: 'in_never' }, 'recovered', NOW), null);
  });

  it('leaves a closed case closed when the same ref fails again', async () => {
    const r = ref();
    await open(r);
    await closeCase(db, { tenantId: 'acme', settlementRef: r }, 'recovered', NOW);
    const repeat = await open(r, { reason: 'card_declined_again' }, hoursAfter(NOW, 1));
    assert.equal(repeat.opened, false);
    assert.equal(repeat.case.state, 'recovered');
    assert.equal(repeat.case.lastReason, 'card_declined', 'a closed case is not edited');
  });

  it('lists what is outstanding for a subject', async () => {
    const mine = await listCases(db, { tenantId: 'acme', subjectId: 'ada', state: 'open' });
    assert.ok(mine.length > 0);
    assert.ok(mine.every((c) => c.state === 'open' && c.subjectId === 'ada'));
    assert.equal((await listCases(db, { tenantId: 'other-tenant' })).length, 0);
  });
});

describe('advanceDunning', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;

  const open = (settlementRef: string, provider = 'stripe', now = NOW) =>
    openCase(
      db,
      { tenantId: 'sweep', subjectId: 'ada', settlementRef, provider, amount: usd('100.00'), reason: 'declined' },
      POLICY,
      now,
    );

  it('fires one step per sweep, and reschedules from when the step fired', async () => {
    const r = ref();
    await open(r);

    // The cron was down for a fortnight, so every step is overdue at once.
    const late = hoursAfter(NOW, 336);
    const first = await advanceDunning(db, sweepOpts({ now: late, tenantId: 'sweep' }));
    assert.equal(first.swept, 1);
    assert.equal(first.advanced, 1);
    assert.deepEqual(
      first.actions.map((a) => a.kind),
      ['notify', 'flag_past_due'],
    );
    assert.equal(first.actions[0]?.step, 1);
    assert.equal(first.actions[0]?.tenantId, 'sweep');
    assert.equal(first.actions[0]?.settlementRef, r);

    // The rest of the ladder is measured from the step that just fired, not
    // from the original failure. A second sweep in the same instant finds
    // nothing — which is what keeps a fortnight of backlog from arriving in one
    // customer's inbox in one second.
    const immediately = await advanceDunning(db, sweepOpts({ now: late, tenantId: 'sweep' }));
    assert.equal(immediately.swept, 0);
    const scheduled = await getCase(db, { tenantId: 'sweep', settlementRef: r });
    assert.deepEqual(scheduled?.nextActionAt, hoursAfter(late, 72));

    const step2 = hoursAfter(late, 72);
    const second = await advanceDunning(db, sweepOpts({ now: step2, tenantId: 'sweep' }));
    assert.deepEqual(
      second.actions.map((a) => a.kind),
      ['notify', 'retry_payment'],
    );

    const cutOff = hoursAfter(step2, 48);
    const third = await advanceDunning(db, sweepOpts({ now: cutOff, tenantId: 'sweep' }));
    assert.deepEqual(
      third.actions.map((a) => a.kind),
      ['suspend_entitlements', 'write_off'],
    );
    assert.equal(third.items[0]?.state, 'written_off');

    const closed = await getCase(db, { tenantId: 'sweep', settlementRef: r });
    assert.equal(closed?.state, 'written_off');
    assert.deepEqual(closed?.closedAt, cutOff);
    assert.equal(closed?.nextActionAt, null);

    const fourth = await advanceDunning(db, sweepOpts({ now: hoursAfter(cutOff, 1_000), tenantId: 'sweep' }));
    assert.equal(fourth.swept, 0, 'a closed case is finished');
  });

  it('never acts under a provider that duns, and unschedules the case', async () => {
    const r = ref();
    await open(r, 'paddle');
    const report = await advanceDunning(
      db,
      sweepOpts({ now: hoursAfter(NOW, 1), tenantId: 'sweep', capabilities: () => PROVIDER_LED }),
    );
    assert.equal(report.swept, 1);
    assert.deepEqual(report.actions, [], 'the whole point');
    assert.equal(report.items[0]?.state, 'open');

    const tracked = await getCase(db, { tenantId: 'sweep', settlementRef: r });
    assert.equal(tracked?.state, 'open', 'the record survives');
    assert.equal(tracked?.attempts, 0);
    assert.equal(tracked?.nextActionAt, null, 'nothing will act, so nothing wakes');
  });

  it('skips a provider it cannot answer for rather than guessing', async () => {
    const r = ref();
    await open(r, 'mystery');
    const report = await advanceDunning(
      db,
      sweepOpts({
        now: hoursAfter(NOW, 1),
        tenantId: 'sweep',
        capabilities: (p: string) => (p === 'mystery' ? undefined : SELF_SERVE),
      }),
    );
    assert.deepEqual(report.skipped, [r]);
    assert.deepEqual(report.actions, []);
    const untouched = await getCase(db, { tenantId: 'sweep', settlementRef: r });
    assert.equal(untouched?.attempts, 0);
    assert.deepEqual(untouched?.nextActionAt, NOW, 'left for a human, not silently advanced');
  });

  it('reports leased:false rather than sweeping twice at once', async () => {
    await open(ref());
    const outer = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))', ['billing-kit:dunning:sweep']);
      // A second sweep fires while the lease is held on another connection.
      return advanceDunning(db, { ...sweepOpts({ tenantId: 'sweep' }), lease: {}, now: hoursAfter(NOW, 1) });
    });
    assert.equal(outer.leased, false);
    assert.equal(outer.swept, 0);
    assert.deepEqual(outer.actions, []);
  });

  it('one bad case does not halt the sweep', async () => {
    const bad = ref();
    const good = ref();
    await open(bad);
    await open(good);
    const report = await advanceDunning(
      db,
      sweepOpts({
        now: hoursAfter(NOW, 1),
        tenantId: 'sweep',
        retry: { retries: 0 },
        policy: (c) => {
          if (c.settlementRef === bad) throw new Error('the catalogue is down');
          return POLICY;
        },
      }),
    );
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.settlementRef, bad);
    assert.ok(
      report.items.some((i) => i.settlementRef === good),
      'the healthy case still advanced',
    );
  });
});
