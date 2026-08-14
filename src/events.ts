// Usage ingest.
//
// One job: get an event in exactly once, cheaply, under retry. Everything
// downstream — aggregation, pricing, the ledger, the invoice — is a function of
// what lands here, so a double-counted event is a customer overcharged and a
// dropped one is revenue that never existed.
//
// The contract with the caller is that a duplicate is *success*. It returns 200
// with `deduplicated: true`, never a 409. A retrying client treats 409 as fatal
// and either drops the event or pages someone; the whole point of an idempotent
// endpoint is that the retry is boring.

import { randomUUID } from 'node:crypto';
import { BillingError } from './errors';
import { Quantity } from './money';
import type { RecordedEvent, SqlExecutor, SubjectId, TenantId, UsageEvent, UsageWindow } from './types';

/**
 * How far ahead of the database's clock an event may be dated.
 *
 * An event from the future is almost always a caller with a broken clock, and
 * accepting it does two kinds of damage that cannot be undone later: it lands
 * in a partition that may not have been created yet, and it lands in a window
 * that will be sealed and invoiced before the event's real time arrives.
 * Rejecting it loudly at the door is the only point where it is still cheap.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Bounds on the identifier columns, so one caller cannot bloat every index. */
const MAX_IDENTIFIER_LENGTH = 256;

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BillingError({ code: 'invalid_event', field, reason: 'must be a non-empty string' });
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new BillingError({
      code: 'invalid_event',
      field,
      reason: `must be at most ${MAX_IDENTIFIER_LENGTH} characters`,
    });
  }
}

/**
 * Reject what cannot be stored, before touching the database.
 *
 * Validation is here and not in a check constraint because the caller needs to
 * know which field and why. A 23514 from Postgres tells an on-call engineer
 * that some constraint failed on some row in a batch of five hundred.
 */
export function validateEvent(event: UsageEvent, now: Date): void {
  requireIdentifier(event.tenantId, 'tenantId');
  requireIdentifier(event.subjectId, 'subjectId');
  requireIdentifier(event.source, 'source');
  requireIdentifier(event.externalId, 'externalId');
  requireIdentifier(event.metric, 'metric');

  if (!(event.quantity instanceof Quantity)) {
    throw new BillingError({
      code: 'invalid_event',
      field: 'quantity',
      reason: 'must be a Quantity; a JS number cannot express one exactly',
    });
  }

  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    throw new BillingError({ code: 'invalid_event', field: 'occurredAt', reason: 'must be a valid Date' });
  }

  if (event.occurredAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new BillingError({
      code: 'invalid_event',
      field: 'occurredAt',
      reason: 'is more than 24 hours in the future; check the producer clock',
    });
  }
}

interface ClaimRow {
  event_id: string;
  occurred_at: Date;
  received_at: Date;
  inserted: boolean;
}

/**
 * Claim the dedupe key.
 *
 * `ON CONFLICT ... DO UPDATE` and deliberately not `DO NOTHING`, which is the
 * intuitive choice and is wrong here. `DO NOTHING` does not take a lock on the
 * conflicting row, so when a concurrent transaction has inserted the same key
 * and not yet committed, it returns no row *and* a follow-up SELECT finds
 * nothing — leaving no way to distinguish "already recorded" from "recorded a
 * millisecond ago by the retry racing this one". `DO UPDATE` waits for that
 * transaction and then returns the row either way.
 *
 * The update is a no-op assignment purely to make the row visible to RETURNING.
 * It costs a dead tuple per duplicate, which is the correct trade: duplicates
 * are rare, and the alternative is a race with no safe branch.
 *
 * `xmax = 0` distinguishes the two outcomes. On a freshly inserted tuple xmax
 * is zero; on one updated by this statement it is this transaction's id. It is
 * a system column and therefore an implementation detail of Postgres, but it is
 * the only in-statement signal available and it has been stable for two decades.
 */
async function claimKey(tx: SqlExecutor, event: UsageEvent, eventId: string): Promise<ClaimRow> {
  const rows = await tx.query<ClaimRow>(
    `INSERT INTO billing.usage_event_keys
       (tenant_id, source, subject_id, metric, external_id, event_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, source, subject_id, metric, external_id)
     DO UPDATE SET external_id = billing.usage_event_keys.external_id
     RETURNING event_id, occurred_at, received_at, (xmax = 0) AS inserted`,
    [event.tenantId, event.source, event.subjectId, event.metric, event.externalId, eventId, event.occurredAt],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new BillingError({
      code: 'dedupe_unresolved',
      source: event.source,
      externalId: event.externalId,
    });
  }
  return row;
}

