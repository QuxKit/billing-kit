# Contributing

Thanks for looking. This is a small library with a large blast radius (it
records money), so the process below is strict about tests and deliberately
light on everything else.

## Dev setup

Node ≥ 20.19 and pnpm ≥ 9. A local Postgres (≥ 14; 16 in CI) with `psql` on
your PATH — the metering suite drives it through `psql` and needs to
`CREATE DATABASE`.

```
pnpm install
createdb billing_kit_test          # the DB-backed suites rebuild the schema in it
pnpm test                          # builds, then runs every suite
```

Point the tests elsewhere with `BILLING_KIT_TEST_DATABASE_URL` (the metering
harness derives `PGHOST`/`PGUSER`/... from it for `psql`) and the CLI tests'
maintenance connection with `BILLING_KIT_CLI_TEST_ADMIN_URL`. Without a
database the DB-backed suites skip with a reason; set `REQUIRE_DB=1` (CI does)
to make that a failure instead.

## Scripts

| Script | What |
|---|---|
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | tsup → `dist/` (ESM + CJS + d.ts) |
| `pnpm test` | build, then every test file (unit, adversarial, providers, metering) |
| `pnpm run test:coverage` | the same under c8; thresholds in `.c8rc.json` are a ratchet — raise them, never lower them |
| `pnpm run test:unit` / `test:adversarial` / `test:providers` / `test:metering` | one group |
| `pnpm run test:pack` | `npm pack`, install the tarball into a clean dir, import it from ESM and CJS with plain node |

## Workflow: issue → branch → PR

Every change, however small, gets an issue and a pull request. Nothing lands
directly on `main`.

1. Open an issue describing the problem (not the solution).
2. Branch from `main`: `<type>/<issue>-<short-slug>` — e.g. `fix/42-sweep-lease`.
3. Commit in logical steps with Conventional Commit subjects
   (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `ci:`, `style:`).
   A behavioural fix ships with a test that fails before and passes after.
   Formatting-only changes go in their own `style:` commit.
4. **Before pushing:** `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
   must be green with the real database.
5. Open the PR with `Closes #<issue>` first in the body, and say what changed
   and what tests were added. CI runs on both forges.

## Rules the code follows

- No runtime dependencies. `pg` is an optional peer, touched only by
  `@quxkit/billing-kit/pg` and the CLI.
- No `process.env` reads inside `src/`; no global singletons.
- Errors are `BillingError` with a code from the union in `src/errors.ts`;
  every code in the union must be raised somewhere, and every new code goes in
  the README's Errors table.
- Money never passes through a JS `number`.
- Public API changes are additive; document them in `CHANGELOG.md` under
  `[Unreleased]`.
- Diagrams in READMEs are ASCII; mermaid lives in `docs/DIAGRAMS.md`.

## Releasing (maintainers)

Bump `version` in `package.json`, move `[Unreleased]` in `CHANGELOG.md` under
the new version, merge, then `git tag vX.Y.Z && git push --tags`. The release
workflow verifies, checks the tag matches, and publishes with provenance.
