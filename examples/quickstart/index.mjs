// Quickstart: the smallest end-to-end billing-kit program.
//
//   1. wrap a pg.Pool in the shipped executor
//   2. apply sql/001_core.sql (idempotent) and create partitions
//   3. record two usage events (the second is a retry of the first)
//   4. post a payment to the ledger and read the balance back
//
// Run with DATABASE_URL pointing at a database you can create tables in. The
// program is safe to re-run: every write is idempotent on a key you can see.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createBilling, Money, paymentPosting, Quantity } from '@quxkit/billing-kit';
import { pgExecutor } from '@quxkit/billing-kit/pg';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/billing_kit_quickstart';
const pool = new pg.Pool({ connectionString: url, max: 4 });
const db = pgExecutor(pool);

// The SQL ships in the package; resolve it through the exports map rather than
// a relative path, which is how a consumer finds it too.
const require = createRequire(import.meta.url);
const ddl = await readFile(require.resolve('@quxkit/billing-kit/sql/001_core.sql'), 'utf8');
await db.query(ddl);
await db.query('SELECT billing.ensure_core_partitions(2)');

const billing = createBilling({ db });
const tenantId = 'acme';
const subjectId = 'user_123';

// A retry is the SAME event: same external id, same quantity, same occurredAt.
// A retry that differs in any of those is refused with idempotency_conflict
// rather than deduplicated — try changing the quantity below and re-running.
const event = {
  tenantId,
  subjectId,
  source: 'api',
  externalId: 'req-0001', // yours: the request id, so a retry carries the same one
  metric: 'tokens.input',
  quantity: Quantity.fromBigInt(1234n),
  occurredAt: new Date('2026-08-17T12:00:00Z'),
};
const first = await billing.record(event);
const retry = await billing.record(event);
console.log('recorded', first.eventId, 'deduplicated on retry:', retry.deduplicated);

// A verified payment of 19.99 USD. Idempotent on the payment id.
const posted = await billing.post(
  paymentPosting({
    tenantId,
    subjectId,
    paymentId: 'pay_quickstart_1',
    amount: Money.fromDecimalString('19.99', 'USD'),
    occurredAt: new Date(),
  }),
);
console.log('posted transaction', posted.transactionId, 'replay:', posted.deduplicated);

const bal = await billing.balance({ tenantId, subjectId, account: 'customer_balance', currency: 'USD' });
console.log('customer_balance:', bal.toString(), '(negative = the customer is in credit)');

await pool.end();