/**
 * Refuse a replay that is not a replay.
 *
 * The dedupe key is (tenant, source, subject, metric, external_id) and does not
 * include the quantity. So a second call under the same key carrying a
 * different quantity hits the claim, takes the duplicate branch, and is
 * answered `deduplicated: true` — reporting success for a request the system
 * never performed, and leaving the first quantity billed. A gateway that
 * retried with a corrected token count, or one whose retry raced its own
 * pagination, loses the correction silently. Nothing errors, nothing logs, and
 * the discrepancy surfaces as an invoice nobody can reconcile.
 *
 * The two silent answers are both wrong. Keeping the stored value discards a
 * correction; overwriting it lets a stale retry clobber one. They cannot be
 * told apart from here, so neither is chosen: the caller is told, which is what
 * `idempotency_conflict` in errors.ts has always said this should do — "a bug
 * in the caller, surfaced rather than answered with a stale response for a
 * request never made". The code was declared and never raised.
 *
 * This is the one place the module's own rule — that a duplicate is success,
 * never a 409 — is deliberately inverted, and for the reason the rule exists.
 * A retry is boring because it is *the same request*. A different request under
 * a used key is not a retry, and a client that treats the failure as fatal is
 * behaving correctly: it has a bug, and finding out now is the cheap outcome.
 *
 * `metadata` is deliberately not compared. It is annotation — a trace id, a
 * request header — and it legitimately differs between a call and its retry.
 * Only what determines the bill is compared: the quantity and when it happened.
 */
