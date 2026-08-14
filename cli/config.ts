// billing.config — read by the CLI, by nothing else, ever.
//
// The library takes its configuration as arguments and reads neither a config
// file nor `process.env` (src/index.ts, ARCHITECTURE.md §7.1 rule 2). That line
// is why this file lives in `cli/` and not in `src/`: the boundary is a
// directory, so crossing it is visible in a diff rather than a matter of
// remembering. Nothing under `src/` imports anything from here, and no entry in
// the package's `exports` map reaches this directory.
//
// The config file itself may read `process.env` freely — it is the adopter's
// own module, evaluated once, by a command they typed.

import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CliError } from './errors.ts';

/** Discovery order. `.ts` first because a TS project that has both means the `.js` is build output. */
const CANDIDATES = ['billing.config.ts', 'billing.config.mts', 'billing.config.js', 'billing.config.mjs'];

const KNOWN_KEYS = ['databaseUrl', 'migrations', 'schema', 'provider'] as const;

export interface BillingConfig {
  databaseUrl?: string;
  /** Directory of numbered .sql files, resolved relative to the config file. */
  migrations?: string;
  schema?: string;
  provider?: string;
}

export interface LoadedConfig {
  config: BillingConfig;
  /** Null when no config file was found and none was demanded. */
  path: string | null;
}

// --- the template -----------------------------------------------------------

const TEMPLATE = `// billing-kit — CLI configuration.
//
// Read by \`npx billing-kit\` and by nothing else. The library takes its
// configuration as arguments: it never reads this file and never reads
// process.env, because a library that reads the environment cannot be
// instantiated twice in one process, which is what a test suite and a
// multi-region worker both need. Reading process.env HERE is fine — this is
// your module, evaluated once, by a command you typed.
//
// Nothing writes this file after \`billing-kit init\`, and \`init\` runs only when
// you invoke it. There is no install hook.

export default {
  // Where \`billing-kit migrate\` and \`billing-kit status\` connect.
  // \`--database-url <url>\` overrides it for one invocation.
  //
  // Left as an env read so the URL is not a credential in your repository.
  databaseUrl: process.env.DATABASE_URL,

  // The directory of numbered .sql files, resolved relative to THIS file.
  // Defaults to the sql/ directory inside the installed billing-kit package,
  // which is the copy that matches the version you have. Override it only if
  // you vendored the files or added your own alongside them.
  //
  // migrations: './node_modules/billing-kit/sql',

  // The Postgres schema. It is 'billing' and it is not configurable: every file
  // in sql/ writes the name literally, so a different value here would produce
  // a tracking table in one schema and tables in another. The key exists so the
  // question is answered here instead of by grepping the DDL, and the CLI
  // refuses any other value rather than half-honouring it.
  schema: 'billing',

  // Which provider this project settles through. Commented out because nothing
  // reads it: the runtime takes a BillingProvider as an argument, and the CLI
  // has no command that needs one yet. Uncomment it when you want the decision
  // recorded next to the database it applies to — the CLI will accept it and
  // ignore it.
  //
  // provider: 'stripe',   // 'stripe' | 'paddle'
};
`;

// --- init -------------------------------------------------------------------

export interface InitResult {
  path: string;
  contents: string;
}

/**
 * TypeScript unless there is evidence otherwise.
 *
 * `tsconfig.json` is the strong signal. A `typescript` dependency is the weaker
 * one and is checked second, because a JS project with a TS-typed test runner
 * has it too — but a config file in TS that a JS project cannot load is a worse
 * outcome than the reverse, so the tie goes to `.js`.
 */
export async function detectTypeScript(cwd: string): Promise<boolean> {
  if (await exists(path.join(cwd, 'tsconfig.json'))) return true;
  const pkg = await readPackageJson(cwd);
  return Boolean(pkg?.dependencies?.typescript ?? pkg?.devDependencies?.typescript);
}

