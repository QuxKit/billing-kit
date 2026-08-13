# providers/

The provider boundary, and two implementations.

```
  billing-kit                                   provider
  ───────────                                   ────────
  metering                    ensureCustomer ──▶ customers
  aggregation                 findCustomer   ──▶
  pricing                     resolveItem    ──▶ prices
  the ledger    ── settle ──▶ settle         ──▶ invoice / transaction
  idempotency                 refund         ──▶ refund / adjustment
                              verifyWebhook  ◀── payment, refund, subscription
```

Everything left of `settle` is ours. The boundary is drawn there and nowhere
earlier, because that is the only place Stripe and Paddle agree — see
`docs/ARCHITECTURE.md` §2 for the derivation.

## Files

| File | What it is |
|---|---|
| `types.ts` | The interface and every type crossing it. Read this first. |
| `capabilities.ts` | Every decision billing-kit makes about a provider. No branch reads `provider.name`. |
| `errors.ts` | `ProviderError` and its `kind` union. `ambiguous` is the important one. |
| `http.ts` | The only way an adapter talks out. Injected `fetch`, clock and sleep. |
| `signature.ts` | Timestamped-HMAC verification, shared by both adapters. |
| `amounts.ts` | Reading exact money out of provider JSON, without a float in the middle. |
| `stripe/` | Both settlement modes, synchronous refunds, searchable metadata. |
| `paddle/` | Merchant of record: quantity only, refunds by approval, no subscription create. |
| `tests/` | Offline, fixture-driven. No live key, no network. |

## Running the tests

This layer imports `../money`, so it typechecks and runs only once that module
exists. With a root `tsconfig.json` (`strict`, `moduleResolution: bundler`,
`types: ["node"]`) and `tsx` and `@types/node` installed:

```sh
# type check, which is also where the compile-time assertions run
npx tsc --noEmit -p tsconfig.json

# the suite
node --import tsx --test src/providers/tests/*.test.ts
```

`tsx` is what resolves the extensionless imports this repository uses, matching
`ai_member`; Node's own type stripping would need `.ts` extensions on every
import. It is the only tool this layer needs beyond `typescript` — there is no
HTTP client, no test framework and no crypto library here, and none is wanted.

`tests/compile-time.ts` has no runtime assertions on purpose. It is a list of
`@ts-expect-error` cases, so `tsc` fails the build if any of them stops being an
error — that is the enforcement for the three anti-patterns below, and it cannot
be commented out in a call site the way a runtime check can.

## What the interface makes impossible

Three defects were found in the reference application's billing routes. Each is
answered structurally rather than by a check somebody has to remember:

**Crediting a balance from a request body with no processor call.** There is no
`credit`, `topUp` or `addFunds` anywhere on this boundary. Cash reaches the
ledger only from a `payment.succeeded` event, and a `VerifiedEvent` can only be
produced by `verifyWebhook` — the functions that build one
(`normaliseStripeEvent`, `normalisePaddleEvent`) are not exported from
`index.ts`. There is no function to call with a request body.

**An unauthenticated billing trigger.** This layer exports no HTTP handler, so
there is no shared-secret check to comment out. How a run is triggered and
authenticated belongs to the host application.

**Trusting a client-supplied provider customer id.** `ProviderId<Kind>` is a
branded string. It can only come from an object an adapter returned, or from
`providerIdFromOurRecords`, which exists for the persistence layer rehydrating a
row it wrote and is named so that calling it on `req.body.customerId` reads as
the mistake it is. `const id: ProviderCustomerId = req.body.customerId` does not
compile.

## Where a provider genuinely cannot do something

Stated on the capability descriptor and reflected in the type, not thrown at
runtime:

| Cannot | Declared as | Effect at the call site |
|---|---|---|
| Paddle cannot take amounts we computed | `settlement: ['quantity']` | `paddle.settle({ mode: 'lines' })` does not compile |
| Paddle cannot create a subscription | `createsSubscriptions: false` | `paddle.ensureSubscription` is absent from the type |
| Paddle cannot find a customer by our key | `customerLookup: ['email']` | `findCustomer` without an email raises `unsupported` rather than answering `null`, because `null` means "it did not land" and would cause a duplicate |
| Paddle has no confirmed request idempotency key | `idempotency: null` | a failed POST is `ambiguous`, never retried, and recovered by lookup |

`assertSettlementMode` and `canFindCustomer` exist for the dynamic path only,
where the mode came out of a configuration row rather than a literal.

## Dependency on `Money`

This layer imports `Money` from `../money` and uses exactly three members:
`Money.fromMinor(bigint | string, currency)`, `.minor` and `.currency`. It
depends on `fromMinor` refusing a JS `number` — `tests/compile-time.ts` asserts
that it does.

## Provenance

Nothing here is copied from `brett_ai`. Chain of title there is unresolved and
this code was written from documented behaviour. Two things are worth recording
for the root `PROVENANCE.md` when it exists:

- The float argument in `amounts.ts` is a response to the reference schema
  declaring money columns as `Float`. The response is an idea — assert exact
  integers at the boundary — not a line of code.
- Both adapters' endpoint shapes are written from each provider's published API
  behaviour as understood at the time of writing, not from a live account. The
  fixtures pin our own logic; they do not prove the provider's contract.
  Validate both against a sandbox before release. The specific claim least
  certain is Paddle's request idempotency support, which is why the adapter
  defaults to declaring none.
