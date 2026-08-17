// `npx billing-kit <command>` — the part of billing-kit that is a program.
//
// It exists for one reason: the library ships five SQL files that have to be
// applied in order, and until now the documented procedure was five psql
// invocations a human types correctly every time, including after every upgrade.
// That is the largest piece of onboarding friction in the project and it is not
// a friction the adopter can be expected to absorb.
//
// Three commands, no daemon, no install hook. `init` writes a config file only
// when it is invoked; there is no `postinstall` in package.json and there must
// not be one — a package that writes into a project directory during
// `npm install` is a package that has to be trusted rather than read.
//
// Nothing under `src/` imports this file, and the package's `exports` map does
// not reach `cli/`. The library's rule that configuration is an argument
// (ARCHITECTURE.md §7.1 rule 2) is unaffected by anything in this directory.

import { parseArgs } from 'node:util';

import { loadConfig, resolveSettings, type Settings, writeInitConfig } from './config.ts';
import { type Connection, connect, redact } from './db.ts';
import { CliError } from './errors.ts';
import {
  applyMigration,
  ensureLedger,
  ledgerExists,
  type MigrationFile,
  type PlanEntry,
  plan,
  readApplied,
  readMigrations,
  releaseLock,
  TABLE,
  takeLock,
} from './migrations.ts';

const USAGE = `billing-kit — usage-based billing as a library, over a provider you choose.

Usage: billing-kit <command> [options]

Commands:
  init            write billing.config.{ts,mjs,js} in the current directory
  migrate         apply pending SQL migrations, in order, once each
  status          show which migrations are applied and which are pending

Options:
  --config <path>         config file (default: ./billing.config.{ts,mts,js,mjs})
  --database-url <url>    overrides the config's databaseUrl
  --migrations <dir>      overrides the migrations directory
  --dry-run               migrate only: print the plan, change nothing
  -h, --help
  -V, --version

The database url is taken from the config file, or from --database-url. It is
deliberately NOT read from DATABASE_URL by this tool: the config file reads the
environment on your behalf, in a file you can see.
`;

// --- entry ------------------------------------------------------------------

export async function run(argv: readonly string[]): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    process.stderr.write(`billing-kit: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  if (values.version) {
    process.stdout.write(`${await version()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  if (positionals.length > 1) {
    process.stderr.write(`billing-kit: unexpected argument ${JSON.stringify(positionals[1])}\n`);
    return 2;
  }

  const command = positionals[0];
  try {
    switch (command) {
      case 'init':
        return await init();
      case 'migrate':
        return await migrate(values);
      case 'status':
        return await status(values);
      default:
        process.stderr.write(`billing-kit: unknown command ${JSON.stringify(command)}\n\n`);
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`billing-kit: ${error.message}\n`);
      for (const line of error.detail) process.stderr.write(line ? `  ${line}\n` : '\n');
      return 1;
    }
    throw error;
  }
}

const OPTIONS = {
  config: { type: 'string' },
  'database-url': { type: 'string' },
  migrations: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: string | boolean };

// --- init -------------------------------------------------------------------

/**
 * Write the template and print it.
 *
 * Printed in full, not summarised. The file is short, it is the only thing this
 * command does, and a tool that writes into your project should show you what
 * it put there rather than making you go and look.
 */
async function init(): Promise<number> {
  const result = await writeInitConfig(process.cwd());
  process.stdout.write(`wrote ${result.path}\n\n`);
  for (const line of result.contents.split('\n')) process.stdout.write(line ? `  ${line}\n` : '\n');
  process.stdout.write('\nNext: set DATABASE_URL, then `npx billing-kit migrate`.\n');
  return 0;
}

// --- migrate ----------------------------------------------------------------

async function migrate(values: Values): Promise<number> {
  const dryRun = values['dry-run'] === true;
  const { settings, files, db } = await open(values);

  try {
    // A dry run reads and does not write, so it does not create the tracking
    // table and does not take the lock. An absent table means nothing has been
    // applied, which is the honest reading of a database this tool has not
    // touched.
    if (!dryRun) {
      await ensureLedger(db);
      if (!(await takeLock(db))) {
        throw new CliError('another `billing-kit migrate` holds the lock on this database', [
          'Wait for it to finish. Two runs applying different files would leave the',
          'database in an order neither of them recorded.',
        ]);
      }
    }

    const entries = plan(files, (await ledgerExists(db)) ? await readApplied(db) : []);
    header(settings, files.length);

    const drifted = entries.filter((e) => e.state === 'changed' || e.state === 'missing');
    if (drifted.length > 0) {
      refuseDrift(drifted);
      return 1;
    }

    const pending = entries.filter((e) => e.state === 'pending');
    if (pending.length === 0) {
      process.stdout.write('nothing to apply\n');
      return 0;
    }

    const byName = new Map(files.map((f) => [f.filename, f]));
    for (const entry of pending) {
      const file = byName.get(entry.filename) as MigrationFile;
      if (dryRun) {
        process.stdout.write(`  would apply  ${file.filename}\n`);
        continue;
      }
      process.stdout.write(`  applying     ${file.filename}`);
      try {
        const ms = await applyMigration(db, file);
        process.stdout.write(` … ok (${ms}ms)\n`);
      } catch (error) {
        process.stdout.write(' … failed\n\n');
        throw failedMigration(file, error);
      }
    }

    process.stdout.write(
      dryRun ? `\n${pending.length} would be applied. Nothing was written.\n` : `\n${pending.length} applied.\n`,
    );
    return 0;
  } finally {
    if (!dryRun) await releaseLock(db).catch(() => {});
    await db.close();
  }
}

