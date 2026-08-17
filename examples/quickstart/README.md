# billing-kit quickstart

The smallest end-to-end program: apply the core SQL, record a usage event (and
its retry), post a payment to the ledger, read the balance back — through the
shipped `pg` adapter.

```
createdb billing_kit_quickstart          # any database you can create tables in
cd examples/quickstart
pnpm install --ignore-workspace          # links ../.. as @quxkit/billing-kit
pnpm --dir ../.. build                   # the link resolves to dist/, so build it once
DATABASE_URL=postgres://localhost:5432/billing_kit_quickstart pnpm start
```

Expected output (ids will differ):

```
recorded 5f1e... deduplicated on retry: true
posted transaction 9c3a... replay: false
customer_balance: -19.99 USD (negative = the customer is in credit)
```

Run it again and the payment reports `replay: true` and the balance is
unchanged: every write is idempotent on a key you supplied.
