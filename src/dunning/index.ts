// billing-kit/dunning — the seam a recovery loop attaches to.
//
// A separate entry point, so a host that sells only through a provider which
// duns for it never compiles any of this.
//
// What is here: a case shape, a policy shape, and one pure function that says
// what is due. What is not here, and will not be: an email, a template, a cron,
// an HTTP route, or a default ladder. The first four belong to the host for the
// same reasons `chargeDueSubscriptions` has no schedule; the fifth is an
// opinion, and a library that ships one has chosen how aggressively every
// adopter chases their customers.
//
// The intended shape of the host's loop:
//
//   1. a verified `payment.failed` arrives
//   2. open a case, or find the open one for that settlement ref
//   3. a cron the host owns calls the sweep
//   4. decide() per case; perform the returned actions; write the new state
//   5. a verified `payment.succeeded` closes the case as `recovered`
//
// Steps 2 and 4's persistence are not built yet — see issue #35. This module is
// the contract they will be built against, and it is usable today by a host
// that keeps the cases itself.
//
// Before writing any of that, read `forProvider`. Stripe and Paddle already
// retry the card and already send the email; a second loop on top charges twice
// and mails twice.

export { decide, firstActionAt, forProvider } from './policy.ts';
export type {
  DunningAction,
  DunningActionKind,
  DunningCase,
  DunningDecision,
  DunningPolicy,
  DunningState,
  DunningStep,
} from './types.ts';
