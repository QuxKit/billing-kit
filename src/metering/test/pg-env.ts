// Point `psql` at the same server the rest of the suite uses.
//
// The metering harness drives Postgres through the `psql` binary, which reads
// its connection from PGHOST / PGPORT / PGUSER / PGPASSWORD. The rest of the
// suite reads BILLING_KIT_TEST_DATABASE_URL. Rather than make CI set both, this
// derives the libpq variables from the URL once, at import, and only for the
// ones the environment has not already set — so an explicit PGHOST still wins.
//
// The database NAME in the URL is deliberately ignored: this harness creates one
// database per test file (`<prefix>_engine`, `<prefix>_driver`, ...), so the
// name it needs is a prefix, not the URL's path.

const url = process.env.BILLING_KIT_TEST_DATABASE_URL;

if (url !== undefined && url !== '') {
  const parsed = new URL(url);
  const set = (name: string, value: string): void => {
    if (value === '') return;
    if (process.env[name] !== undefined && process.env[name] !== '') return;
    process.env[name] = value;
  };
  set('PGHOST', decodeURIComponent(parsed.hostname));
  set('PGPORT', parsed.port);
  set('PGUSER', decodeURIComponent(parsed.username));
  set('PGPASSWORD', decodeURIComponent(parsed.password));
}

/**
 * Whether the DB-backed suites may skip when the server is unreachable. Same
 * rule as `test/pg-executor.ts`: locally they skip with a reason; under
 * `REQUIRE_DB` they fail loudly.
 */
export const REQUIRE_DB = process.env.REQUIRE_DB !== undefined && process.env.REQUIRE_DB !== '';

export const SKIP_REASON =
  'no Postgres reachable via psql — set BILLING_KIT_TEST_DATABASE_URL (or PGHOST/PGUSER) ' +
  'to a server that can CREATE DATABASE';
