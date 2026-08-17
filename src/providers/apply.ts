// providers/apply.ts
//
// From a VerifiedEvent to the ledger, once.
//
// `verifyWebhook` proves the bytes came from the provider and normalises them.
// It deliberately stops there: it has no database. This is the other half — the
// one every host used to hand-write in its webhook route, and the one every
// host got subtly wrong in the same two places:
//
//   - the mapping: which normalised kinds post which legs. `payment.succeeded`
//     is cash in against the customer's balance; `refund.settled` is the mirror;
//     `payment.failed` and `refund.declined` post nothing at all, and the tempting
//     "post a negative payment" for a failure is how a balance ends up owing
//     money that never moved.
//   - the replay guard: providers redeliver. The ledger is idempotent on its own
//     key, but a handler that reaches the ledger by way of any other side effect
//     (an email, a provisioning call, a state flip) needs the guard in front of
//     all of it, in the provider's terms. `billing.provider_events`, keyed by
//     (provider, providerEventId), is that guard, and it records every event —
//     the ones that post and the ones that do not — so a replay is answered
//     from the row and never re-evaluated.
//
// What is still the host's: which subject a settlement belongs to. The event
// carries the provider's settlement ref; only the application (or, later, an
// invoice row that stored the ref when it settled) knows whose it is. So the
// resolver is a parameter, and an event it cannot resolve is recorded and
// skipped — never posted against a guess.

import { paymentPosting, post, refundPosting } from '../ledger';
import type { LedgerPosting, PostedTransaction, SqlExecutor, SubjectId, TenantId } from '../types';
import type { VerifiedEvent } from './types';

export interface ResolvedSubject {
  tenantId: TenantId;
  subjectId: SubjectId;
}

/**
 * Whose event this is. Called once per event, before it is recorded. Return
 * null when the reference is not one you know — the event is then recorded as
 * `unresolved_subject` and nothing is posted.
 */
export type SubjectResolver = (event: VerifiedEvent) => ResolvedSubject | null | Promise<ResolvedSubject | null>;

export interface ApplyVerifiedEventInput {
  /** The adapter's `name`. Namespaces `providerEventId` in the replay guard. */
  provider: string;
  event: VerifiedEvent;
  resolve: SubjectResolver;
  /** Received-at, for the record. Defaults to now. Postings use the event's own
   *  `occurredAt`, never this. */
  now?: Date;
}

/** Why an event was recorded without a posting. */
export type ApplySkipReason =
  /** `payment.failed`: money did not move. Nothing to post. */
  | 'payment_failed'
  /** `refund.declined`: the refund was refused. Nothing to post. */
  | 'refund_declined'
  /** `kind: 'unknown'` — signature valid, meaning not modelled. */
  | 'unmodelled'
  /** A modelled kind that carries no money movement (finalized, voided,
   *  subscription.changed). Informational; the state machines read these. */
  | 'no_posting'
  /** The resolver returned null. */
  | 'unresolved_subject';

interface AppliedBase {
  provider: string;
  providerEventId: string;
  kind: VerifiedEvent['kind'];
  /** True when this (provider, providerEventId) had already been recorded.
   *  Nothing was written on this call; the rest of the result is what the
   *  first call recorded. */
  deduplicated: boolean;
}

export type AppliedEvent = AppliedBase &
  (
    | {
        applied: true;
        sourceKind: 'payment' | 'refund';
        /** The ledger transaction's source_id, for `entries()` and reconciliation. */
        sourceId: string;
        transactionId: string;
        tenantId: TenantId;
        subjectId: SubjectId;
      }
    | { applied: false; reason: ApplySkipReason }
  );

interface EventRow {
  inserted: boolean;
  outcome: 'posted' | 'skipped';
  reason: string | null;
  transaction_id: string | null;
  source_id: string | null;
  tenant_id: string | null;
  subject_id: string | null;
}

type Plan =
  | { post: LedgerPosting; sourceKind: 'payment' | 'refund'; subject: ResolvedSubject }
  | { skip: ApplySkipReason };

/**
 * The mapping, on its own so it can be read as a table.
 *
 * The posting's source_id is keyed by the provider's *settlement* (or refund)
 * ref, not by the event id, on purpose. Stripe emits both `invoice.paid` and
 * `invoice.payment_succeeded` for one invoice — two event ids, one payment —
 * and keying by event would post the cash twice. Keyed by settlement, the
 * second event finds the first posting under the same key with the same legs
 * and the ledger reports it deduplicated. If a provider ever sends two
 * *different* amounts for one settlement, `post` refuses with
 * `idempotency_conflict`, which is the right answer: that is a discrepancy for
 * a human, not something to average.
 */
