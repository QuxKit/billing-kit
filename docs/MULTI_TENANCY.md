# Multi-tenancy: what billing-kit assumes, and how to make it true

Every ingest row in this library carries a `tenantId`. It is on the first
usage event in the README, inside the idempotency key, on every subscription
and ledger row. This doc says out loud what the rest of the documentation
assumes about it — and points at the sibling library whose job is making the
assumption hold.

## The assumption

**`tenantId` is established upstream, never taken from the request.**

billing-kit treats the tenant id the way it treats `SubjectId`: an opaque
string whose meaning the caller owns. The library scopes queries by it,
partitions dedupe by it, and never verifies it — it *cannot* verify it,
because it deliberately has no idea what a tenant is. A `tenantId` copied
from a request body or an unauthenticated header into `record()` is the same
bug the `SubjectId` docs warn about for provider customer ids — the caller
names someone else's account and the system obliges — reproduced one field
over, with a ledger attached.

So the contract at this seam is one sentence: **by the time a value reaches
billing-kit as a `tenantId`, something has already checked that the caller
belongs to that tenant.**

## The family's answer: tenant-kit

[tenant-kit](http://localhost:3003/brett/tenant-kit) is that something — the
sibling library that owns what this one abstains from: a tenant directory
(slugs, names, archive-not-delete), memberships and roles, request→tenant
resolution split into untrusted extraction and store-backed authorization,
an ambient tenant context, and database-enforced isolation via forced
row-level security.

The integration is two shared shapes, not an import:

- **`TenantId` is the same opaque `text`** in both vocabularies and both
  schemas. A tenant resolved there is a `tenantId` here, no casts.
- **`SqlExecutor` is structurally identical** in both libraries. One
  `pg.Pool` adapter (~10 lines) serves both; `tenancy.*` and `billing.*`
  live in one database under one transaction discipline.

Wired together, the request path reads:

```ts
const resolved = await tenancy.resolve(req, { userId, extract }); // membership checked
tenancy.run(resolved, async () => {
  await billing.record({
    tenantId: tenancy.require().tenantId,  // resolved, not request-supplied
    subjectId: userId,
    source: 'api',
    externalId: req.id,
    metric: 'tokens.input',
    quantity: Quantity.fromBigInt(n),
    occurredAt: new Date(),
  });
});
```

The full walk-through — including protecting `billing.*` tables with
tenant-kit's row-level security, and the whale-tenant-on-its-own-database
pattern both kits support through the shared executor — lives in
[tenant-kit's docs/BILLING_KIT.md](http://localhost:3003/brett/tenant-kit/src/branch/main/docs/BILLING_KIT.md).

## One caution that belongs on this side of the seam

billing-kit's cross-tenant machinery — the metering drain, the subscription
due-sweep — iterates all tenants by design. If you scope executors per
tenant (row-level security or routing), those workers must run on an
**unscoped** executor. A due-sweep on a tenant-scoped executor does not
fail; it quietly charges one tenant and skips the rest, which is revenue
silently not collected. Request-path billing calls take the scoped executor;
worker-path calls take the unscoped one. Hold that line in review — the
executor variable's name is the audit trail.

## Why billing-kit will not grow this itself

The same reason it will not grow a payment provider: the tenant boundary is
a place where being *a library you embed* only works if each library owns
one thing. Tenancy needs its own directory, its own invariants (a tenant
always has an owner; archived tenants keep resolving in the ledger), and its
own security argument (extraction vs authorization). Folding that in here
would make every billing adopter carry an org model they may already have —
exactly what this library exists to not do to people. The seam stays; the
sibling owns the other side.
