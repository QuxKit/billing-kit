# Security policy

`@quxkit/billing-kit` handles money and usage records, so a defect here is a
financial defect. Reports are welcome and taken seriously.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (current) | yes |
| < 0.1 | no |

Only the latest minor receives fixes until 1.0. After 1.0, the current major and
the previous minor of the prior major will be supported.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

- **GitHub:** use "Report a vulnerability" under the Security tab of
  [QuxKit/billing-kit](https://github.com/QuxKit/billing-kit/security/advisories/new)
  (private security advisory).
- **Forge (internal):** open a confidential issue on the repo owner's forge, or
  contact the repo owner (`@brett`, see CODEOWNERS) directly.

Include: the version, a minimal reproduction, and what an attacker gains. You
will get an acknowledgement within 5 business days.

## Coordinated disclosure

We follow a 90-day coordinated disclosure window: from acknowledgement, we aim
to ship a fix and publish an advisory within 90 days, sooner for anything
actively exploitable. If a fix needs longer we will say so and agree a new date
with you. Credit is given in the advisory unless you prefer otherwise.

## Scope

**In scope**

- Anything that lets money be recorded, moved or reported incorrectly: ledger
  balance or append-only invariants, idempotency bypass, double charging,
  rounding or currency errors in `Money`/`Quantity`/`Rate`.
- Webhook signature verification for the shipped Stripe and Paddle providers.
- SQL injection or tenant isolation defects in the shipped SQL and queries.
- The CLI's migration applier (applying the wrong file, or a file twice).
- Denial of service through unbounded input the library accepts.

**Out of scope**

- The host application's authentication, authorisation and tenant resolution
  — billing-kit trusts the `tenantId` it is handed (see
  `docs/MULTI_TENANCY.md`).
- Vulnerabilities in the payment provider itself or in `pg`.
- Findings that require a compromised database or host.
- The `examples/` directory and test fixtures.
