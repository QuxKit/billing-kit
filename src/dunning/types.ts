// The dunning seam: a case, a policy, and the actions a policy asks for.
//
// Everything here is a type. There is no mailer, no template, no scheduler and
// no HTTP, for the same reason `chargeDueSubscriptions` has none of those: the
// trigger and the channel belong to the host. A library that sends the email
// has decided what your email looks like, which SMTP credentials it uses and
// what happens when the send fails, and it has decided all three for every
// adopter at once.
//
// What billing-kit owns is the part that is genuinely billing: a durable case
// keyed to a failed settlement, a clock over it, and a decision about what is
// due now. The decision is *returned*, never performed.
//
// The hazard that shapes the whole design, stated once here because it is the
// one that produces a customer-visible bug rather than a compile error:
// **Stripe and Paddle already dun.** They retry the card on their own schedule
// and they send their own emails. A second retry loop on top charges twice and
// mails twice, and it reads as our fault. `ProviderCapabilities.retriesPayments`
// is what a policy consults, and `forProvider()` is what applies it.

import type { Money } from '../money.ts';
import type { SubjectId, TenantId } from '../types.ts';

/**
 * Where a case is.
 *
 *   open ──payment succeeds──▶ recovered
 *     │
 *     ├──policy exhausted────▶ written_off
 *     └──invoice voided──────▶ cancelled
 *
 * `recovered`, `written_off` and `cancelled` are terminal. A terminal case is
 * never acted on again, which is what makes re-running a sweep over an old case
 * a no-op rather than a second dunning cycle.
 */
export type DunningState = 'open' | 'recovered' | 'written_off' | 'cancelled';

/**
 * What a step asks the host to do. Names, not implementations — `notify` does
 * not say which channel, and `retry_payment` does not say which provider call.
 *
 * `suspend_entitlements` and `write_off` are the two that already have homes:
 * entitlements are answered from the subscription state, and `write_off` is
 * `markUncollectible` on the invoice.
 */
export type DunningActionKind =
  /** Tell the customer. Channel, template and copy are the host's. */
  | 'notify'
  /** Ask the provider to charge again. Never fired under a provider that duns. */
  | 'retry_payment'
  /** Move the subscription to `past_due`. Visible, reversible, not yet a cut-off. */
  | 'flag_past_due'
  /** Stop serving. The point at which the customer feels it. */
  | 'suspend_entitlements'
  /** Give up on the money: `markUncollectible` on the invoice. */
  | 'write_off';

/** One action, with the context the host needs to carry it out. */
export interface DunningAction {
  kind: DunningActionKind;
  /**
   * Which step produced it, 1-based. A notify carries it so the host can pick
   * the third email rather than the first, without the host having to
   * re-derive the schedule it already gave us.
   */
  step: number;
  /** The case it belongs to, so a batch of decisions stays attributable. */
  settlementRef: string;
}

export interface DunningStep {
  /**
   * How long after the previous event — the original failure for step 1, the
   * step before it thereafter — this step comes due.
   *
   * Fractional hours are fine; the schedule is computed in milliseconds.
   */
  afterHours: number;
  /** What to do when it does. Ordered; the host performs them in order. */
  actions: readonly DunningActionKind[];
}

export interface DunningPolicy {
  /**
   * The ladder. Empty is legal and means "do not chase" — the case opens, waits
   * out `onExhausted.afterHours`, and closes. That is the right policy for a
   * host that wants the record and nothing else.
   */
  steps: readonly DunningStep[];
  /**
   * What happens once the last step has passed without recovery, and how long
   * after it. A step like any other, rather than a bare list of actions,
   * because the gap between the final notice and the cut-off is a real product
   * decision and a policy that could not express it would have that gap be
   * zero — suspending the customer in the same sweep that emailed them.
   */
  onExhausted: DunningStep;
  /**
   * `observe` tracks the case and returns no actions, ever.
   *
   * Not a debugging switch. It is the correct mode under a provider that runs
   * its own recovery, and `forProvider()` sets it from the capability rather
   * than trusting an operator to remember.
   */
  mode?: 'active' | 'observe';
}

/**
 * A failed settlement being worked.
 *
 * Keyed by `(tenantId, settlementRef)`, which is what makes opening one
 * idempotent: the same `payment.failed` webhook delivered three times opens one
 * case, and a provider that retries the card itself and fails again reuses it
 * rather than starting a second ladder for the same debt.
 */
export interface DunningCase {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  /** The provider's settlement this is about. Half the natural key. */
  settlementRef: string;
  /** The invoice, when one was issued. Null under a provider that issues its own. */
  invoiceId: string | null;
  provider: string;
  state: DunningState;
  amount: Money;
  /**
   * How many steps have fired. Zero on a case whose first step has not run,
   * which is the state a case is in the moment it opens.
   */
  attempts: number;
  /** The provider's words for the last failure, kept for the operator. */
  lastReason: string;
  openedAt: Date;
  /**
   * When to look at this case next. Null on a terminal case, and null under
   * `observe` — there is nothing to wake up for.
   */
  nextActionAt: Date | null;
  closedAt: Date | null;
}

export interface DunningDecision {
  /** What to do now, in order. Empty when nothing is due yet. */
  actions: readonly DunningAction[];
  /** Where the case moves. Equal to the current state when nothing happened. */
  state: DunningState;
  /**
   * The step count after this decision. The store writes it back; passing it
   * out rather than leaving the caller to increment is what keeps "which step
   * fires next" from being decided in two places that can disagree.
   */
  attempts: number;
  /** When to look again. Null when the case is finished. */
  nextActionAt: Date | null;
  /**
   * Why, in words. Written to the case and read by whoever is asking why a
   * customer was suspended on a Tuesday. A decision engine whose reasoning is
   * only reconstructable from the code is one nobody trusts in an incident.
   */
  reason: string;
}
