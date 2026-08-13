// providers/http.ts
//
// The only way an adapter talks to a provider.
//
// It is here rather than in each adapter because the three things that decide
// whether billing survives a bad afternoon are the same for every provider, and
// getting them subtly different per adapter is how one of them ends up double
// charging:
//
//   1. What may be retried. A POST without an idempotency key that fails
//      mid-flight is not retryable — it is *ambiguous*, and the recovery is to
//      ask the provider what happened, not to send it again.
//   2. What a status code means, mapped once into `ProviderErrorKind` so that
//      callers branch on a kind rather than on a number they looked up.
//   3. That `fetch`, the clock and sleeping are all injected, so the test suite
//      runs offline in milliseconds against fixtures and never needs a key.
//
// There is no dependency here. `fetch`, `AbortController` and `URLSearchParams`
// are in the runtime; an HTTP client library would buy retries we do not want
// and a JSON parser we already have.

import { ProviderError, type ProviderErrorKind } from './errors';

// ---------------------------------------------------------------------------
// The injectable surface
// ---------------------------------------------------------------------------

export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Structurally satisfied by the global `fetch`, which is the default, and by a
 * fixture in tests. Narrow on purpose: the wider `RequestInit` invites an
 * adapter to reach for a feature the fixture does not implement.
 */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface HttpClientOptions {
  /** For error messages only. Never branched on. */
  provider: string;
  baseUrl: string;
  /** Applied to every request. */
  headers: Record<string, string>;
  fetch?: FetchLike;
  /** Injected so a retry test does not take six seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic jitter in tests. */
  random?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  /** application/json body. */
  json?: unknown;
  /** application/x-www-form-urlencoded body, deep-encoded. */
  form?: Record<string, unknown>;
  /**
   * Value for the provider's idempotency header, if it has one.
   *
   * Its presence is what makes a POST retryable. Without it a failed POST is
   * reported as `ambiguous` and the caller must recover by lookup.
   */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

// ---------------------------------------------------------------------------
// Form encoding
// ---------------------------------------------------------------------------

/**
 * Encode nested structures the way form-encoded APIs read them:
 * `metadata[key]=v`, `lines[0][amount]=1999`.
 *
 * `undefined` is dropped and `null` is sent as the empty string, because those
 * mean different things: a field we are not setting versus a field we are
 * clearing. Collapsing them means a "remove this value" call silently does
 * nothing.
 */
export const formEncode = (input: Record<string, unknown>): string => {
  const params = new URLSearchParams();

  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) {
      params.append(prefix, '');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${key}]`, nested);
      }
      return;
    }
    if (typeof value === 'bigint') {
      params.append(prefix, value.toString());
      return;
    }
    params.append(prefix, String(value));
  };

  for (const [key, value] of Object.entries(input)) walk(key, value);
  return params.toString();
};

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

const kindForStatus = (status: number): ProviderErrorKind => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_request';
};

const retryableStatus = (status: number): boolean =>
  status === 429 || status === 408 || status >= 500;

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface HttpClient {
  request<T>(request: HttpRequest): Promise<T>;
  /** Same, but `null` instead of throwing when the provider says not found.
   *  Every `find*` on the interface needs exactly this and nothing else. */
  requestOrNull<T>(request: HttpRequest): Promise<T | null>;
}

export const createHttpClient = (options: HttpClientOptions): HttpClient => {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (typeof doFetch !== 'function') {
    // Better here than as `doFetch is not a function` on the first charge
    // attempt, in production, at the point where money was supposed to move.
    throw new Error(
      `${options.provider}: no fetch implementation. Pass one in options.fetch — ` +
        `this runtime has no global fetch.`,
    );
  }

  const url = (request: HttpRequest): string => {
    const base = `${options.baseUrl.replace(/\/$/, '')}${request.path}`;
    if (!request.query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const encoded = params.toString();
    return encoded ? `${base}?${encoded}` : base;
  };

  const send = async (request: HttpRequest): Promise<{ status: number; body: unknown; text: string }> => {
    const headers: Record<string, string> = { ...options.headers, ...request.headers };
    let body: string | undefined;

    if (request.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = formEncode(request.form);
    } else if (request.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.json);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: HttpResponseLike;
    try {
      response = await doFetch(url(request), {
        method: request.method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, text };
  };

  const request = async <T>(req: HttpRequest): Promise<T> => {
    // A POST the provider cannot deduplicate must not be repeated. Everything
    // else — GETs, and POSTs carrying an idempotency key — is safe to send
    // again.
    const repeatable = req.method === 'GET' || req.idempotencyKey !== undefined;
    let lastError: ProviderError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let result: { status: number; body: unknown; text: string };
      try {
        result = await send(req);
      } catch (cause) {
        // Nothing came back. For a repeatable request that is just a retry; for
        // a bare POST it is the ambiguous case, and the honest answer is that
        // we do not know whether it landed.
        const error = new ProviderError({
          kind: repeatable ? 'network' : 'ambiguous',
          provider: options.provider,
          message: repeatable
            ? `${options.provider} ${req.method} ${req.path} did not complete`
            : `${options.provider} ${req.method} ${req.path} failed in flight and cannot be ` +
              `retried safely; recover by looking the object up`,
          cause,
        });
        if (!repeatable || attempt === maxAttempts) throw error;
        lastError = error;
        await sleep(backoff(attempt, random));
        continue;
      }

      if (result.status >= 200 && result.status < 300) return result.body as T;

      const kind = kindForStatus(result.status);
      // A 5xx on a request we cannot repeat is ambiguous, not merely
      // unavailable: a gateway timeout is returned by the gateway, and the
      // provider behind it may well have processed the request.
      const effectiveKind: ProviderErrorKind =
        !repeatable && result.status >= 500 ? 'ambiguous' : kind;

      const error = new ProviderError({
        kind: effectiveKind,
        provider: options.provider,
        status: result.status,
        code: extractCode(result.body),
        message:
          `${options.provider} ${req.method} ${req.path} -> ${result.status} ` +
          `(${extractMessage(result.body) ?? result.text.slice(0, 200)})`,
        raw: result.body,
      });

      if (!repeatable || !retryableStatus(result.status) || attempt === maxAttempts) throw error;
      lastError = error;
      await sleep(retryAfter(result, attempt, random));
    }

    // Unreachable: the loop either returns or throws on its last attempt. Kept
    // so the function has no implicit `undefined` return, which would type as a
    // successful call that produced nothing.
    throw lastError ?? new ProviderError({
      kind: 'provider_unavailable',
      provider: options.provider,
      message: `${options.provider}: exhausted attempts with no error recorded`,
    });
  };

  const requestOrNull = async <T>(req: HttpRequest): Promise<T | null> => {
    try {
      return await request<T>(req);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') return null;
      throw error;
    }
  };

  return { request, requestOrNull };
};

/** Exponential with full jitter. Without jitter a provider blip turns every
 *  worker into a synchronised herd that arrives together on each retry. */
const backoff = (attempt: number, random: () => number): number =>
  Math.floor(random() * BASE_BACKOFF_MS * 2 ** (attempt - 1));

const retryAfter = (
  result: { status: number },
  attempt: number,
  random: () => number,
): number => backoff(attempt, random) + (result.status === 429 ? BASE_BACKOFF_MS : 0);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/** Pull a provider error code out of the two shapes in use: a nested `error`
 *  object, or a list under `errors`. Best effort, and never throws — a failure
 *  to parse an error must not replace the error. */
const extractCode = (body: unknown): string | undefined => {
  const root = asRecord(body);
  if (!root) return undefined;
  const nested = asRecord(root['error']);
  const code = nested?.['code'] ?? nested?.['type'] ?? root['code'] ?? root['type'];
  return typeof code === 'string' ? code : undefined;
};

const extractMessage = (body: unknown): string | undefined => {
  const root = asRecord(body);
  if (!root) return undefined;
  const nested = asRecord(root['error']);
  const message = nested?.['detail'] ?? nested?.['message'] ?? root['message'] ?? root['detail'];
  return typeof message === 'string' ? message : undefined;
};
