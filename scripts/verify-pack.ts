// Does the published tarball actually work?
//
// Every other check in this repo runs against src/ with a TypeScript loader
// already in the process. That configuration is not one any consumer has, and
// it cannot observe the failures that packaging actually produces: an `exports`
// key that points at a file `files` does not ship, a `require` branch that was
// never emitted, types that resolve for `import` and not for `require`. All of
// those typecheck clean and test clean and are broken on npm.
//
// So this does the only thing that answers the question: `npm pack`, install
// the tarball into a directory that has no relationship to this repo, and use
// it the way a consumer would. Nothing here imports from src/ — if it did, it
// would be testing the repo again instead of the artifact.
//
// Deliberately NOT in test/: the `test` script globs `test/*.test.ts`, and a
// full pack-and-install has no business running on every unit test invocation.
// Run it with `pnpm test:pack`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The repo's own TypeScript, by absolute path. The consumer directory gets no
// devDependencies of its own — installing a second typescript there would take
// a network round trip to prove nothing, since the version that matters is the
// one whose output we are shipping.
const tsc = path.join(repo, 'node_modules', '.bin', 'tsc');

let consumer: string;
let tarball: string;

/** Inherit stdio on failure only: a passing step should be quiet. */
function run(command: string, args: readonly string[], cwd: string): string {
  try {
    return execFileSync(command, args as string[], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n--- stdout ---\n${e.stdout ?? ''}\n--- stderr ---\n${e.stderr ?? ''}`,
    );
  }
}

/** Run a consumer file with plain `node` — no loader, no tsx, no conditions we set. */
function node(file: string): string {
  return run(process.execPath, [file], consumer);
}

before(() => {
  consumer = mkdtempSync(path.join(tmpdir(), 'billing-kit-consumer-'));

  // Build first. Packing a stale dist/ would let this suite pass against an
  // artifact that no longer corresponds to src/.
  run('pnpm', ['run', 'build'], repo);

  const packed = mkdtempSync(path.join(tmpdir(), 'billing-kit-tarball-'));
  run('npm', ['pack', '--pack-destination', packed, '--loglevel', 'error'], repo);
  // Read the actual tarball from the pack destination rather than parsing
  // `npm pack`'s stdout — its output format is not stable across npm versions,
  // and the scoped name (`@quxkit/billing-kit` -> `quxkit-billing-kit-*.tgz`)
  // is exactly the kind of thing that breaks a filename guessed from stdout.
  const produced = readdirSync(packed).find((f) => f.endsWith('.tgz'));
  if (!produced) throw new Error(`npm pack produced no .tgz in ${packed}`);
  tarball = path.join(packed, produced);

  // A consumer package that is not a workspace member and shares no
  // node_modules with the repo. `private` so a stray publish is impossible.
  writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true, type: 'module' }, null, 2),
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error', tarball], consumer);
});

after(() => {
  // BILLING_KIT_KEEP_TMP leaves the consumer directory behind for inspection
  // when this suite fails and the reason is not obvious from the assertion.
  if (process.env.BILLING_KIT_KEEP_TMP) {
    console.log(`consumer directory kept at ${consumer}`);
    return;
  }
  rmSync(consumer, { recursive: true, force: true });
  rmSync(path.dirname(tarball), { recursive: true, force: true });
});

test('the tarball contains the built artifacts and none of the source', () => {
  const listing = run('tar', ['-tzf', tarball], repo)
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ''));

  for (const required of [
    'dist/index.mjs',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/index.d.cts',
    'dist/providers/index.mjs',
    'dist/providers/index.cjs',
    'dist/metering/index.mjs',
    'dist/metering/index.cjs',
    'sql/001_core.sql',
    'LICENSE',
    'NOTICE',
    'README.md',
  ]) {
    assert.ok(listing.includes(required), `tarball is missing ${required}`);
  }

  // The point of the build. If a .ts file ships, something has re-added src/ to
  // `files` and consumers are back to needing a TypeScript toolchain.
  const ts = listing.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.d.cts'));
  assert.deepEqual(ts, [], `tarball ships raw TypeScript: ${ts.join(', ')}`);
});

test('every path named in the exports map exists in the installed package', () => {
  const installed = path.join(consumer, 'node_modules', '@quxkit', 'billing-kit');
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };

  // Walks the nested condition objects, so a broken path under `types.require`
  // is caught here rather than as a confusing tsc error later.
  const targets: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      if (!node.includes('*')) targets.push(node);
      return;
    }
    if (node && typeof node === 'object') Object.values(node).forEach(collect);
  };
  collect(manifest.exports);

  assert.ok(targets.length >= 12, `expected the three entry points to yield 12+ targets, got ${targets.length}`);
  for (const target of targets) {
    assert.ok(
      readdirSync(path.dirname(path.join(installed, target))).includes(path.basename(target)),
      `exports points at ${target}, which is not in the package`,
    );
  }
});

test('ESM: the root and both subpaths import and work', () => {
  const file = path.join(consumer, 'use.mjs');
  writeFileSync(
    file,
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Money, Quantity, BillingError } from '@quxkit/billing-kit';
import { createStripeProvider, createPaddleProvider } from '@quxkit/billing-kit/providers';
import { drain, meterBatch } from '@quxkit/billing-kit/metering';

// Not just a truthy import check — the value has to behave. A build that
// emitted an empty module would satisfy 'typeof === function' and nothing else.
const total = Money.fromMinor(1999n, 'USD');
assert.equal(total.toString(), '19.99 USD');
assert.equal(typeof Quantity.fromBigInt(5n).toString(), 'string');
assert.equal(typeof BillingError, 'function');

for (const fn of [createStripeProvider, createPaddleProvider, drain, meterBatch]) {
  assert.equal(typeof fn, 'function');
}

// The ./sql/* subpath, resolved by Node rather than by joining paths ourselves.
const require = createRequire(import.meta.url);
const core = require.resolve('@quxkit/billing-kit/sql/001_core.sql');
assert.match(require('node:fs').readFileSync(core, 'utf8'), /create schema|CREATE SCHEMA/i);

// Encapsulation: the exports map must not leak internals.
assert.throws(() => require.resolve('@quxkit/billing-kit/src/money.ts'), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find/);

console.log('esm ok');
`,
  );
  assert.match(node(file), /esm ok/);
});

