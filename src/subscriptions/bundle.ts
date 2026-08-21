// A bundle: several products, one subscription, one invoice.
//
// Phase 1 composes member plans into ONE Plan, which is what lets everything
// downstream — periods, charging, invoicing, entitlements, plan changes —
// work unchanged: a bundle is just a plan whose lines know which product they
// belong to. The constraints that composition imposes are stated loudly
// rather than papered over:
//
//   · every member shares the bundle's currency and interval — a monthly
//     bundle cannot carry an annual member; that is phase 2's subscription
//     items, not a composition trick
//   · at most one member may sell seats, because a subscription holds one
//     seat count; two seat pools need phase 2
//   · metrics and feature keys must be distinct across members — namespace
//     them per product ('mail.sends', 'billing.events'); a collision here is
//     refused, never merged, because summing two products' meters into one
//     line would misprice both
//
// A bundle discount ("20% off for taking three kits") is the existing
// whole-subtotal DiscountRule, passed to chargeForPeriod as ever. Per-line
// discounts ("mail-kit free with Cloud") are phase 2.

import { BillingError } from '../errors.ts';
import { Money } from '../money.ts';
import { definePlan } from './plan.ts';
import type { Plan } from './types.ts';

export interface BundleItem {
  /** The product this member contributes — stamped on its usage lines and
   *  required, since an unlabelled member defeats the point of a bundle. */
  productId: string;
  plan: Plan;
}

export interface BundleDefinition {
  /** The bundle's own plan id ('growth-bundle-monthly'). */
  id: string;
  items: readonly BundleItem[];
  /** Overrides the members' trials. Default: the longest member trial. */
  trialDays?: number;
}

/**
 * Compose member plans into one chargeable, checkable Plan.
 *
 * The result goes through `definePlan`, so everything a hand-written plan is
 * validated for holds for a bundle too.
 */
export function defineBundle(def: BundleDefinition): Plan {
  const bad = (reason: string): never => {
    throw new BillingError({ code: 'invalid_plan', reason });
  };

  if (def.items.length < 2) bad('a bundle needs at least two items — one item is just a plan');
  const seenProducts = new Set<string>();
  for (const item of def.items) {
    if (!item.productId) bad('every bundle item needs a productId');
    if (seenProducts.has(item.productId)) bad(`product ${item.productId} appears twice`);
    seenProducts.add(item.productId);
  }

  const [head, ...rest] = def.items as [BundleItem, ...BundleItem[]];
  const currency = head.plan.currency;
  const interval = head.plan.interval;
  for (const item of rest) {
    if (item.plan.currency !== currency) {
      throw new BillingError({ code: 'currency_mismatch', left: currency, right: item.plan.currency });
    }
    if (item.plan.interval !== interval) {
      bad(
        `mixed intervals: ${head.productId} bills ${interval}, ${item.productId} bills ${item.plan.interval} — ` +
          'a bundle charges as one period; split the subscription instead',
      );
    }
  }

  const seated = def.items.filter((i) => i.plan.seats !== undefined);
  if (seated.length > 1) {
    bad(
      `two seat definitions (${seated.map((i) => i.productId).join(', ')}) — a subscription holds one seat ` +
        'count, so at most one bundle member may sell seats',
    );
  }

  // Metrics: distinct across members, each usage line tagged with its owner.
  const metrics = new Map<string, string>();
  const usage = def.items.flatMap((item) =>
    item.plan.usage.map((component) => {
      const owner = metrics.get(component.metric);
      if (owner !== undefined) {
        bad(
          `metric '${component.metric}' is sold by both ${owner} and ${item.productId} — ` +
            "namespace metrics per product ('mail.sends', 'billing.events')",
        );
      }
      metrics.set(component.metric, item.productId);
      return { ...component, productId: component.productId ?? item.productId };
    }),
  );

  // Features: same rule. The union is what entitlement checks will see.
  const features: Record<string, NonNullable<Plan['features']>[string]> = {};
  const featureOwner = new Map<string, string>();
  for (const item of def.items) {
    for (const [key, value] of Object.entries(item.plan.features ?? {})) {
      const owner = featureOwner.get(key);
      if (owner !== undefined) {
        bad(
          `feature '${key}' is defined by both ${owner} and ${item.productId} — ` +
            "namespace feature keys per product ('mail.sso')",
        );
      }
      featureOwner.set(key, item.productId);
      features[key] = value;
    }
  }

  const flat = Money.sum(
    def.items.map((i) => i.plan.flat),
    currency,
  );
  const memberTrials = def.items.map((i) => i.plan.trialDays ?? 0);
  const trialDays = def.trialDays ?? Math.max(...memberTrials);

  return definePlan({
    id: def.id,
    currency,
    interval,
    flat,
    seats: seated[0]?.plan.seats,
    usage,
    features: Object.keys(features).length > 0 ? features : undefined,
    trialDays: trialDays > 0 ? trialDays : undefined,
  });
}
