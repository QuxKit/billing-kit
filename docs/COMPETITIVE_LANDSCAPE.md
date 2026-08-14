# Competitive landscape — billing-kit vs Lago

Lago is the closest comparison: open-source, usage-based, payment-agnostic. It is
also the sharpest test of our positioning, because "open-source metered billing"
already exists there. The difference is not *open vs closed* — it is **library vs
platform**: Lago is a service you deploy and operate (its own Postgres, API,
workers, dashboard); billing-kit is a dependency you `import`. See
`VALUE_PROPOSITION.md` for the framing. This file is the feature-by-feature read
and, for each gap, a **now / soon / later** call.

Vocabulary below follows Lago's own billing glossary so the comparison is
apples-to-apples.

## Feature matrix

Legend — **core**: shipped in billing-kit; **partial**: possible but not
first-class; **delegated**: handled by the payment provider through the adapter;
**gap**: not addressed.

| Capability | Lago | billing-kit today | Call |
|---|---|---|---|
| Metering — event ingest, dedup/idempotency | ✅ | **core**, idempotent by caller key | — |
| Aggregation — sum / count / max / unique | ✅ all four | **core** (sum); others not all first-class | soon |
| Exact money — integer minor units, ISO 4217 | partial | **core**, stronger; re-derivable | **our edge** |
| Double-entry, append-only ledger | not the model | **core** | **our edge** |
| Multi-currency | partial | **core**, per-currency balances | **our edge** |
| True-up — estimate vs actual reconciliation | ✅ | **core** — `settlement_variance` | **our edge** |
| Payment-agnostic (Stripe/Paddle/…) | ✅ many | **core**, Stripe + Paddle; more via adapters repo | — |
| **Subscriptions / recurring plans** | ✅ first-class | **core** — `billing-kit/subscriptions` | ✅ **shipped** |
| Per-seat pricing | ✅ | **core** — plan `seats`, with a minimum | ✅ **shipped** |
| Free trial / freemium | ✅ | **core** — `trialDays`, waives base + seats | ✅ **shipped** |
| Proration — partial periods | ✅ | **core** — base + seats prorate, usage never | ✅ **shipped** |
| Tiered pricing — volume / graduated | ✅ | **core** — `priceTiered`, rounds once | ✅ **shipped** |
| Hybrid — flat fee + usage overage | ✅ | **core** — a plan binds base + overage | ✅ **shipped** |
| Coupons / discounts | ✅ | **gap** | soon |
| Prepaid credits / wallets | ✅ | **gap** — but ledger-native (a liability account) | soon |
| Credit notes | ✅ | **gap** — but ledger-native (a compensating posting) | soon |
| Invoicing — line items, PDF | ✅ | **delegated** to provider | later |
| Taxes | ✅ via Anrok/Avalara | **gap by design** — interface, no engine | later (adapter) |
| Dunning / failed-payment recovery | ✅ | **gap by design** | later |
| Analytics — MRR / ARR / NRR / churn | ✅ | **gap** — but the ledger is the substrate | later |
| Entitlements / feature-gating | ✅ | **partial** — in ai_member_cloud + portal, not core | later (core vs commercial call) |

**Reading it:** where billing-kit is an *edge*, it's because the correctness model
(exact money + double-entry ledger) is deeper than a platform that treats the
ledger as an implementation detail. Where it's a *gap*, most gaps are either
ledger-native (wallets, credit notes — a liability account and a compensating
posting, which the ledger already supports) or deliberately external (tax,
dunning). The one gap that is neither — and that the common SaaS case actually
needs — is **subscriptions**.

## The one that mattered: subscriptions / recurring plans — shipped

> **Status: built.** Tiered pricing landed in `money.ts` (`priceTiered`) and the
> `billing-kit/subscriptions` entry point ships plans, seats, included
> allowances, metered overage, proration and trials — pure pricing plus a
> ledger-posting `chargeSubscriptionPeriod`. Full unit + adversarial suite green;
> the charge path is idempotency-tested against Postgres. The rest of this
> section is the design, kept for the record.

