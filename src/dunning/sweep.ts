// Finding what is due, and advancing it — the time-bound half of dunning.
//
// The same shape as `chargeDueSubscriptions`, deliberately, down to the two
// locks: a transaction-scoped lease so a second sweep firing mid-run returns at
// once, and `FOR UPDATE SKIP LOCKED` per case so a row one worker holds is
// skipped rather than acted on twice. A host running both sweeps off one cron
// should not have to learn two concurrency stories.
//
// What is NOT here, for the same reason it is not there: no schedule and no
// HTTP. The trigger, and the authentication of the trigger, belong to the host.
//
// One thing is different, and it is the thing to understand before wiring this
// up. `chargeDueSubscriptions` finishes its work inside the transaction — the
// ledger post and the period advance commit together. This sweep cannot: its
// work is an email, and an email cannot be rolled back. So it commits the state
// change and hands the actions back, which makes the failure mode a *missed*
// send rather than a duplicated one. That is the right way round — a customer
// who is emailed twice about a failed payment complains, and a customer who is
// emailed once late does not notice — and the recovery is to replay the step,
// which is safe because every action carries `(tenantId, settlementRef, step)`.

import { BillingError } from '../errors.ts';
import type { SqlExecutor, TenantId } from '../types.ts';
import { decide, forProvider } from './policy.ts';
import { DUNNING_COLUMNS, type DunningCaseRow, toDunningCase } from './store.ts';
import type { DunningAction, DunningCase, DunningPolicy, DunningState } from './types.ts';

export interface DunningSweepRetry {
  /** Extra attempts after the first failure. Default 2 (three tries in all). */
  retries?: number;
  /** Delay before the first retry; doubles each time. Default 100ms. */
  backoffMs?: number;
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DunningSweepOptions {
  /** Advance everything due at or before this. Defaults to now. */
  now?: Date;
  /** Restrict to one tenant. Omit to sweep all. */
  tenantId?: TenantId;
  /** Cap the batch. Defaults to 200; a larger backlog drains over later sweeps. */
  limit?: number;
  /**
   * The ladder for a case. A function rather than a value so a plan, a
   * currency or a customer's history can choose one — an enterprise account on
   * net-30 terms should not be chased on the same schedule as a self-serve
   * card.
   */
  policy: (dunningCase: DunningCase) => DunningPolicy | Promise<DunningPolicy>;
  /**
   * What the provider named on a case does about a failed payment.
   *
   * Required, and required for one reason: `forProvider` is applied here, from
   * this answer, so the sweep cannot be run without having stated whether each
   * provider is already retrying the card. Making it optional would mean a host
   * could wire the sweep, forget the question, and double-charge every customer
   * on Stripe — which is precisely the failure the capability was added to
   * prevent, reintroduced one layer up.
   *
   * Return undefined for a provider you cannot answer for; its cases are
   * skipped and reported rather than guessed at.
   */
  capabilities: (
    provider: string,
  ) => { retriesPayments: boolean } | undefined | Promise<{ retriesPayments: boolean } | undefined>;
  /**
   * The per-run lease. Default: on, keyed by tenant (or a global key when
   * sweeping all tenants). Pass `false` to disable — required when the executor
   * cannot hold a second connection open, since the lease is a transaction that
   * stays open while cases are advanced on others.
   */
  lease?: { key?: string } | false;
  /** Per-case retry policy. */
  retry?: DunningSweepRetry;
}

export interface DunningSweepItem {
  caseId: string;
  settlementRef: string;
  /** Where the case now is. */
  state: DunningState;
  attempts: number;
  nextActionAt: Date | null;
  /** The decision's words, already written to the case. */
  reason: string;
  actions: readonly DunningAction[];
}

export interface DunningSweepError {
  settlementRef: string;
  message: string;
  code?: string;
  attempts: number;
}

export interface DunningSweepReport {
  /** False when another sweep held the lease; nothing was looked at. */
  leased: boolean;
  /** How many due cases were looked at. */
  swept: number;
  /** How many moved — a step fired, or the case closed. */
  advanced: number;
  /**
   * Every action from every case, in case order then step order. This is the
   * work list, and it is the whole of what the host has to do.
   */
  actions: DunningAction[];
  items: DunningSweepItem[];
  /** Cases whose provider `capabilities` did not answer for. Left untouched. */
  skipped: string[];
  /** Cases another worker held, or that were no longer due, when we reached them. */
  locked: string[];
  /** Per-case failures after retries; one bad row never halts the sweep. */
  errors: DunningSweepError[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stable int8 for pg_try_advisory_xact_lock, from the lease key. */
const LEASE_SQL = `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got`;

/**
 * Advance every dunning case whose next step has come due.
 *
 * One step per case per call: a case many steps overdue moves one step here and
 * is picked up by the next sweep, so a cron that was down for a week does not
 * fire the whole ladder — three emails and a suspension — into one customer's
 * inbox in one second. That is the same catch-up rule the subscription sweep
 * uses, and here it is the difference between recovering late and looking
 * broken.
 */
export async function advanceDunning(db: SqlExecutor, opts: DunningSweepOptions): Promise<DunningSweepReport> {
  if (opts.lease === false) return sweep(db, opts);

  const key = opts.lease?.key ?? `billing-kit:dunning:${opts.tenantId ?? '*'}`;
  return db.transaction(async (lease) => {
    const [row] = await lease.query<{ got: boolean }>(LEASE_SQL, [key]);
    if (row === undefined || !row.got) {
      return {
        leased: false,
        swept: 0,
        advanced: 0,
        actions: [],
        items: [],
        skipped: [],
        locked: [],
        errors: [],
      };
    }
    return sweep(db, opts);
  });
}

async function sweep(db: SqlExecutor, opts: DunningSweepOptions): Promise<DunningSweepReport> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const due = opts.tenantId
    ? await db.query<DunningCaseRow>(
        `SELECT ${DUNNING_COLUMNS} FROM billing.dunning_cases
          WHERE state = 'open' AND next_action_at IS NOT NULL AND next_action_at <= $1 AND tenant_id = $2
          ORDER BY next_action_at LIMIT $3`,
        [now, opts.tenantId, limit],
      )
    : await db.query<DunningCaseRow>(
        `SELECT ${DUNNING_COLUMNS} FROM billing.dunning_cases
          WHERE state = 'open' AND next_action_at IS NOT NULL AND next_action_at <= $1
          ORDER BY next_action_at LIMIT $2`,
        [now, limit],
      );

  const report: DunningSweepReport = {
    leased: true,
    swept: due.length,
    advanced: 0,
    actions: [],
    items: [],
    skipped: [],
    locked: [],
    errors: [],
  };

  const retries = Math.max(0, opts.retry?.retries ?? 2);
  const backoffMs = Math.max(0, opts.retry?.backoffMs ?? 100);
  const sleep = opts.retry?.sleep ?? defaultSleep;

  for (const row of due) {
    const candidate = toDunningCase(row);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const outcome = await advanceOne(db, opts, candidate, now);
        if (outcome.kind === 'skipped') report.skipped.push(candidate.settlementRef);
        else if (outcome.kind === 'locked') report.locked.push(candidate.settlementRef);
        else {
          report.items.push(outcome.item);
          report.actions.push(...outcome.item.actions);
          if (outcome.moved) report.advanced += 1;
        }
        break;
      } catch (error) {
        if (attempt <= retries) {
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
        report.errors.push({
          settlementRef: candidate.settlementRef,
          message: BillingError.is(error) ? error.message : String(error),
          code: BillingError.is(error) ? error.code : undefined,
          attempts: attempt,
        });
        break;
      }
    }
  }

