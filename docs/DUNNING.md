# Dunning

A failed payment arrives, is verified, and is written down. What happens next is
a policy, and `billing-kit/dunning` is where that policy is expressed and
evaluated — not where it is carried out.

## Read this before writing any of it

**Stripe and Paddle already dun.** Stripe's Smart Retries charges the card again
on its own schedule and emails the customer; Paddle, as merchant of record, owns
the payer relationship and does the same. A recovery loop layered on top charges
twice and mails twice, and the customer reads that as our bug.

So `ProviderCapabilities` now carries `retriesPayments`, and it is a required
field. The safe default would have to be `false`, and an adapter that forgot to
declare it would silently opt its users into double-dunning; required makes the
omission a compile error in the adapter instead.

```ts
import { forProvider, decide } from '@quxkit/billing-kit/dunning';

// Under Stripe or Paddle this returns a policy in `observe` mode. It tracks the
// case and emits no actions, ever.
const policy = forProvider(myPolicy, provider.capabilities);
```

`forProvider` is one-way: a policy that already says `observe` is never promoted
to active, because the operator who wrote it may have had a reason.

Both shipped adapters declare `retriesPayments: true`. That is the point —
provider-led recovery is the ordinary case, not the exotic one, and a kit whose
dunning assumed otherwise would be wrong for almost everyone who installed it.
An active policy is for a provider that only invoices (Lago hands off to a PSP)
or for a host collecting by invoice and bank transfer.

## What is in core, and what is not

In: a case shape, a policy shape, and one pure function that says what is due.

Not in, and not coming: an email, a template, a cron, an HTTP route, or a
default ladder. The first four belong to the host for the reason
`chargeDueSubscriptions` has no schedule — the trigger and its authentication
are the host's, and a library that sends the mail has chosen your ESP, your
templates and your failure handling for you. The fifth is an opinion, and
shipping one decides how aggressively every adopter chases their customers.

## The policy

```ts
const policy: DunningPolicy = {
  steps: [
    { afterHours: 0,   actions: ['notify', 'flag_past_due'] },
    { afterHours: 72,  actions: ['notify', 'retry_payment'] },
    { afterHours: 120, actions: ['notify'] },
  ],
  onExhausted: { afterHours: 48, actions: ['suspend_entitlements', 'write_off'] },
};
```

`onExhausted` is a step like any other rather than a bare list of actions,
because the gap between the final notice and the cut-off is a real product
decision. A policy that could not express it would have that gap be zero —
suspending the customer in the same sweep that emailed them.

The five action kinds are names, not implementations. Two already have homes:
`suspend_entitlements` is answered from the subscription state
(`billing-kit/entitlements`), and `write_off` is `markUncollectible` on the
invoice.

## Deciding

`decide` is pure and is the only place the schedule is interpreted. A sweep that
read `attempts` in one place to pick the email and in another to pick the next
wake-up would eventually disagree with itself, and the symptom is a customer who
gets the final notice twice and the cut-off never.

```ts
const decision = decide({ dunningCase, policy, now });
// decision.actions      what to do, in order — the host performs them
// decision.state        where the case moves
// decision.attempts     the step count to write back
// decision.nextActionAt when to look again; null when finished
// decision.reason       why, in words, for the audit trail
```

The rules, in the order they are checked:

1. A terminal case is finished. No actions, ever, however many times it is
   swept. This is what makes the sweep idempotent rather than merely survivable.
2. Under `observe`, nothing is ever due, and nothing is scheduled — a case with
   a wake-up under a provider-led policy is a sweep that finds work it must then
   decline to do, every tick, forever.
3. Not yet due: nothing, and the existing wake-up stands.
4. Due, with a step left: fire it, schedule the next — or the cut-off, if that
   was the last.
5. Due, out of steps: fire `onExhausted` and close the case.

`written_off` is the terminal state for a case that ran out of steps, whether or
not `onExhausted` includes the `write_off` action. The state records that we
stopped pursuing the money; the action records that the invoice was posted
uncollectible. A host that suspends but keeps the receivable on the books omits
the action and still gets the closed case.

## What is not built yet

Persistence. There is no `billing.dunning_cases` table and no
`advanceDunning(db, now)` sweep — see issue #35. When they land they will be
shaped like `chargeDueSubscriptions`: a transaction-scoped advisory lease so a
second sweep is a no-op, `FOR UPDATE SKIP LOCKED` per case, one case per call,
no schedule and no HTTP.

The intended loop:

1. a verified `payment.failed` arrives
2. open a case, or find the open one for that settlement ref — idempotent on
   `(tenantId, settlementRef)`, so three deliveries of the same webhook open one
   case and a provider's own failed retry reuses it rather than starting a
   second ladder for the same debt
3. a cron the host owns calls the sweep
4. `decide` per case; perform the returned actions; write the new state
5. a verified `payment.succeeded` closes the case as `recovered`

The contract above is usable today by a host that keeps the cases itself.

## What a hosted add-on could add

Dunning is *operationally* hosted-shaped, not knowledge-shaped, and the
difference matters when writing the pitch. Retry ladders and email copy do not
change weekly the way tax rules do. What a service would actually run:

- the cron that fires the sweep
- the sending, through mail-kit / QuxMail, with delivery events and suppression
- a hosted, tokenized "update your card" page — short-lived, scoped, not a
  login
- templates, localisation, and the recovery analytics that say whether any of it
  worked

That is worth paying for. It is not worth describing as regulatory upkeep,
because it is not, and a customer will notice.

One pricing note, since it is the obvious model and it conflicts with the
product: the usual dunning vendors charge a percentage of recovered revenue.
billing-kit's README sells **"No platform tax. Nobody takes a slice of your
revenue."** A percentage-of-recovery add-on contradicts the sentence that sells
the core. Flat or tiered.
