# billing-kit — value proposition

*The one-paragraph version, the honest version, and the framing to reuse in a
landing page or a sales conversation.*

## One paragraph

Usage-based billing arrives in two shapes today, and both put the logic somewhere
you don't control: a **hosted platform** (Metronome, Orb, Stripe Billing) that
meters and invoices for you and takes a percentage of revenue you already earned,
or a **service you deploy** (Lago, OpenMeter, Kill Bill) that you run and operate
as a separate system. billing-kit is a third shape — **a library you embed.** You
`import` metering, pricing and a double-entry ledger into the app you already run,
riding on the payment provider you already use. No cut of your revenue, and no
second service to operate.

## The wedge, stated precisely

Two claims, each true under a technical read — which matters, because the loose
version ("billing is expensive and takes a percentage") does not survive one.

**vs hosted platforms — no tax on your revenue.**
A hosted metering platform charges a fee on billed revenue *on top of* what the
payment processor already takes. billing-kit removes that second fee: the pricing
tables and the financial record are your own tables. It does **not** remove the
payment processor's cut — you still pay Stripe/Paddle to move money. Be exact
about this; conflating the two is the first thing a technical buyer catches.

**vs open-source platforms — a dependency, not infrastructure.**
Lago, OpenMeter and Kill Bill are real, and some are mature and well-funded — so
"novel because open-source" is *not* the claim. The claim is *library vs service*:
they are systems you deploy and operate (a container, a Postgres, an API over the
network, another thing that can page you at 3am); billing-kit is a dependency you
`import`. Among credible options it is close to alone on that side of the line.

## Why in-process is worth it

- **No platform tax.** Nobody takes a slice of your revenue to compute a number.
- **Answerable numbers.** Integer minor units, the ISO 4217 exponent table, and an
  append-only double-entry ledger make every amount re-derivable — you can answer
  *"why is this number"* offline, from your own data, at any time. This is the
  spine, not a feature: a balance that depends on a vendor's black box or a
  query plan can't be audited.
- **It survives a provider change.** The ledger is yours; switching from Stripe to
  Paddle changes an adapter, not your financial history.
- **No ops surface.** No second service to stand up, monitor, back up, or upgrade.

## What it deliberately is not

billing-kit is not a tax engine, a dunning system, a payments processor, an
accounting system, or a pricing UI. It has clean interfaces where each of those
attaches and no opinions inside them. That restraint is the reason it stays a
small dependency instead of drifting into a platform — the exact thing it's
positioned against.

## Positioning lines (reusable)

> **Drop-in usage billing you own — no metering-platform fee, no service to run.
> It rides your existing Stripe or Paddle.**

> Billing as a library, not a platform. Meter, price, and keep a double-entry
> ledger in your own app — and answer "why is this number" from your own tables.

## The honest caveats

- The category moves fast; competitors' licences and pricing change quarterly.
  Verify Lago/OpenMeter specifics live before baking a claim into marketing.
- billing-kit is younger and narrower than the platforms. For a team that wants a
  turnkey UI, dunning, tax and analytics on day one, a platform is less work today
  — the trade they make is the percentage and the lock-in. Sell the trade, not a
  claim of feature parity.

## See also

- `docs/COMPETITIVE_LANDSCAPE.md` — feature-by-feature vs Lago, with a now/later
  recommendation for each gap.
- `README.md` — the "problem it solves" brief and the correctness model.
