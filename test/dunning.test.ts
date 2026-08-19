// The dunning policy, which is pure and holds the whole of the schedule.
//
// The first test is the one that matters most. Both shipped providers retry the
// card themselves, so the ordinary case for this module is doing nothing, and
// an `observe` policy that ever emitted an action would double-charge a real
// customer on a real card. Everything else here is a state machine.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DunningCase, DunningPolicy } from '../src/dunning';
import { decide, firstActionAt, forProvider } from '../src/dunning';
import { Money } from '../src/money';

const OPENED = new Date('2026-08-19T00:00:00Z');
const usd = (minor: bigint) => Money.fromMinor(minor, 'USD');

const POLICY: DunningPolicy = {
  steps: [
    { afterHours: 0, actions: ['notify', 'flag_past_due'] },
    { afterHours: 72, actions: ['notify', 'retry_payment'] },
    { afterHours: 120, actions: ['notify'] },
  ],
  onExhausted: { afterHours: 48, actions: ['suspend_entitlements', 'write_off'] },
};

const openCase = (over: Partial<DunningCase> = {}): DunningCase => ({
  id: 'case-1',
  tenantId: 't1',
  subjectId: 's1',
  settlementRef: 'in_123',
  invoiceId: 'inv-1',
  provider: 'stripe',
  state: 'open',
  amount: usd(10_000n),
  attempts: 0,
  lastReason: 'card_declined',
  openedAt: OPENED,
  nextActionAt: OPENED,
  closedAt: null,
  ...over,
});

const hoursAfter = (from: Date, hours: number) => new Date(from.getTime() + hours * 3_600_000);

describe('forProvider', () => {
  it('forces observe when the provider retries the card itself', () => {
    const applied = forProvider(POLICY, { retriesPayments: true });
    assert.equal(applied.mode, 'observe');
  });

  it('leaves a policy alone when the provider does not', () => {
    assert.equal(forProvider(POLICY, { retriesPayments: false }).mode, undefined);
  });

  it('never promotes an explicit observe back to active', () => {
    const observing: DunningPolicy = { ...POLICY, mode: 'observe' };
    assert.equal(forProvider(observing, { retriesPayments: false }).mode, 'observe');
  });
});

describe('decide, under observe', () => {
  const observing: DunningPolicy = { ...POLICY, mode: 'observe' };

  it('emits nothing, however overdue, and schedules no wake-up', () => {
    const decision = decide({
      dunningCase: openCase({ nextActionAt: OPENED }),
      policy: observing,
      now: hoursAfter(OPENED, 1_000),
    });
    assert.deepEqual(decision.actions, []);
    assert.equal(decision.nextActionAt, null);
    assert.equal(decision.state, 'open');
    assert.equal(decision.attempts, 0);
  });

  it('keeps the case open, so the record survives for whoever asks later', () => {
    const decision = decide({ dunningCase: openCase(), policy: observing, now: OPENED });
    assert.equal(decision.state, 'open');
    assert.match(decision.reason, /provider-led/);
  });
});

describe('decide, walking the ladder', () => {
  it('does nothing before the step is due, and keeps the existing wake-up', () => {
    const due = hoursAfter(OPENED, 72);
    const decision = decide({
      dunningCase: openCase({ attempts: 1, nextActionAt: due }),
      policy: POLICY,
      now: hoursAfter(OPENED, 71),
    });
    assert.deepEqual(decision.actions, []);
    assert.deepEqual(decision.nextActionAt, due);
    assert.equal(decision.attempts, 1);
  });

  it('fires the first step and schedules the second', () => {
    const decision = decide({ dunningCase: openCase(), policy: POLICY, now: OPENED });
    assert.deepEqual(
      decision.actions.map((a) => a.kind),
      ['notify', 'flag_past_due'],
    );
    assert.equal(decision.actions[0]?.step, 1);
    assert.equal(decision.actions[0]?.settlementRef, 'in_123');
    assert.equal(decision.attempts, 1);
    assert.deepEqual(decision.nextActionAt, hoursAfter(OPENED, 72));
    assert.equal(decision.state, 'open');
  });

  it('schedules the cut-off gap after the last step, not the cut-off itself', () => {
    const now = hoursAfter(OPENED, 192);
    const decision = decide({
      dunningCase: openCase({ attempts: 2, nextActionAt: now }),
      policy: POLICY,
      now,
    });
    assert.deepEqual(
      decision.actions.map((a) => a.kind),
      ['notify'],
    );
    assert.equal(decision.attempts, 3);
    assert.deepEqual(decision.nextActionAt, hoursAfter(now, 48));
  });

  it('exhausts once the steps run out, and closes the case', () => {
    const now = hoursAfter(OPENED, 240);
    const decision = decide({
      dunningCase: openCase({ attempts: 3, nextActionAt: now }),
      policy: POLICY,
      now,
    });
    assert.deepEqual(
      decision.actions.map((a) => a.kind),
      ['suspend_entitlements', 'write_off'],
    );
    assert.equal(decision.state, 'written_off');
    assert.equal(decision.nextActionAt, null);
  });
});

describe('decide, terminal cases', () => {
  for (const state of ['recovered', 'written_off', 'cancelled'] as const) {
    it(`does nothing to a ${state} case, however many times it is swept`, () => {
      const decision = decide({
        dunningCase: openCase({ state, attempts: 3, closedAt: OPENED }),
        policy: POLICY,
        now: hoursAfter(OPENED, 10_000),
      });
      assert.deepEqual(decision.actions, []);
      assert.equal(decision.state, state);
      assert.equal(decision.nextActionAt, null);
    });
  }
});

describe('decide, degenerate policies', () => {
  it('treats an empty ladder as "record it, wait, close it"', () => {
    const record: DunningPolicy = { steps: [], onExhausted: { afterHours: 24, actions: ['write_off'] } };
    const opened = openCase({ nextActionAt: hoursAfter(OPENED, 24) });

    assert.deepEqual(decide({ dunningCase: opened, policy: record, now: OPENED }).actions, []);

    const decision = decide({ dunningCase: opened, policy: record, now: hoursAfter(OPENED, 24) });
    assert.deepEqual(
      decision.actions.map((a) => a.kind),
      ['write_off'],
    );
    assert.equal(decision.state, 'written_off');
  });

  it('treats an open case with no wake-up as due now rather than never', () => {
    const decision = decide({
      dunningCase: openCase({ nextActionAt: null }),
      policy: POLICY,
      now: hoursAfter(OPENED, 5),
    });
    assert.equal(decision.actions.length, 2);
    assert.equal(decision.attempts, 1);
  });
});

describe('firstActionAt', () => {
  it('is the first step, measured from the failure', () => {
    assert.deepEqual(firstActionAt(POLICY, OPENED), OPENED);
    const delayed: DunningPolicy = { ...POLICY, steps: [{ afterHours: 6, actions: ['notify'] }] };
    assert.deepEqual(firstActionAt(delayed, OPENED), hoursAfter(OPENED, 6));
  });

  it('is null under observe: nothing will act, so nothing should wake', () => {
    assert.equal(firstActionAt({ ...POLICY, mode: 'observe' }, OPENED), null);
  });

  it('falls back to the cut-off when the ladder is empty', () => {
    const record: DunningPolicy = { steps: [], onExhausted: { afterHours: 24, actions: ['write_off'] } };
    assert.deepEqual(firstActionAt(record, OPENED), hoursAfter(OPENED, 24));
  });
});