test('CJS: the root and both subpaths require and work', () => {
  // The condition the old package.json could not serve at all: it pointed
  // `.` at a .ts file, so `require('@quxkit/billing-kit')` had nothing to load.
  const file = path.join(consumer, 'use.cjs');
  writeFileSync(
    file,
    `
const assert = require('node:assert/strict');
const { Money, BillingError } = require('@quxkit/billing-kit');
const { createStripeProvider } = require('@quxkit/billing-kit/providers');
const { drain } = require('@quxkit/billing-kit/metering');

assert.equal(Money.fromMinor(500n, 'EUR').toString(), '5.00 EUR');
assert.equal(typeof BillingError, 'function');
assert.equal(typeof createStripeProvider, 'function');
assert.equal(typeof drain, 'function');

const sql = require('node:fs').readFileSync(require.resolve('@quxkit/billing-kit/sql/010_metering.sql'), 'utf8');
assert.ok(sql.length > 0);

console.log('cjs ok');
`,
  );
  assert.match(node(file), /cjs ok/);
});

test('types resolve under module: node16, for both import and require', () => {
  // node16 is the strict setting: it honours the `exports` map and the
  // import/require split inside the `types` condition. `moduleResolution:
  // bundler` would resolve almost anything and prove nothing about Node.
  const dir = path.join(consumer, 'typecheck');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'node16',
          moduleResolution: 'node16',
          target: 'ES2022',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ['consumer.mts', 'consumer.cts'],
      },
      null,
      2,
    ),
  );

  // .mts and .cts, so one tsc run covers both branches of the types condition.
  // Types are asserted by use, not by `import type` alone: the annotations here
  // fail to compile if the .d.ts shipped `any` where it should have shipped
  // Money, which an unused import would not catch.
  // `IsAny` is the guard that matters. If a `types` path were wrong in a way
  // tsc tolerated, the import would degrade to `any` and every annotation below
  // would still pass. This makes that degradation a compile error.
  const preamble = `
type IsAny<T> = 0 extends 1 & T ? true : false;
`;

  writeFileSync(
    path.join(dir, 'consumer.mts'),
    `${preamble}
import { Money, Quantity, Rate, price } from '@quxkit/billing-kit';
import type { MoneyJSON, PricedAmount, SqlExecutor } from '@quxkit/billing-kit';
import { createStripeProvider } from '@quxkit/billing-kit/providers';
import { drain } from '@quxkit/billing-kit/metering';
import type { DrainReport } from '@quxkit/billing-kit/metering';

const amount: Money = Money.fromMinor(1n, 'USD');
const json: MoneyJSON = amount.toJSON();
const priced: PricedAmount = price(Quantity.fromBigInt(2n), Rate.fromDecimalString('1.5'), 'USD');

declare const db: SqlExecutor;
const report: Promise<DrainReport> = drain({ db });

const stripeIsTyped: IsAny<typeof createStripeProvider> = false;
const moneyIsTyped: IsAny<typeof Money> = false;

export { json, priced, report, stripeIsTyped, moneyIsTyped };
`,
  );

  writeFileSync(
    path.join(dir, 'consumer.cts'),
    `${preamble}
import { Money } from '@quxkit/billing-kit';
import type { MoneyJSON } from '@quxkit/billing-kit';
import { createPaddleProvider } from '@quxkit/billing-kit/providers';
import type { DrainOptions } from '@quxkit/billing-kit/metering';

const amount: Money = Money.fromMinor(250n, 'GBP');
const json: MoneyJSON = amount.toJSON();
const paddle = createPaddleProvider({ apiKey: 'k', webhookSecret: 's' });

const paddleIsTyped: IsAny<typeof createPaddleProvider> = false;
export type Opts = DrainOptions;
export { json, paddle, paddleIsTyped };
`,
  );

  run(tsc, ['--project', path.join(dir, 'tsconfig.json')], dir);
});

