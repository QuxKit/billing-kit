// What is due on a case right now.
//
// Pure, and deliberately the only place the schedule is interpreted. A sweep
// that read `attempts` in one place to pick an email and in another to pick the
// next wake-up would eventually disagree with itself, and the symptom is a
// customer who gets the final notice twice and the cut-off never.
//
// Nothing here performs anything. `decide` returns a list of names; sending the
// mail, calling the provider and suspending the account are the host's, and the
// host is where the credentials, the templates and the retry semantics for each
// of those already live.

import type {
  DunningAction,
  DunningActionKind,
  DunningCase,
  DunningDecision,
  DunningPolicy,
  DunningStep,
} from './types.ts';

const HOUR_MS = 3_600_000;

const after = (from: Date, hours: number): Date => new Date(from.getTime() + Math.round(hours * HOUR_MS));

const isObserving = (policy: DunningPolicy): boolean => policy.mode === 'observe';

/**
 * When a freshly opened case should first be looked at.
 *
 * Null under `observe`: there is nothing to wake up for, and a case with a
 * `nextActionAt` under a provider-led policy is a sweep that will find work it
 * must then decline to do, every tick, forever.
 */
export function firstActionAt(policy: DunningPolicy, openedAt: Date): Date | null {
  if (isObserving(policy)) return null;
  const first: DunningStep = policy.steps[0] ?? policy.onExhausted;
  return after(openedAt, first.afterHours);
}

/**
 * Force `observe` when the provider runs its own recovery.
 *
 * The single most expensive bug this module could ship is a second retry loop
 * layered on Stripe's or Paddle's: the card is charged twice, the customer is
 * emailed twice, and the support ticket says we did it. So the mode is derived
 * from the capability rather than configured — an operator who has to remember
 * to set it will eventually not, and the provider that duns is the default
 * case, not the exotic one.
 *
 * One-way. A policy that already says `observe` is never promoted to active,
 * because the operator who wrote it may have had a reason we cannot see.
 */
export function forProvider(policy: DunningPolicy, capabilities: { retriesPayments: boolean }): DunningPolicy {
  if (!capabilities.retriesPayments) return policy;
  if (isObserving(policy)) return policy;
  return { ...policy, mode: 'observe' };
}

const actionsOf = (step: DunningStep, index: number, c: DunningCase): DunningAction[] =>
  step.actions.map((kind: DunningActionKind) => ({
    kind,
    step: index,
    tenantId: c.tenantId,
    settlementRef: c.settlementRef,
  }));

/**
 * What to do with one case, now.
 *
 * The rules, in the order they are checked:
 *
 *   1. A terminal case is finished. No actions, ever, however many times it is
 *      swept. This is what makes the sweep idempotent rather than merely
 *      survivable.
 *   2. Under `observe` nothing is ever due. The case stays open and unscheduled
 *      so that the record still exists when someone asks why a subscription
 *      went `past_due` — we just did not do it.
 *   3. Not yet due: nothing, and the existing wake-up stands.
 *   4. Due, with a step left: fire it, and schedule the one after — or the
 *      cut-off, if that was the last.
 *   5. Due, out of steps: fire `onExhausted` and close the case.
 *
 * `written_off` is the terminal state for a case that ran out of steps, whether
 * or not `onExhausted` includes the `write_off` action. The state records that
 * we stopped pursuing the money; the action records that the invoice was posted
 * uncollectible. A host that suspends but keeps the receivable on the books
 * omits the action and still gets the closed case.
 */
export function decide(input: { dunningCase: DunningCase; policy: DunningPolicy; now: Date }): DunningDecision {
  const { dunningCase: c, policy, now } = input;

  if (c.state !== 'open') {
    return {
      actions: [],
      state: c.state,
      attempts: c.attempts,
      nextActionAt: null,
      reason: `case is ${c.state}`,
    };
  }

  if (isObserving(policy)) {
    return {
      actions: [],
      state: 'open',
      attempts: c.attempts,
      nextActionAt: null,
      reason: 'provider-led recovery: tracking only',
    };
  }

  // An open, active case with no wake-up has just come out of `observe`, or was
  // opened before a policy change. Due now beats never: the alternative is a
  // case that sits open and untouched with money outstanding.
  if (c.nextActionAt !== null && now.getTime() < c.nextActionAt.getTime()) {
    return {
      actions: [],
      state: 'open',
      attempts: c.attempts,
      nextActionAt: c.nextActionAt,
      reason: `next step due ${c.nextActionAt.toISOString()}`,
    };
  }

  const step = policy.steps[c.attempts];
  if (step === undefined) {
    const index = policy.steps.length + 1;
    return {
      actions: actionsOf(policy.onExhausted, index, c),
      state: 'written_off',
      attempts: c.attempts + 1,
      nextActionAt: null,
      reason: `policy exhausted after ${policy.steps.length} step(s)`,
    };
  }

  const index = c.attempts + 1;
  const next: DunningStep = policy.steps[index] ?? policy.onExhausted;
  return {
    actions: actionsOf(step, index, c),
    state: 'open',
    attempts: index,
    nextActionAt: after(now, next.afterHours),
    reason: `step ${index} of ${policy.steps.length}`,
  };
}
