// Build config.
//
// tsup (esbuild) and not `tsc`, for a reason that is structural rather than
// preference: this source cannot be emitted by `tsc` at all. Two of its import
// styles each independently defeat it.
//
//   - `src/metering/*` imports with explicit extensions (`from './driver.ts'`).
//     `tsc` accepts that only under `allowImportingTsExtensions`, which it
//     requires be paired with `noEmit` — the flag exists for typechecking a
//     bundler's input, not for producing output.
//   - Everything else imports extensionless (`from './money'`). Under
//     `moduleResolution: bundler` that resolves for the typechecker, but `tsc`
//     copies specifiers through verbatim, so the emitted ESM would contain
//     `from './money'` — which Node's ESM resolver rejects, as it does no
//     extension searching.
//
// esbuild resolves both forms and rewrites them to the real emitted file, so
// the two styles can coexist in src/ without anyone having to relitigate them.
//
// The entries are listed separately rather than globbed so that the
// entry points and the `exports` map in package.json fail loudly together: a
// renamed entry breaks the build instead of silently emitting one fewer file.
//
// Two configs, not one. The library ships ESM + CJS + declarations because a
// consumer's module system is theirs to choose; the CLI is run by node and has
// no consumer, so a CJS copy and a .d.ts of it would be dead weight in the
// tarball. `clean` therefore belongs to the first config only — set on both,
// the second would delete what the first just emitted.
import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  sourcemap: true,

  // No bundling across entry points. Each graph is its own, which is the whole
  // premise of shipping them as separate subpaths: importing `billing-kit` must
  // not pull the Stripe and Paddle adapters in with it.
  splitting: false,
  bundle: true,

  // The library has no runtime dependencies. `pg` is an optional peer: the CLI
  // loads it through a dynamic import and `src/pg.ts` takes a pool in, so it
  // must stay external in every entry.
  external: ['pg'],
  skipNodeModulesBundle: true,

  // Matches tsconfig's `target`. Set here too because esbuild does not read it
  // from tsconfig, and silently downlevelling further would be a size cost for
  // runtimes this package's `engines.node` already excludes.
  target: 'es2022',
  platform: 'node',

  // tsup 8 defaults this to `true` and rewrites `node:crypto` to `crypto` on the
  // way out. That is a downgrade we do not want: the prefix is what guarantees
  // the import cannot be intercepted by a userland package named `crypto` or
  // `os` in node_modules, and non-Node runtimes that expose only prefixed
  // builtins reject the bare form outright. The source writes `node:`; the
  // build has no business editing it.
  removeNodeProtocol: false,

  // ESM gets .mjs / CJS gets .cjs, unconditionally. `type: module` makes a bare
  // `.js` mean ESM, so a CJS file must be `.cjs` to be loadable at all; naming
  // both explicitly means the `exports` map never depends on `type` staying put.
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
};

export default defineConfig([
  {
    ...shared,
    entry: [
      'src/index.ts',
      'src/providers/index.ts',
      'src/metering/index.ts',
      'src/subscriptions/index.ts',
      'src/invoices/index.ts',
      'src/entitlements/index.ts',
      'src/pg.ts',
    ],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
  },
  {
    ...shared,
    // dist/cli.mjs, which is what `bin` points at. Named for the command rather
    // than for the file it is built from, because the path appears in npm's
    // shim and in every error a user pastes back.
    entry: { cli: 'cli/bin.ts' },
    format: ['esm'],
    dts: false,
    clean: false,

    // npm sets the executable bit on `bin` targets when it links them, but a
    // shebang is what makes the file runnable directly — from a checkout, from
    // a Docker layer that copies dist/, from anything that did not go through
    // npm's linker.
    banner: { js: '#!/usr/bin/env node' },
  },
]);