interface PackageJson {
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Which extension the template can actually be imported back through.
 *
 * The template is ESM — it ends in `export default`, because that is what
 * `loadConfig` imports and what lets `databaseUrl` be an env read rather than a
 * committed credential. Whether a `.js` file is ESM is not a property of the
 * file: it is `"type"` in the nearest package.json, and the default is
 * `commonjs`. So `.js` in an ordinary project is parsed as CommonJS and dies on
 * the word `export` — `init` succeeds and every command after it fails, which
 * is exactly the trap this function exists to avoid.
 *
 * `.mjs` is ESM unconditionally, so it is the safe answer whenever `"type":
 * "module"` is not set. `.ts` needs one more thing: the CLI is built JavaScript
 * run by `node` with no loader, so it can only import a `.ts` config on a
 * runtime that strips types.
 */
export async function configExtension(cwd: string): Promise<'.ts' | '.js' | '.mjs'> {
  if ((await detectTypeScript(cwd)) && process.features.typescript) return '.ts';
  return (await readPackageJson(cwd))?.type === 'module' ? '.js' : '.mjs';
}

/**
 * Write the template, once.
 *
 * An existing config is never overwritten and never merged into. It holds a
 * database URL and possibly a hand-edited migrations path; replacing it with a
 * template is a data loss that looks like a successful command.
 */
export async function writeInitConfig(cwd: string): Promise<InitResult> {
  const filename = `billing.config${await configExtension(cwd)}`;
  const target = path.join(cwd, filename);

  for (const candidate of CANDIDATES) {
    const existing = path.join(cwd, candidate);
    if (await exists(existing)) {
      throw new CliError(`${candidate} already exists`, [
        `at ${existing}`,
        '',
        'Nothing was written. Delete or rename it first if you want a fresh template.',
      ]);
    }
  }

  await writeFile(target, TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  return { path: target, contents: TEMPLATE };
}

// --- load -------------------------------------------------------------------

/**
 * Import the config module.
 *
 * A module and not JSON, so `databaseUrl` can be an env read rather than a
 * credential committed to a repository. The cost is that loading it runs the
 * adopter's code — acceptable for a file that sits in their own project root
 * and is loaded by a command they typed, and unacceptable for anything the
 * library does at runtime, which is why the library does not do it.
 */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<LoadedConfig> {
  let resolved: string | null = null;

  if (explicitPath) {
    resolved = path.resolve(cwd, explicitPath);
    if (!(await exists(resolved))) throw new CliError(`no config file at ${resolved}`);
  } else {
    for (const candidate of CANDIDATES) {
      const full = path.join(cwd, candidate);
      if (await exists(full)) {
        resolved = full;
        break;
      }
    }
  }

  if (!resolved) return { config: {}, path: null };

  // A `.ts` config is the adopter's own code and is loaded with a plain dynamic
  // import, so it needs a runtime that strips types: Node ≥22.18 by default,
  // 22.6–22.17 under `--experimental-strip-types`. The CLI cannot turn that on
  // for itself, and the failure without this check is a SyntaxError pointing at
  // a type annotation in a file the user believes is valid — true, and useless.
  if (/\.m?ts$/.test(resolved) && !process.features.typescript) {
    throw new CliError(`cannot load ${path.basename(resolved)} on ${process.version}`, [
      'This node does not strip types, so a TypeScript config file cannot be imported.',
      '',
      'Any one of these:',
      '  • rename it to billing.config.js and use `export default` — the file is',
      '    plain data, so nothing is lost',
      '  • run with --experimental-strip-types (node 22.6 and later)',
      '  • upgrade to node 22.18 or later, where stripping is on by default',
    ]);
  }

  let module: unknown;
  try {
    module = await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new CliError(`cannot load ${resolved}`, [error instanceof Error ? error.message : String(error)]);
  }

  const value = (module as { default?: unknown }).default;
  if (value === undefined) {
    throw new CliError(`${resolved} has no default export`, [
      'The template exports a plain object: `export default { databaseUrl: ... }`.',
    ]);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`${resolved} must default-export an object`);
  }

  // Unknown keys are refused rather than ignored. `databaseURL` for
  // `databaseUrl` is a one-character mistake whose only symptom would be the
  // CLI asking for a database URL that is visibly right there in the file.
  const unknown = Object.keys(value).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new CliError(`${resolved} has unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, [
      `Known keys: ${KNOWN_KEYS.join(', ')}.`,
    ]);
  }

  return { config: value as BillingConfig, path: resolved };
}

// --- resolution -------------------------------------------------------------

export interface Settings {
  databaseUrl: string;
  migrationsDir: string;
  configPath: string | null;
}

export interface Overrides {
  databaseUrl?: string;
  migrations?: string;
}

/** `sql/` inside this installation. The copy that matches this version. */
export const packagedMigrations = (): string => fileURLToPath(new URL('../sql', import.meta.url));

/**
 * Flags beat the config file; there is no third source.
 *
 * In particular the CLI does not read `DATABASE_URL` itself. The template does,
 * on the adopter's behalf, in a file they can see — an implicit env read here
 * would mean `billing-kit migrate` in a shell with a stale export silently
 * migrating the wrong database, and the output would not say which.
 */
export function resolveSettings(loaded: LoadedConfig, overrides: Overrides, cwd: string): Settings {
  const { config, path: configPath } = loaded;

  if (config.schema !== undefined && config.schema !== 'billing') {
    throw new CliError(`schema must be 'billing', not ${JSON.stringify(config.schema)}`, [
      'Every file in sql/ writes the schema name literally, so honouring this key',
      'would put the tracking table in one schema and the tables in another.',
      "Remove the key or set it to 'billing'.",
    ]);
  }

  const databaseUrl = overrides.databaseUrl ?? config.databaseUrl;
  if (!databaseUrl) {
    throw new CliError('no database url', [
      configPath
        ? `${configPath} does not set \`databaseUrl\` (is DATABASE_URL exported?).`
        : 'No billing.config.{ts,js} found — run `billing-kit init` to write one.',
      '',
      'Or pass one for this invocation: --database-url postgres://…',
    ]);
  }

  // A config-file path is relative to the config file, a flag is relative to
  // the shell. Both are what the person writing them means by "here".
  const migrations = overrides.migrations
    ? path.resolve(cwd, overrides.migrations)
    : config.migrations
      ? path.resolve(configPath ? path.dirname(configPath) : cwd, config.migrations)
      : packagedMigrations();

  return { databaseUrl, migrationsDir: migrations, configPath };
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );
