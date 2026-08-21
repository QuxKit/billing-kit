// billing-kit/entitlements — "may this subject do X right now?"
//
// The answer is derived, never stored: the active subscription names a plan,
// the plan names the feature, this period's usage says how much of an allowance
// is spent, and the wallet says whether overage past it is covered. Storing an
// entitlements table would be a second copy of all four that has to be kept in
// step, and the first time a sweep advances a period without touching it the
// copy is wrong. So there is no table; `check` is a read over the ones that
// already exist. It costs one subscription lookup and, for a metered feature,
// one aggregate (plus one balance for wallet overage) — the same reads a host
// would do by hand, in one place with the rules written down.
//
// A separate entry point so an application that only ingests usage does not
// compile the subscription types.

import { BillingError } from '../errors.ts';
import { aggregateUsage } from '../events.ts';
import { walletBalance } from '../ledger.ts';
import type { Money, Quantity } from '../money.ts';
import { Quantity as Q } from '../money.ts';
import { addInterval } from '../subscriptions/plan.ts';
import { SUBSCRIPTION_COLUMNS, type SubscriptionRow, toSubscription } from '../subscriptions/store.ts';
import type { Plan, PlanFeature, Subscription } from '../subscriptions/types.ts';
import type { Clock, SqlExecutor, SubjectId, TenantId } from '../types.ts';

/** How a plan id becomes a plan. The catalogue is the application's. */
export type PlanResolver = (planId: string) => Plan | undefined | Promise<Plan | undefined>;

export interface EntitlementQuery {
  tenantId: TenantId;
  subjectId: SubjectId;
  feature: string;
  plan: PlanResolver;
  /** The instant to answer for. Defaults to now. */
  at?: Date;
}

export type EntitlementDenial =
  /** No subscription active for the subject at `at`. */
  | 'no_subscription'
  /** The plan resolver returned undefined for the subscription's plan. */
  | 'unknown_plan'
  /** The plan has no such feature. */
  | 'not_in_plan'
  /** Metered, over the limit, and overage is `deny`. */
  | 'limit_reached'
  /** Metered, over the limit, overage is `wallet`, and the wallet is empty. */
  | 'wallet_empty';

export interface Entitlement {
  feature: string;
  allowed: boolean;
  kind: 'boolean' | 'metered';
  /** Why not, when not. Absent when allowed. */
  reason?: EntitlementDenial;
  /** Metered only. */
  limit?: Quantity;
  used?: Quantity;
  /** `limit - used`, floored at zero. */
  remaining?: Quantity;
  /** True when allowed past the limit (postpaid or wallet overage). */
  overage?: boolean;
  /** The wallet balance consulted, when overage is `wallet`. */
  wallet?: Money;
  subscriptionId?: string;
  planId?: string;
  /** The period the usage was measured over. */
  period?: { start: Date; end: Date };
}

const SELECT = `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions`;

/**
 * The subscription active for a subject at an instant: started, not canceled
 * before it. When a subject holds more than one, this returns the newest —
 * kept for compatibility; entitlement checks use activeSubscriptions and
 * consult all of them.
 */
export async function activeSubscription(
  db: SqlExecutor,
  q: { tenantId: TenantId; subjectId: SubjectId; at: Date },
): Promise<Subscription | null> {
  const subs = await activeSubscriptions(db, q);
  return subs[0] ?? null;
}

/**
 * Every subscription active for the subject at `at`, newest first.
 *
 * A subject holding several — one per product, which UNIQUE (tenant_id, key)
 * has always permitted — is a supported state, not an anomaly: check() and
 * list() consult ALL of them. The old behaviour, where the newest
 * subscription eclipsed every entitlement of the ones before it, meant that
 * buying a second product silently revoked the first.
 */
export async function activeSubscriptions(
  db: SqlExecutor,
  q: { tenantId: TenantId; subjectId: SubjectId; at: Date },
): Promise<Subscription[]> {
  const rows = await db.query<SubscriptionRow>(
    `${SELECT}
      WHERE tenant_id = $1 AND subject_id = $2
        AND started_at <= $3
        AND (state <> 'canceled' OR canceled_at IS NULL OR canceled_at > $3)
      ORDER BY started_at DESC`,
    [q.tenantId, q.subjectId, q.at],
  );
  return rows.map(toSubscription);
}

/**
 * Of two verdicts for the same feature, the one the subject would rather
 * keep: any allowed beats any denial; among allowed, the larger remaining
 * allowance (boolean grants are unbounded and beat metered); among denials,
 * the larger limit — the row closest to having worked.
 */
function morePermissive(a: Entitlement, b: Entitlement): Entitlement {
  if (a.allowed !== b.allowed) return a.allowed ? a : b;
  const span = (e: Entitlement): bigint => {
    if (e.kind === 'boolean') return BigInt('9'.repeat(30));
    if (e.allowed) return e.remaining?.units ?? 0n;
    return e.limit?.units ?? 0n;
  };
  return span(b) > span(a) ? b : a;
}

/**
 * The period of `sub` that contains `at`.
 *
 * Usually the current one. When the sweep is late — `at` is past
 * `currentPeriodEnd` and the row has not advanced — the allowance must still
 * be measured over the period `at` is actually in, so the window is stepped
 * forward by the plan's interval until it contains `at`. Never stepped back:
 * a check for an instant before the current period answers for the current
 * period, which is the one that is still open.
 */
export function periodContaining(sub: Subscription, plan: Plan, at: Date): { start: Date; end: Date } {
  let start = sub.currentPeriodStart;
  let end = sub.currentPeriodEnd;
  // Bounded: a subscription a thousand periods behind is a bug elsewhere.
  for (let i = 0; i < 1000 && end <= at; i += 1) {
    start = end;
    end = addInterval(end, plan.interval);
  }
  return { start, end };
}

const denied = (feature: string, reason: EntitlementDenial, extra: Partial<Entitlement> = {}): Entitlement => ({
  feature,
  allowed: false,
  kind: 'boolean',
  reason,
  ...extra,
});

async function checkFeature(
  db: SqlExecutor,
  q: { tenantId: TenantId; subjectId: SubjectId; at: Date },
  sub: Subscription,
  plan: Plan,
  feature: string,
  def: PlanFeature,
): Promise<Entitlement> {
  const ids = { subscriptionId: sub.id, planId: plan.id };
  if (def === true) return { feature, allowed: true, kind: 'boolean', ...ids };

  const period = periodContaining(sub, plan, q.at);
  const agg = await aggregateUsage(db, {
    tenantId: q.tenantId,
    subjectId: q.subjectId,
    metric: def.meter,
    window: period,
    method: def.method ?? 'sum',
  });
  const used = agg.quantity;
  const left = def.limit.minus(used);
  const remaining = left.isNegative() ? Q.zero() : left;
  const base: Entitlement = {
    feature,
    allowed: true,
    kind: 'metered',
    limit: def.limit,
    used,
    remaining,
    period,
    ...ids,
  };

  if (used.units < def.limit.units) return base;

  const priced = plan.usage.some((u) => u.metric === def.meter);
  const overage = def.overage ?? (priced ? 'postpaid' : 'deny');
  if (overage === 'postpaid') return { ...base, overage: true };
  if (overage === 'deny') return { ...base, allowed: false, reason: 'limit_reached' };

  const wallet = await walletBalance(db, {
    tenantId: q.tenantId,
    subjectId: q.subjectId,
    currency: plan.currency,
    asOf: q.at,
  });
  return wallet.isPositive()
    ? { ...base, overage: true, wallet }
    : { ...base, allowed: false, reason: 'wallet_empty', wallet };
}

/**
 * May `subjectId` use `feature` at `at`? Consults EVERY active subscription:
 * a subject with billing-kit Cloud and mail-kit Pro holds the union of both
 * plans' features, and where both define the same key the more permissive
 * verdict wins. An unknown plan on any subscription denies loudly rather
 * than being skipped — a resolver that forgot a plan is a bug, not a gap.
 */
