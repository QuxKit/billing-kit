// providers/errors.ts
//
// One error type for the whole provider boundary, carrying a `kind` the caller
// can branch on. A message string is not an error type: the caller ends up
// matching on substrings, and the day a provider rewords "No such customer"
// every retry policy downstream silently changes behaviour.
//
// The kind that matters most is `ambiguous`. Every other kind tells you what
// happened; `ambiguous` tells you that nobody knows. A request that timed out
// in flight may have landed, and the only safe response is to ask the provider
// — which is why `findCustomer` and `findSettlement` are requirements on the
// interface rather than conveniences.

export type ProviderErrorKind =
  /** Credentials rejected. Never retryable — a retry loop on a bad key is how
   *  an account gets rate-limited into a real outage. */
  | 'auth'
  /** The provider says the object does not exist. */
  | 'not_found'
  /** The provider already holds an object that conflicts. Often success in
   *  disguise: see `ensureCustomer`, where a duplicate-email conflict means the
   *  first attempt landed. */
  | 'conflict'
  /** We sent something the provider will never accept. Retrying is pointless
   *  and the bug is ours. */
  | 'invalid_request'
  | 'rate_limited'
  /** 5xx, or the provider is down. Retryable with backoff. */
  | 'provider_unavailable'
  /** Never reached the provider — DNS, connection refused, TLS. Safe to retry
   *  because nothing was received. */
  | 'network'
  /** Webhook signature did not verify. Respond 400 and do not process. */
  | 'signature_invalid'
  /** Signature verified but the timestamp is outside tolerance — a replay.
   *  Distinct from `signature_invalid` because the operational response is
   *  different: a burst of these means clock skew, not an attacker. */
  | 'signature_stale'
  /** Asked for something this provider declared it cannot do. Should be
   *  unreachable from typed call sites; see the note in types.ts. */
  | 'unsupported'
  /** In flight when it failed. May or may not have landed. Recover by asking,
   *  never by retrying blind. */
  | 'ambiguous'
  /** The provider answered with a shape we cannot read. Distinct from
   *  `invalid_request` so that a provider changing its response format does not
   *  get logged as our bug. */
  | 'malformed_response';

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  provider: string;
  message: string;
  /** HTTP status, when there was one. */
  status?: number;
  /** The provider's own error code, verbatim. */
  code?: string;
  /** Whatever the provider returned. Never logged automatically — it can carry
   *  customer PII and, on some providers, a partial card number. */
  raw?: unknown;
  cause?: unknown;
}

/**
 * Thrown by every adapter. Nothing else escapes an adapter method: a raw
 * `TypeError` from a response body the provider changed is a provider problem,
 * and the caller cannot tell that from the stack.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly raw?: unknown;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.status = init.status;
    this.code = init.code;
    this.raw = init.raw;
  }

  /**
   * Whether the caller may re-issue the identical request.
   *
   * `ambiguous` is deliberately excluded. It is retryable only in the sense
   * that something must happen next, and that something is a lookup, not a
   * repeat — re-issuing a non-idempotent create after a timeout is how a
   * customer gets billed twice.
   */
  get retryable(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'provider_unavailable' ||
      this.kind === 'network'
    );
  }
}

export const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof ProviderError;