  return report;
}

type Outcome = { kind: 'skipped' } | { kind: 'locked' } | { kind: 'advanced'; item: DunningSweepItem; moved: boolean };

/**
 * One case, in one transaction: lock the row (skipping it if another worker has
 * it), re-read it, decide, and write the decision. The actions travel back out
 * to be performed after the commit — see the note at the top of this file.
 */
async function advanceOne(
  db: SqlExecutor,
  opts: DunningSweepOptions,
  candidate: DunningCase,
  now: Date,
): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<DunningCaseRow>(
      `SELECT ${DUNNING_COLUMNS} FROM billing.dunning_cases
        WHERE tenant_id = $1 AND id = $2 AND state = 'open'
          AND next_action_at IS NOT NULL AND next_action_at <= $3
        FOR UPDATE SKIP LOCKED`,
      [candidate.tenantId, candidate.id, now],
    );
    const row = rows[0];
    if (row === undefined) return { kind: 'locked' };
    const dunningCase = toDunningCase(row);

    const capabilities = await opts.capabilities(dunningCase.provider);
    if (capabilities === undefined) return { kind: 'skipped' };

    const policy = forProvider(await opts.policy(dunningCase), capabilities);
    const decision = decide({ dunningCase, policy, now });

    const moved = decision.state !== dunningCase.state || decision.attempts !== dunningCase.attempts;
    const closed = decision.state !== 'open';

    await tx.query(
      `UPDATE billing.dunning_cases
          SET state = $3, attempts = $4, next_action_at = $5, closed_at = $6, updated_at = $7
        WHERE tenant_id = $1 AND id = $2`,
      [
        dunningCase.tenantId,
        dunningCase.id,
        decision.state,
        decision.attempts,
        decision.nextActionAt,
        closed ? now : null,
        now,
      ],
    );

    return {
      kind: 'advanced',
      moved,
      item: {
        caseId: dunningCase.id,
        settlementRef: dunningCase.settlementRef,
        state: decision.state,
        attempts: decision.attempts,
        nextActionAt: decision.nextActionAt,
        reason: decision.reason,
        actions: decision.actions,
      },
    };
  });
}