async function assertSameEvent(tx: SqlExecutor, event: UsageEvent, claim: ClaimRow): Promise<void> {
  const rows = await tx.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM billing.usage_events WHERE id = $1`,
    [claim.event_id],
  );

  const stored = rows[0];
  if (stored === undefined) {
    // A claimed key with no event behind it. record() writes both in one
    // transaction precisely so this cannot happen, so reaching here means the
    // rows were separated by something outside this module.
    throw new BillingError({ code: 'not_found', what: 'usage_event for a claimed key', id: claim.event_id });
  }

  // Compared as quantities, not as strings: the stored numeric round-trips with
  // whatever scale Postgres chose, so '10' and '10.000' are the same quantity
  // and only one of them is what was sent. Parsing both to the fixed decimal
  // scale makes the comparison exact and independent of that formatting.
  if (Quantity.fromDecimalString(stored.quantity).units !== event.quantity.units) {
    throw new BillingError({
      code: 'idempotency_conflict',
      operation: 'record',
      key: `${event.source}/${event.externalId}`,
      detail: `quantity was ${stored.quantity}, this call sent ${event.quantity.toDecimalString()}`,
    });
  }

  if (claim.occurred_at.getTime() !== event.occurredAt.getTime()) {
    throw new BillingError({
      code: 'idempotency_conflict',
      operation: 'record',
      key: `${event.source}/${event.externalId}`,
      detail: `occurredAt was ${claim.occurred_at.toISOString()}, this call sent ${event.occurredAt.toISOString()}`,
    });
  }
}

async function insertEvent(tx: SqlExecutor, event: UsageEvent, eventId: string): Promise<Date> {
  const rows = await tx.query<{ received_at: Date }>(
    `INSERT INTO billing.usage_events
       (id, tenant_id, subject_id, source, external_id, metric, quantity, occurred_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::jsonb)
     RETURNING received_at`,
    [
      eventId,
      event.tenantId,
      event.subjectId,
      event.source,
      event.externalId,
      event.metric,
      event.quantity.toDecimalString(),
      event.occurredAt,
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new BillingError({ code: 'not_found', what: 'inserted usage_event', id: eventId });
  }
  return row.received_at;
}

/**
 * Record one event.
 *
 * The claim and the event insert are one transaction, so the two cannot
 * disagree. A crash between them would otherwise leave a claimed key with no
 * event behind it — and because the claim is what makes the retry a duplicate,
 * that event could never be recorded again by any number of retries. Silent,
 * permanent, and invisible until someone reconciles a bill by hand.
 */
export async function record(db: SqlExecutor, event: UsageEvent, now: Date): Promise<RecordedEvent> {
  validateEvent(event, now);

  return db.transaction(async (tx) => {
    const eventId = randomUUID();
    const claim = await claimKey(tx, event, eventId);

    if (!claim.inserted) {
      // Costs one SELECT, on the duplicate path only. Duplicates are rare, and
      // the alternative is answering "already recorded" without having checked
      // what was recorded.
      await assertSameEvent(tx, event, claim);
      return {
        eventId: claim.event_id,
        deduplicated: true,
        occurredAt: claim.occurred_at,
        receivedAt: claim.received_at,
      };
    }

    const receivedAt = await insertEvent(tx, event, eventId);
    return { eventId, deduplicated: false, occurredAt: event.occurredAt, receivedAt };
  });
}

function batchKey(event: UsageEvent): string {
  // The same grain as the usage_event_keys primary key: two events dedupe within
  // a batch exactly when they would dedupe against the table. Subject and metric
  // belong in it for the reason the table's comment gives — external_id alone
  // collides across metrics and subjects and silently drops real usage.
  //
  // Length-prefixed so that ("a|b", "c") and ("a", "b|c") are different keys.
  // A separator alone makes them the same, and the collision would drop a real
  // event as a duplicate of an unrelated one.
  const part = (s: string): string => `${s.length}:${s}`;
  return [
    part(event.tenantId),
    part(event.source),
    part(event.subjectId),
    part(event.metric),
    event.externalId,
  ].join('|');
}

/**
 * Record many events in one transaction.
 *
 * Two things this does that the single-event path does not have to:
 *
 * 1. It collapses duplicates *within* the batch before the insert. Postgres
 *    rejects a statement whose `ON CONFLICT DO UPDATE` would touch the same row
 *    twice ("cannot affect row a second time"), so a batch containing the same
 *    external id twice fails whole — every good event in it rejected because of
 *    one caller's retry loop. The first occurrence wins and the rest are
 *    reported as deduplicated, which is what a second call would have returned.
 *
 * 2. It is a multi-row INSERT and not COPY, despite COPY being the faster tool.
 *    COPY has no conflict handling at all, so a COPY-based ingest would need a
 *    staging table and a merge, and would lose the per-row inserted/duplicate
 *    answer this returns. If profiling ever makes that trade worth it, the
 *    staging-table version belongs behind this same signature.
 */
export async function recordMany(
  db: SqlExecutor,
  events: readonly UsageEvent[],
  now: Date,
): Promise<RecordedEvent[]> {
  for (const event of events) validateEvent(event, now);
  if (events.length === 0) return [];

  const firstIndexByKey = new Map<string, number>();
  const unique: UsageEvent[] = [];
  const uniqueIds: string[] = [];
  const originIndex: number[] = [];

  for (const event of events) {
    const key = batchKey(event);
    if (firstIndexByKey.has(key)) continue;
    firstIndexByKey.set(key, unique.length);
    unique.push(event);
    uniqueIds.push(randomUUID());
  }
  for (const event of events) originIndex.push(firstIndexByKey.get(batchKey(event))!);

  const claims = await db.transaction(async (tx) => {
    const rows = await tx.query<ClaimRow & { ord: number }>(
      `WITH incoming AS (
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::timestamptz[]
         ) WITH ORDINALITY AS t(tenant_id, source, subject_id, metric, external_id, event_id, occurred_at, ord)
       ),
       claimed AS (
         INSERT INTO billing.usage_event_keys
           (tenant_id, source, subject_id, metric, external_id, event_id, occurred_at)
         SELECT tenant_id, source, subject_id, metric, external_id, event_id, occurred_at FROM incoming
         ON CONFLICT (tenant_id, source, subject_id, metric, external_id)
         DO UPDATE SET external_id = billing.usage_event_keys.external_id
         RETURNING tenant_id, source, subject_id, metric, external_id, event_id, occurred_at, received_at, (xmax = 0) AS inserted
       )
       SELECT c.event_id, c.occurred_at, c.received_at, c.inserted, i.ord
         FROM claimed c
         JOIN incoming i
           ON i.tenant_id = c.tenant_id AND i.source = c.source
          AND i.subject_id = c.subject_id AND i.metric = c.metric AND i.external_id = c.external_id
        ORDER BY i.ord`,
      [
        unique.map((e) => e.tenantId),
        unique.map((e) => e.source),
        unique.map((e) => e.subjectId),
        unique.map((e) => e.metric),
        unique.map((e) => e.externalId),
        uniqueIds,
        unique.map((e) => e.occurredAt),
      ],
    );

    const byOrd = new Map<number, ClaimRow>();
    for (const row of rows) byOrd.set(Number(row.ord), row);

    const fresh: UsageEvent[] = [];
    const freshIds: string[] = [];
    const replayed: Array<[UsageEvent, ClaimRow]> = [];
    for (let i = 0; i < unique.length; i++) {
      const row = byOrd.get(i + 1);
      if (row === undefined) {
        const event = unique[i]!;
        throw new BillingError({
          code: 'dedupe_unresolved',
          source: event.source,
          externalId: event.externalId,
        });
      }
      if (row.inserted) {
        fresh.push(unique[i]!);
        freshIds.push(uniqueIds[i]!);
      } else {
        replayed.push([unique[i]!, row]);
      }
    }

    // The batch path has to make the same check as record(), or the check is
    // not a property of the library — it is a property of which function you
    // called, and the way to bypass it is to send an array of one.
    //
    // Checked before the insert rather than after, so a conflict anywhere in
    // the batch aborts the whole transaction and nothing lands. A batch that
    // half-applied and then reported a conflict would leave the caller with no
    // safe move: retrying re-sends the events that succeeded, and not retrying
    // drops the ones that did not.
    for (const [event, claim] of replayed) {
      await assertSameEvent(tx, event, claim);
    }

    if (fresh.length > 0) {
      await tx.query(
        `INSERT INTO billing.usage_events
           (id, tenant_id, subject_id, source, external_id, metric, quantity, occurred_at, metadata)
         SELECT * FROM unnest(
           $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[],
           $6::text[], $7::numeric[], $8::timestamptz[], $9::jsonb[]
         )`,
        [
          freshIds,
          fresh.map((e) => e.tenantId),
          fresh.map((e) => e.subjectId),
          fresh.map((e) => e.source),
          fresh.map((e) => e.externalId),
          fresh.map((e) => e.metric),
          fresh.map((e) => e.quantity.toDecimalString()),
          fresh.map((e) => e.occurredAt),
          fresh.map((e) => (e.metadata === undefined ? null : JSON.stringify(e.metadata))),
        ],
      );
    }

    return byOrd;
  });

  // A position is fresh only if the database inserted its key AND this is the
  // first time the key appears in this batch. The second copy of a key inside
  // one call is a duplicate for the same reason a second call would be.
  const alreadyReported = new Set<number>();
  return events.map((_event, i) => {
    const canonical = originIndex[i]!;
    const claim = claims.get(canonical + 1)!;
    const firstHere = !alreadyReported.has(canonical);
    alreadyReported.add(canonical);
    return {
      eventId: claim.event_id,
      deduplicated: !claim.inserted || !firstHere,
      occurredAt: claim.occurred_at,
      receivedAt: claim.received_at,
    };
  });
}

export interface UsageQuery {
  tenantId: TenantId;
  subjectId: SubjectId;
  metric?: string;
  window: UsageWindow;
  limit?: number;
}

export interface StoredUsageEvent {
  eventId: string;
  subjectId: SubjectId;
  source: string;
  externalId: string;
  metric: string;
  quantity: Quantity;
  occurredAt: Date;
  receivedAt: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * Read raw events back.
 *
 * Half-open on `occurred_at`, matching the window convention everywhere else:
 * `[start, end)` so consecutive windows can neither gap nor overlap. A closed
 * upper bound double-counts every event landing exactly on a boundary, which at
 * minute granularity is a great many of them.
 */
export async function queryUsage(db: SqlExecutor, q: UsageQuery): Promise<StoredUsageEvent[]> {
  if (q.window.end.getTime() <= q.window.start.getTime()) {
    throw new BillingError({ code: 'window_invalid', reason: 'end must be after start' });
  }

  const rows = await db.query<{
    id: string;
    subject_id: string;
    source: string;
    external_id: string;
    metric: string;
    quantity: string;
    occurred_at: Date;
    received_at: Date;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, subject_id, source, external_id, metric, quantity::text AS quantity,
            occurred_at, received_at, metadata
       FROM billing.usage_events
      WHERE tenant_id = $1
        AND subject_id = $2
        AND ($3::text IS NULL OR metric = $3)
        AND occurred_at >= $4
        AND occurred_at <  $5
      ORDER BY occurred_at, id
      LIMIT $6`,
    [q.tenantId, q.subjectId, q.metric ?? null, q.window.start, q.window.end, q.limit ?? 1000],
  );

  return rows.map((row) => ({
    eventId: row.id,
    subjectId: row.subject_id,
    source: row.source,
    externalId: row.external_id,
    metric: row.metric,
    // NUMERIC arrives as a string from the driver and must stay one until it
    // reaches an exact type. Number(row.quantity) here would undo the whole
    // point of storing NUMERIC in the first place.
    quantity: Quantity.fromDecimalString(row.quantity),
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    metadata: row.metadata,
  }));
}
