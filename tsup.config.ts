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
// The three entries are listed separately rather than globbed so that the
// entry points and the `exports` map in package.json fail loudly together: a
// renamed entry breaks the build instead of silently emitting one fewer file.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/providers/index.ts', 'src/metering/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,

  // No bundling across entry points. Each of the three is its own graph, which
  // is the whole premise of shipping them as separate subpaths: importing
  // `billing-kit` must not pull the Stripe and Paddle adapters in with it.
  splitting: false,
  bundle: true,

  // The library has no runtime dependencies; `pg` is a devDependency used only
  // by the tests. Nothing should be inlined from node_modules — if a bundle
  // ever grows one, that is a dependency that belongs in `dependencies`.
  external: [],
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
});
