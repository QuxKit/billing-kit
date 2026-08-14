// The executable. Built to `dist/cli.mjs` and named by `bin` in package.json.
//
// Separate from main.ts so that `run` stays an ordinary exported function —
// importing main.ts to call it must not also execute a command. This file is
// the only place argv and the exit code are touched.
//
// It is built, not shipped as source. A bin runs under `node <file>` with no
// loader, no tsconfig and no bundler, so a shim that imported a `.ts` module
// would work only on the narrow band of Node versions that strip types, which
// is the failure the packaging work removed from the library's `exports`. The
// shebang comes from tsup's banner.

import { run } from './main.ts';

process.exitCode = await run(process.argv.slice(2));
