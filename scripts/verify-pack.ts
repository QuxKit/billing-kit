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
  const out = run('npm', ['pack', '--pack-destination', packed, '--loglevel', 'error'], repo);
  tarball = path.join(packed, out.trim().split('\n').at(-1)!.trim());

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
  const installed = path.join(consumer, 'node_modules', 'billing-kit');
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
import { Money, Quantity, BillingError } from 'billing-kit';
import { createStripeProvider, createPaddleProvider } from 'billing-kit/providers';
import { drain, meterBatch } from 'billing-kit/metering';

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
const core = require.resolve('billing-kit/sql/001_core.sql');
assert.match(require('node:fs').readFileSync(core, 'utf8'), /create schema|CREATE SCHEMA/i);

// Encapsulation: the exports map must not leak internals.
assert.throws(() => require.resolve('billing-kit/src/money.ts'), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find/);

console.log('esm ok');
`,
  );
  assert.match(node(file), /esm ok/);
});

test('CJS: the root and both subpaths require and work', () => {
  // The condition the old package.json could not serve at all: it pointed
  // `.` at a .ts file, so `require('billing-kit')` had nothing to load.
  const file = path.join(consumer, 'use.cjs');
  writeFileSync(
    file,
    `
const assert = require('node:assert/strict');
const { Money, BillingError } = require('billing-kit');
const { createStripeProvider } = require('billing-kit/providers');
const { drain } = require('billing-kit/metering');

assert.equal(Money.fromMinor(500n, 'EUR').toString(), '5.00 EUR');
assert.equal(typeof BillingError, 'function');
assert.equal(typeof createStripeProvider, 'function');
assert.equal(typeof drain, 'function');

const sql = require('node:fs').readFileSync(require.resolve('billing-kit/sql/010_metering.sql'), 'utf8');
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
import { Money, Quantity, Rate, price } from 'billing-kit';
import type { MoneyJSON, PricedAmount, SqlExecutor } from 'billing-kit';
import { createStripeProvider } from 'billing-kit/providers';
import { drain } from 'billing-kit/metering';
import type { DrainReport } from 'billing-kit/metering';

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
import { Money } from 'billing-kit';
import type { MoneyJSON } from 'billing-kit';
import { createPaddleProvider } from 'billing-kit/providers';
import type { DrainOptions } from 'billing-kit/metering';

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
