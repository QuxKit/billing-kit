#!/usr/bin/env node
// The launcher. Plain JavaScript, and the only file in the repository that is.
//
// The package ships TypeScript source — `exports` points at `src/*.ts` and
// there is no build step — which is fine for a library, because whatever
// compiles the adopter's code compiles ours too. A `bin` has no such helper:
// npm writes a shim that runs `node <this file>`, so this file has to be
// something node runs unaided.
//
// Node ≥22.18 strips types from `.ts` by default; 22.6–22.17 need
// `--experimental-strip-types`, and there is no way to turn it on from inside
// the process that needs it. So: check, and re-exec once if it is off. The
// sentinel env var is what stops that from being a fork bomb on a node old
// enough to lack `process.features.typescript` (added in 22.10) — without it,
// a version that supports the flag but does not report the feature would
// re-exec itself forever.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REEXEC = 'BILLING_KIT_CLI_STRIP_TYPES';

if (!process.features.typescript && process.env[REEXEC] !== '1') {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [REEXEC]: '1' } },
  );
  process.exit(result.status ?? 1);
}

const { run } = await import(new URL('../cli/main.ts', import.meta.url).href);
process.exitCode = await run(process.argv.slice(2));
