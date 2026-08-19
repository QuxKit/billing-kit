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
// Steps 2, 3 and 4 are `openCase`, the host's cron, and `advanceDunning`.
// Step 5 is `closeCase(db, ref, 'recovered', now)` and wiring it is not
// optional: a case left open after the money arrives keeps its wake-up, and the
// next sweep suspends a customer who has paid.
//
// Before writing any of it, read `forProvider`. Stripe and Paddle already retry
// the card and already send the email; a second loop on top charges twice and
// mails twice. `advanceDunning` applies it for you, from the `capabilities`
// callback it requires.
//
// Needs sql/034_dunning.sql.

export { decide, firstActionAt, forProvider } from './policy.ts';
export type { CaseRef, DueCaseQuery, ListCasesQuery, OpenCaseInput, OpenedCase } from './store.ts';
export { closeCase, dueCases, getCase, listCases, openCase } from './store.ts';
export type {
  DunningSweepError,
  DunningSweepItem,
  DunningSweepOptions,
  DunningSweepReport,
  DunningSweepRetry,
} from './sweep.ts';
export { advanceDunning } from './sweep.ts';
export type {
  DunningAction,
  DunningActionKind,
  DunningCase,
  DunningDecision,
  DunningPolicy,
  DunningState,
  DunningStep,
} from './types.ts';