export async function check(db: SqlExecutor, q: EntitlementQuery): Promise<Entitlement> {
  const at = q.at ?? new Date();
  const subs = await activeSubscriptions(db, { tenantId: q.tenantId, subjectId: q.subjectId, at });
  if (subs.length === 0) return denied(q.feature, 'no_subscription');

  const candidates: Array<{ sub: Subscription; plan: Plan; def: PlanFeature }> = [];
  for (const sub of subs) {
    const plan = await q.plan(sub.planId);
    if (plan === undefined) {
      return denied(q.feature, 'unknown_plan', { subscriptionId: sub.id, planId: sub.planId });
    }
    const def = plan.features?.[q.feature];
    if (def !== undefined) candidates.push({ sub, plan, def });
  }
  const first = subs[0] as Subscription;
  if (candidates.length === 0) {
    return denied(q.feature, 'not_in_plan', { subscriptionId: first.id, planId: first.planId });
  }

  // A boolean grant is unbounded; no metered verdict can beat it.
  const granted = candidates.find((c) => c.def === true);
  if (granted) {
    return {
      feature: q.feature,
      allowed: true,
      kind: 'boolean',
      subscriptionId: granted.sub.id,
      planId: granted.plan.id,
    };
  }

  let best: Entitlement | null = null;
  for (const c of candidates) {
    const verdict = await checkFeature(
      db,
      { tenantId: q.tenantId, subjectId: q.subjectId, at },
      c.sub,
      c.plan,
      q.feature,
      c.def,
    );
    best = best === null ? verdict : morePermissive(best, verdict);
  }
  return best as Entitlement;
}

export interface EntitlementListQuery {
  tenantId: TenantId;
  subjectId: SubjectId;
  plan: PlanResolver;
  at?: Date;
}

/**
 * Every feature of the subject's plan, checked. An empty array when there is
 * no active subscription; `unknown_plan` throws, because a list that silently
 * says "nothing" for a plan the resolver forgot is a list that lies.
 */
export async function list(db: SqlExecutor, q: EntitlementListQuery): Promise<Entitlement[]> {
  const at = q.at ?? new Date();
  const subs = await activeSubscriptions(db, { tenantId: q.tenantId, subjectId: q.subjectId, at });
  if (subs.length === 0) return [];
  // The union across every active subscription, in first-seen order. Where
  // two plans define the same key, the more permissive verdict is kept —
  // same rule as check(), so the list never disagrees with the checks.
  const byFeature = new Map<string, Entitlement>();
  for (const sub of subs) {
    const plan = await q.plan(sub.planId);
    if (plan === undefined) {
      throw new BillingError({ code: 'not_found', what: 'plan', id: sub.planId });
    }
    for (const [feature, def] of Object.entries(plan.features ?? {})) {
      const verdict = await checkFeature(
        db,
        { tenantId: q.tenantId, subjectId: q.subjectId, at },
        sub,
        plan,
        feature,
        def,
      );
      const prior = byFeature.get(feature);
      byFeature.set(feature, prior === undefined ? verdict : morePermissive(prior, verdict));
    }
  }
  return [...byFeature.values()];
}

export interface EntitlementsOptions {
  db: SqlExecutor;
  plan: PlanResolver;
  clock?: Clock;
}

export interface Entitlements {
  check(q: Omit<EntitlementQuery, 'plan'>): Promise<Entitlement>;
  list(q: Omit<EntitlementListQuery, 'plan'>): Promise<Entitlement[]>;
}

/** The surface bound to one executor, one plan catalogue and one clock. */
export function createEntitlements(opts: EntitlementsOptions): Entitlements {
  const clock: Clock = opts.clock ?? (() => new Date());
  return {
    check: (q) => check(opts.db, { ...q, plan: opts.plan, at: q.at ?? clock() }),
    list: (q) => list(opts.db, { ...q, plan: opts.plan, at: q.at ?? clock() }),
  };
}

export const entitlements = { check, list };
export type { Plan, PlanFeature } from '../subscriptions/types.ts';
