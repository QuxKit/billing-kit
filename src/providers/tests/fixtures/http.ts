// providers/tests/fixtures/http.ts
//
// A fetch double, so the whole suite runs offline and no test needs a key.
//
// Requiring a live key to test a billing adapter has a predictable end: the
// tests are skipped in CI, then deleted. Everything here is deterministic —
// routes in, recorded calls out, injected clock, injected sleep — so a retry
// test takes microseconds and a signature test does not depend on today's date.

import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../../http';

export interface RecordedCall {
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed body: form fields flattened, or the JSON value. */
  body: Record<string, string> | unknown;
  rawBody: string | undefined;
}

export type RouteHandler = (call: RecordedCall) => { status: number; body: unknown } | never;

export interface FixtureOptions {
  /** Keyed `"<METHOD> <path>"`, with `:id` matching one path segment. */
  routes: Record<string, RouteHandler>;
}

export interface HttpFixture {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** Calls to one route, for asserting how many times a retry actually ran. */
  callsTo(method: string, path: string): RecordedCall[];
}

/** Thrown by a route to simulate a connection that never answered. The adapter
 *  must treat this as `network` when the request is repeatable and `ambiguous`
 *  when it is not — the single most important branch in http.ts. */
export class FixtureNetworkFailure extends Error {
  constructor() {
    super('fixture: connection reset');
    this.name = 'FixtureNetworkFailure';
  }
}

const parseBody = (init: HttpRequestInit): Record<string, string> | unknown => {
  if (init.body === undefined) return undefined;
  const contentType = init.headers['content-type'] ?? '';
  if (contentType.includes('json')) return JSON.parse(init.body);
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(init.body)) out[key] = value;
  return out;
};

const matches = (pattern: string, path: string): boolean => {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return false;
  return p.every((segment, index) => segment.startsWith(':') || segment === a[index]);
};

export const createHttpFixture = (options: FixtureOptions): HttpFixture => {
  const calls: RecordedCall[] = [];

  const fetch: FetchLike = async (url, init): Promise<HttpResponseLike> => {
    const parsed = new URL(url);
    const query: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) query[key] = value;

    const call: RecordedCall = {
      method: init.method,
      path: parsed.pathname,
      query,
      headers: init.headers,
      body: parseBody(init),
      rawBody: init.body,
    };
    calls.push(call);

    const key = Object.keys(options.routes).find((route) => {
      const [method, pattern] = route.split(' ');
      return method === init.method && pattern !== undefined && matches(pattern, parsed.pathname);
    });

    if (key === undefined) {
      // Loud rather than a 404. An unrouted call means the adapter did
      // something the test did not model, and a 404 would let that pass as a
      // "not found" branch.
      throw new Error(`fixture: no route for ${init.method} ${parsed.pathname}`);
    }

    const handler = options.routes[key];
    if (handler === undefined) throw new Error(`fixture: route ${key} has no handler`);
    const result = handler(call);
    return {
      status: result.status,
      headers: { get: () => null },
      text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)),
    };
  };

  return {
    fetch,
    calls,
    callsTo: (method, path) => calls.filter((c) => c.method === method && matches(path, c.path)),
  };
};

/** A handler that answers with a fixed body, and a status defaulting to 200. */
export const respond =
  (body: unknown, status = 200): RouteHandler =>
  () => ({ status, body });

/** A handler that fails the first `times` calls and then answers. Used to prove
 *  that a retry happens where it is safe and does not where it is not. */
export const failThen = (times: number, then: RouteHandler, status = 500): RouteHandler => {
  let seen = 0;
  return (call) => {
    seen++;
    if (seen <= times) return { status, body: { error: { message: 'transient' } } };
    return then(call);
  };
};

/** Sleep that does not sleep. A retry test should not cost a second. */
export const noSleep = async (): Promise<void> => {};

/** Deterministic "jitter", so backoff maths is reproducible. */
export const noJitter = (): number => 0.5;