/**
 * The database's own message, verbatim, plus where it came from.
 *
 * Verbatim because Postgres already says the useful thing — sql/010_metering.sql
 * for instance raises a paragraph explaining that it collides with
 * sql/001_core.sql and which shape is canonical. Rewriting that into "migration
 * failed" would throw away the only part worth reading.
 *
 * The transaction rolled back, so the file is not recorded as applied and
 * nothing partial is in the schema. Re-running after the fix resumes here.
 */
function failedMigration(file: MigrationFile, error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { detail?: string; hint?: string } | undefined) ?? {};
  return new CliError(`${file.filename} failed and was rolled back`, [
    file.absolutePath,
    '',
    ...message.split('\n'),
    ...(detail.detail ? ['', ...detail.detail.split('\n')] : []),
    ...(detail.hint ? ['', `hint: ${detail.hint}`] : []),
    '',
    'Nothing was recorded for this file. Earlier files stay applied; fix this one',
    'and re-run `billing-kit migrate` to continue from here.',
  ]);
}

function refuseDrift(drifted: readonly PlanEntry[]): void {
  process.stderr.write('\nbilling-kit: refusing to migrate — applied migrations no longer match the files\n\n');
  for (const entry of drifted) {
    if (entry.state === 'changed') {
      process.stderr.write(`  ${entry.filename} changed since it was applied ${iso(entry.appliedAt)}\n`);
      process.stderr.write(`      recorded  ${entry.recorded}\n`);
      process.stderr.write(`      on disk   ${entry.onDisk}\n`);
    } else if (entry.state === 'missing') {
      process.stderr.write(`  ${entry.filename} was applied ${iso(entry.appliedAt)} and is no longer on disk\n`);
    }
  }
  process.stderr.write(
    [
      '',
      'An applied migration that changed is a schema that no longer matches the file',
      'that produced it. Skipping it — which is what every tool without a checksum',
      'does — is how a database and a repository stop agreeing with nobody finding out.',
      '',
      'Resolve it by hand, having decided which is right:',
      '',
      '  - the edit is already in the database (a comment, a reformat): record it',
      `      UPDATE ${TABLE} SET checksum = '<on disk>' WHERE filename = '<file>';`,
      '  - the edit is not in the database: revert the file and write the change as',
      '    a new numbered migration instead. An applied file is history.',
      '',
    ].join('\n'),
  );
}

// --- status -----------------------------------------------------------------

async function status(values: Values): Promise<number> {
  const { settings, files, db } = await open(values);
  try {
    const entries = plan(files, (await ledgerExists(db)) ? await readApplied(db) : []);
    header(settings, files.length);

    const width = Math.max(...entries.map((e) => e.filename.length));
    for (const entry of entries) {
      const name = entry.filename.padEnd(width);
      const line =
        entry.state === 'applied'
          ? `  applied   ${name}  ${iso(entry.appliedAt)}`
          : entry.state === 'pending'
            ? `  pending   ${entry.filename}`
            : entry.state === 'changed'
              ? `  CHANGED   ${name}  applied ${iso(entry.appliedAt)}, edited since`
              : `  MISSING   ${name}  applied ${iso(entry.appliedAt)}, not on disk`;
      process.stdout.write(`${line}\n`);
    }

    const count = (state: PlanEntry['state']) => entries.filter((e) => e.state === state).length;
    process.stdout.write(`\n${count('applied')} applied, ${count('pending')} pending`);
    const bad = count('changed') + count('missing');
    process.stdout.write(bad > 0 ? `, ${bad} drifted — migrate will refuse\n` : '\n');

    // Drift is a non-zero exit so that `billing-kit status` is usable as a CI
    // gate. Pending migrations are not: "you have not deployed yet" is a normal
    // state and exiting non-zero for it would make the gate useless.
    return bad > 0 ? 1 : 0;
  } finally {
    await db.close();
  }
}

// --- shared -----------------------------------------------------------------

interface Opened {
  settings: Settings;
  files: MigrationFile[];
  db: Connection;
}

async function open(values: Values): Promise<Opened> {
  const loaded = await loadConfig(process.cwd(), values.config as string | undefined);
  const settings = resolveSettings(
    loaded,
    {
      databaseUrl: values['database-url'] as string | undefined,
      migrations: values.migrations as string | undefined,
    },
    process.cwd(),
  );
  // Files first: a missing sql/ directory should not cost a connection, and its
  // error is more useful than a connection error that follows it.
  const files = await readMigrations(settings.migrationsDir);
  return { settings, files, db: await connect(settings.databaseUrl) };
}

function header(settings: Settings, fileCount: number): void {
  process.stdout.write(`database    ${redact(settings.databaseUrl)}\n`);
  process.stdout.write(`migrations  ${settings.migrationsDir} (${fileCount})\n`);
  if (settings.configPath) process.stdout.write(`config      ${settings.configPath}\n`);
  process.stdout.write('\n');
}

const iso = (d: Date): string => new Date(d).toISOString();

async function version(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return `billing-kit ${pkg.version}`;
}