Previously billing-kit delegated subscriptions to the provider
(`ensureSubscription` on the adapter). That's fine for "let Stripe bill $49/mo" —
but it hands the plan model back to the provider, which is exactly what
billing-kit's thesis says not to do for anything you must answer for. A plan that
mixes a flat fee, included allowances, metered overage and seats is billing
*logic*, not a payment; it belongs on our side of the `settle` line, posted to
our ledger.

### What was built: a `billing-kit/subscriptions` module — not an adapter

An adapter is per-provider (Chargebee, Recurly). Subscriptions are
provider-*independent* billing logic, so they belong in a **new core entry point**,
following the exact pattern `billing-kit/metering` and `billing-kit/providers`
already use: separate import, opt-in compile, no new runtime coupling.

```ts
// billing-kit/subscriptions  (proposed)
import { definePlan, chargePeriod } from 'billing-kit/subscriptions';

const pro = definePlan({
  id: 'pro',
  interval: 'month',
  flat: Money.fromDecimalString('49.00', 'USD'),   // recurring base
  seats: { unit: Money.fromDecimalString('10.00', 'USD'), min: 1 },
  included: { 'tokens.input': Quantity.fromDecimalString('1000000') },
  usage: {                                          // overage, tiered
    'tokens.input': graduated([                     // ← needs tiered pricing
      { upTo: 10_000_000, rate: Rate.fromDecimalString('0.00012') },
      { upTo: null,       rate: Rate.fromDecimalString('0.00008') },
    ]),
  },
  trialDays: 14,
});

// At period close: flat + seats + metered overage, prorated, one balanced posting.
const charge = await chargePeriod(db, { plan: pro, subject, period });
// → accrualPosting(...) to the existing ledger; capture still delegated to provider.
```

What it reuses vs what it adds:

- **Reuses:** `Money`/`Quantity`/`Rate`, the metering aggregates (for overage),
  `accrualPosting` + the ledger, and `settlement_variance` (which *is* true-up).
- **Adds:** a `Plan` type, a period scheduler, proration, trial handling, and —
  the one genuinely new pricing primitive — **tiered pricing (volume/graduated)**,
  since `price()` is currently a single flat rate. Tiered pricing is a prerequisite,
  so it lands with (or just before) the module.

This is the smallest change that closes the biggest gap and stays true to the
"answer it from your own tables" thesis.

## Now / soon / later roadmap

**DONE — the standard-SaaS gap (shipped):**
1. ✅ Tiered pricing (volume + graduated, per-tier flat) in the pricing engine.
2. ✅ `billing-kit/subscriptions`: plans (flat + seats + included + overage),
   proration, trials, and an idempotent `chargeSubscriptionPeriod` that posts to
   the existing ledger; capture stays delegated.

**SOON — high ROI, ledger-native, small surface:**
3. Coupons / discounts — a pricing modifier applied before rounding.
4. Prepaid credits / wallets — a liability account drawn down by usage; the ledger
   already models it, this is a helper + schema, not a new subsystem.
5. Credit notes — a compensating posting; append-only makes this the correct shape
   already.
6. Remaining aggregations (max, unique) as first-class metering options.

**LATER — external by design, or a reporting layer:**
7. Taxes — keep the interface; add an adapter (Anrok/Avalara) rather than an engine.
8. Dunning — provider-side, or a thin retry/schedule module; not core billing math.
9. Analytics (MRR/ARR/NRR/churn) — the ledger is already the substrate; this is a
   reporting/query layer, and a candidate for the commercial tier rather than the
   Apache core.
10. Entitlements — already implemented in ai_member_cloud + the portal; the open
    question is core vs commercial, not whether it exists.

## Open decision for a human

- **Core vs commercial line.** Subscriptions and tiered pricing clearly belong in
  the Apache core (they strengthen the OSS story directly against Lago). Analytics
  and entitlements are better candidates for the commercial tier. Confirm before
  building so the licence boundary is deliberate.