/**
 * The `bin`, run the way npm runs it.
 *
 * The check the CLI most needs, and the one nothing else here stands in for.
 * `exports` governs `import`; `bin` does not go through it at all — npm links
 * the target and executes it under plain `node`. A CLI that only starts under
 * `tsx`, or whose entry is not linked, or that is missing its shebang, fails
 * here and nowhere else.
 *
 * `init` runs in the consumer directory, which is `type: module`; then `status`
 * against a port nothing listens on. Refusing to connect is the expected end.
 * What is under test is that the program starts, finds its own packaged `sql/`,
 * reads back the config it just wrote, and exits 1 with a sentence.
 */
test('the bin is linked, starts under plain node, and reads back what init wrote', () => {
  const bin = path.join(consumer, 'node_modules', '.bin', 'billing-kit');

  assert.match(run(bin, ['--version'], consumer), /^billing-kit \d+\.\d+\.\d+/);

  const init = run(bin, ['init'], consumer);
  // `type: module` here, so a `.js` config is ESM and is the right choice.
  assert.match(init, /billing\.config\.js\b/);
  assert.match(readFileSync(path.join(consumer, 'billing.config.js'), 'utf8'), /export default/);

  // Two states, and the first is the one a new adopter is actually in. `pg` is
  // an OPTIONAL peer, so `npm install billing-kit` does not bring it — this
  // consumer has no driver, which is exactly the shape of the first `status`
  // anyone runs.
  const noDriver = statusAgainstNothing(bin);
  assert.equal(noDriver.status, 1, `expected a refusal, got:\n${noDriver.stdout}${noDriver.stderr}`);
  assert.match(noDriver.stderr, /cannot load `pg`/);
  assert.match(noDriver.stderr, /optional peer dependency/);
  assert.match(noDriver.stderr, /npm install pg/, 'the refusal has to name the fix');
  assert.doesNotMatch(
    noDriver.stderr,
    /ERR_MODULE_NOT_FOUND|Cannot find package/,
    'a missing optional peer should be a sentence, not a resolution error',
  );

  // Then the driver is installed and the same command gets as far as the
  // network. That is the boundary worth proving: everything before it —
  // linking, the shebang, config resolution, packaged sql/ — is ours.
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error', 'pg'], consumer);

  const withDriver = statusAgainstNothing(bin);
  assert.equal(withDriver.status, 1, `expected a refusal, got:\n${withDriver.stdout}${withDriver.stderr}`);
  assert.match(withDriver.stderr, /cannot connect/, 'the failure should be a sentence, not a stack');
  assert.doesNotMatch(
    withDriver.stderr,
    /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/,
  );

  // Not asserted here: that the default migrations directory is the packaged
  // one. `status` prints that header only after it connects, and this suite has
  // no database — asserting it would mean either a Postgres dependency in the
  // packaging check or a weaker assertion dressed up as a strong one. It is
  // covered where a database already exists: test/cli.test.ts drives the same
  // resolution against a real server, and the ESM/CJS cases above resolve
  // `billing-kit/sql/001_core.sql` through the exports map from this install.
});

/**
 * `status` against a port nothing listens on.
 *
 * Not `run`, because this is expected to exit non-zero and the output is the
 * assertion; `run` throws away the distinction between a refusal and a crash.
 */
function statusAgainstNothing(bin: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(bin, ['status', '--database-url', 'postgres://127.0.0.1:1/nothing'], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
