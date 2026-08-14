// Typed failures.
//
// Rule 4 of the API surface is that errors are a discriminated union, never a
// message string. The reason is not tidiness: a caller deciding whether to
// retry has to distinguish "this event was already recorded" from "the database
// is down", and if the only difference is prose then the decision is made by a
// substring match that breaks the first time someone improves the wording.
//
// The union is the contract. The message is for humans and is derived from it,
// never parsed.

export type BillingFailure =
  // --- money ---------------------------------------------------------------
  | { code: 'unknown_currency'; currency: string }
  | { code: 'currency_mismatch'; left: string; right: string }
  | { code: 'invalid_decimal'; value: string; what: string }
  | { code: 'precision_loss'; value: string; scale: number; what: string }
  | { code: 'invalid_allocation'; reason: string }
  | { code: 'invalid_tiers'; reason: string }
  | { code: 'invalid_plan'; reason: string }
  | { code: 'invalid_subscription'; reason: string }

  // --- ingest --------------------------------------------------------------
  | { code: 'invalid_event'; field: string; reason: string }
  /** Same idempotency key, different request. A bug in the caller, surfaced
   *  rather than answered with a stale response for a request never made.
   *
   *  `detail` names what actually differs — the stored value and the one this
   *  call sent. Without it the caller knows a key was reused and has to go and
   *  query for the row to find out how, which is the work this error exists to
   *  save them. Optional because the failure is meaningful without it. */
  | { code: 'idempotency_conflict'; operation: string; key: string; detail?: string }
  /** The dedupe claim neither inserted nor resolved. See events.ts. */
  | { code: 'dedupe_unresolved'; source: string; externalId: string }

  // --- periods -------------------------------------------------------------
  | { code: 'window_sealed'; subjectId: string; metric: string; windowStart: string }
  | { code: 'window_invalid'; reason: string }

  // --- ledger --------------------------------------------------------------
  | { code: 'unbalanced_transaction'; currency: string; residualMinor: string }
  | { code: 'ledger_immutable'; attempted: string }
  | { code: 'account_currency_mismatch'; account: string; expected: string; got: string }

  // --- general -------------------------------------------------------------
  | { code: 'not_found'; what: string; id: string }
  | { code: 'provider_error'; provider: string; operation: string; detail: string };

export type BillingErrorCode = BillingFailure['code'];

function describe(failure: BillingFailure): string {
  switch (failure.code) {
    case 'unknown_currency':
      return `currency ${failure.currency} is not in the ISO 4217 table`;
    case 'currency_mismatch':
      return `currency mismatch: ${failure.left} and ${failure.right}`;
    case 'invalid_decimal':
      return `not a decimal literal for ${failure.what}: ${JSON.stringify(failure.value)}`;
    case 'precision_loss':
      return `${failure.what} ${failure.value} does not fit ${failure.scale} fractional digits without losing a digit`;
    case 'invalid_allocation':
      return `cannot allocate: ${failure.reason}`;
    case 'invalid_tiers':
      return `invalid pricing tiers: ${failure.reason}`;
    case 'invalid_plan':
      return `invalid plan: ${failure.reason}`;
    case 'invalid_subscription':
      return `invalid subscription: ${failure.reason}`;
    case 'invalid_event':
      return `usage event field ${failure.field} is invalid: ${failure.reason}`;
    case 'idempotency_conflict':
      return (
        `idempotency key ${failure.key} for ${failure.operation} was used for a different request` +
        (failure.detail === undefined ? '' : ` (${failure.detail})`)
      );
    case 'dedupe_unresolved':
      return `dedupe claim for ${failure.source}/${failure.externalId} neither inserted nor resolved`;
    case 'window_sealed':
      return `window ${failure.windowStart} for ${failure.subjectId}/${failure.metric} is sealed`;
    case 'window_invalid':
      return `invalid window: ${failure.reason}`;
    case 'unbalanced_transaction':
      return `ledger transaction does not sum to zero in ${failure.currency}: residual ${failure.residualMinor}`;
    case 'ledger_immutable':
      return `the ledger is append-only; ${failure.attempted} is not supported`;
    case 'account_currency_mismatch':
      return `account ${failure.account} holds ${failure.expected}, got ${failure.got}`;
    case 'not_found':
      return `no ${failure.what} with id ${failure.id}`;
    case 'provider_error':
      return `${failure.provider}.${failure.operation} failed: ${failure.detail}`;
  }
}

/**
 * The one error class. Carries the union; the message is generated from it.
 *
 * `failure` is the field to switch on. A caller that reads `.message` to decide
 * anything has reintroduced the problem this type solves.
 */
export class BillingError extends Error {
  readonly failure: BillingFailure;
  readonly code: BillingErrorCode;

  constructor(failure: BillingFailure) {
    super(describe(failure));
    this.name = 'BillingError';
    this.failure = failure;
    this.code = failure.code;
  }

  /** Narrow without instanceof, which fails across duplicated module copies. */
  static is(error: unknown): error is BillingError {
    return error instanceof Error && error.name === 'BillingError' && 'failure' in error;
  }

  static hasCode<C extends BillingErrorCode>(
    error: unknown,
    code: C,
  ): error is BillingError & { failure: Extract<BillingFailure, { code: C }> } {
    return BillingError.is(error) && error.code === code;
  }
}
