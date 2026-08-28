// Tiangong S1 shim — see ./package.json for rationale.
// The default export is a no-op constructor that intentionally throws so
// that any accidental runtime instantiation of the real better-sqlite3 is
// surfaced immediately, rather than silently bypassing our node:sqlite
// adapter. In production we always pass our own client to `drizzle()` and
// never reach `new Client(...)`, so this throw is unreachable.
function BetterSqlite3Shim() {
  throw new Error(
    "better-sqlite3 shim: do not call `new Client()` — pass an adapter " +
      "from api/lib/node-sqlite-adapter.ts (wrapping node:sqlite DatabaseSync) " +
      "as the first argument to drizzle() instead. See PLAN_SQLITE_MIGRATION.md S1."
  );
}
module.exports = BetterSqlite3Shim;
module.exports.default = BetterSqlite3Shim;