function plan(input: ApplyVerifiedEventInput, subject: ResolvedSubject | null): Plan {
  const { event, provider } = input;
  switch (event.kind) {
    case 'payment.succeeded': {
      if (subject === null) return { skip: 'unresolved_subject' };
      return {
        sourceKind: 'payment',
        subject,
        post: paymentPosting({
          tenantId: subject.tenantId,
          subjectId: subject.subjectId,
          paymentId: `${provider}:${event.settlementRef}`,
          amount: event.amount,
          occurredAt: event.occurredAt,
          memo: `${provider} payment for ${event.settlementRef}`,
        }),
      };
    }
    case 'refund.settled': {
      if (subject === null) return { skip: 'unresolved_subject' };
      return {
        sourceKind: 'refund',
        subject,
        post: refundPosting({
          tenantId: subject.tenantId,
          subjectId: subject.subjectId,
          refundId: `${provider}:${event.refundRef}`,
          amount: event.amount,
          occurredAt: event.occurredAt,
          memo: `${provider} refund ${event.refundRef}`,
        }),
      };
    }
    case 'payment.failed':
      return { skip: 'payment_failed' };
    case 'refund.declined':
      return { skip: 'refund_declined' };
    case 'unknown':
      return { skip: 'unmodelled' };
    case 'settlement.finalized':
    case 'settlement.voided':
    case 'subscription.changed':
      return { skip: 'no_posting' };
  }
}

/**
 * Record a verified event and post what it means, exactly once.
 *
 * Idempotent on (provider, providerEventId). The claim on
 * `billing.provider_events` and the ledger posting are one transaction, so a
 * crash between them leaves no half-applied event: either the row and the
 * posting both exist, or neither does and the redelivery starts clean.
 *
 * Only `payment.succeeded` and `refund.settled` post. Everything else is
 * recorded with a reason and `applied: false` — including `payment.failed`,
 * which is a fact about the provider's attempt and not a movement of money.
 */
export async function applyVerifiedEvent(db: SqlExecutor, input: ApplyVerifiedEventInput): Promise<AppliedEvent> {
  const { event, provider } = input;
  const now = input.now ?? new Date();

  // Resolve before the claim so the row records who this was for. The resolver
  // is a read; calling it on a replay costs a lookup and changes nothing.
  const needsSubject = event.kind === 'payment.succeeded' || event.kind === 'refund.settled';
  const subject = needsSubject ? await input.resolve(event) : null;
  const decided = plan(input, subject);

  return db.transaction(async (tx) => {
    const [row] = await tx.query<EventRow>(
      `INSERT INTO billing.provider_events
         (provider, provider_event_id, kind, occurred_at, received_at,
          tenant_id, subject_id, outcome, reason, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (provider, provider_event_id)
       DO UPDATE SET provider_event_id = billing.provider_events.provider_event_id
       RETURNING (xmax = 0) AS inserted, outcome, reason, transaction_id, source_id, tenant_id, subject_id`,
      [
        provider,
        event.providerEventId,
        event.kind,
        event.occurredAt,
        now,
        'post' in decided ? decided.subject.tenantId : (subject?.tenantId ?? null),
        'post' in decided ? decided.subject.subjectId : (subject?.subjectId ?? null),
        'post' in decided ? 'posted' : 'skipped',
        'post' in decided ? null : decided.skip,
        event.raw === undefined ? null : JSON.stringify(event.raw),
      ],
    );

    const base = { provider, providerEventId: event.providerEventId, kind: event.kind };

    if (row !== undefined && !row.inserted) {
      // Seen before. Answer from the record; touch nothing.
      if (row.outcome === 'posted' && row.transaction_id && row.source_id && row.tenant_id && row.subject_id) {
        return {
          ...base,
          deduplicated: true,
          applied: true,
          sourceKind: event.kind === 'refund.settled' ? 'refund' : 'payment',
          sourceId: row.source_id,
          transactionId: row.transaction_id,
          tenantId: row.tenant_id,
          subjectId: row.subject_id,
        };
      }
      return { ...base, deduplicated: true, applied: false, reason: (row.reason ?? 'no_posting') as ApplySkipReason };
    }

    if (!('post' in decided)) {
      return { ...base, deduplicated: false, applied: false, reason: decided.skip };
    }

    const posted: PostedTransaction = await post(tx, decided.post, now);
    await tx.query(
      `UPDATE billing.provider_events SET transaction_id = $3, source_id = $4
        WHERE provider = $1 AND provider_event_id = $2`,
      [provider, event.providerEventId, posted.transactionId, decided.post.sourceId],
    );

    return {
      ...base,
      deduplicated: false,
      applied: true,
      sourceKind: decided.sourceKind,
      sourceId: decided.post.sourceId,
      transactionId: posted.transactionId,
      tenantId: decided.subject.tenantId,
      subjectId: decided.subject.subjectId,
    };
  });
}
