#!/usr/bin/env node
// S1 (PLAN_SQLITE_MIGRATION): one-shot script that converts db/schema.ts
// from the drizzle-orm/mysql-core dialect to drizzle-orm/sqlite-core.
//
// Usage:
//   node scripts/sqlite-schema-transform.mjs                # writes db/schema.ts.new
//   node scripts/sqlite-schema-transform.mjs --in-place     # overwrites db/schema.ts
//
// Transformation rules (preserving table names, column names, and exported
// type names verbatim — downstream code references them):
//
//   import { mysqlTable, ... } from "drizzle-orm/mysql-core"
//   import { sqliteTable, integer, int, text, real, blob,
//            index, uniqueIndex, primaryKey, foreignKey, ... } from "drizzle-orm/sqlite-core"
//
//   mysqlTable("x", {...})                 → sqliteTable("x", {...})
//   serial("x")                            → integer("x", { mode: "number" })
//   (serial has no unsigned option)
//   int("x")                               → integer("x", { mode: "number" })
//   int("x", { ... })                      → integer("x", { mode: "number", ... })
//   bigint("x", { mode: "number", unsigned: true })
//                                          → integer("x", { mode: "number" })
//   bigint("x", { mode: "number" })        → integer("x", { mode: "number" })
//   bigint("x")                            → integer("x", { mode: "number" })
//   timestamp("x")                         → integer("x", { mode: "timestamp" })
//   mysqlEnum("x", [...])                  → text("x", { enum: [...] })
//   varchar("x", { length: N })            → text("x", { length: N })
//   varchar("x")                           → text("x")
//   json("x")                              → text("x", { mode: "json" })
//   decimal("x", { precision, scale })     → text("x")        // SQLite has no native DECIMAL
//                                                                  // storage is text; precision/scale
//                                                                  // is app-side only. (S2 may revisit.)
//
//   `.defaultNow().$onUpdate(() => new Date())` chain on a timestamp is
//   preserved (SQLite's `integer({mode:"timestamp"}).defaultNow()` returns
//   the same builder shape; `.notNull().$onUpdate(() => new Date())` chains
//   stay valid).
//
// The script writes db/schema.ts.new (or overwrites db/schema.ts when
// --in-place is given) and also prints a small audit summary so the
// reviewer can spot-check the conversion.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const schemaPath = path.join(repoRoot, "db", "schema.ts");
const inPlace = process.argv.includes("--in-place");

function fail(msg) {
  console.error(`[sqlite-schema-transform] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(schemaPath)) fail(`schema not found: ${schemaPath}`);

const original = fs.readFileSync(schemaPath, "utf8");
let src = original;

// ---- 1. Rewrite the import line ----
src = src.replace(
  /^import \{([\s\S]*?)\} from "drizzle-orm\/mysql-core";\s*$/m,
  (_match, namesBlock) => {
    // Split the namesBlock by commas (tolerate newlines).
    const names = namesBlock
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const kept = [];
    for (const n of names) {
      // Always drop mysql-specific names.
      if (n === "mysqlTable" || n === "mysqlEnum" || n === "serial") continue;
      // Keep names that are also exported by sqlite-core, mapped to their
      // sqlite equivalents where needed.
      if (n === "varchar") {
        // varchar does not exist in sqlite-core — we transform call sites
        // to `text(...)` below, so the import is dropped.
        continue;
      }
      if (n === "json") {
        // json does not exist in sqlite-core — we transform call sites to
        // `text(..., { mode: "json" })` below.
        continue;
      }
      if (n === "decimal") {
        // decimal does not exist in sqlite-core — we transform call sites
        // to `text(...)` below.
        continue;
      }
      if (n === "timestamp") {
        // timestamp does not exist in sqlite-core — we transform to
        // `integer(..., { mode: "timestamp" })` below.
        continue;
      }
      if (n === "int" || n === "bigint") {
        // We rewrite to `integer(...)`, so the names are dropped.
        continue;
      }
      kept.push(n);
    }
    // Ensure the sqlite-core names we need are present (no duplicates).
    const want = [
      "sqliteTable",
      "integer",
      "int",
      "text",
      "real",
      "blob",
      "index",
      "uniqueIndex",
      "primaryKey",
      "foreignKey",
    ];
    for (const w of want) {
      if (!kept.includes(w)) kept.push(w);
    }
    return `import { ${kept.join(", ")} } from "drizzle-orm/sqlite-core";`;
  }
);

// ---- 2. mysqlTable → sqliteTable (must run BEFORE column rewrites so we
//         don't accidentally rewrite any nested `mysqlTable` arguments)
src = src.replace(/\bmysqlTable\(/g, "sqliteTable(");

// ---- 2b. serial("x") → integer("x", { mode: "number" })
src = src.replace(/\bserial\(\s*("[^"]+"|`[^`]+`)\s*\)/g, (_m, name) => `integer(${name}, { mode: "number" })`);

// ---- 2c. After int("x") was rewritten to integer("x", { mode: "number" })
//         in step 5, the original MySQL chain `.autoincrement().primaryKey()`
//         on a bare int column becomes
//         `integer("x", { mode: "number" }).autoincrement().primaryKey()`.
//         In SQLite INTEGER PRIMARY KEY already auto-increments, so the
//         explicit .autoincrement() call is a no-op. The notifications
//         table is the only occurrence at the time of S1.
src = src.replace(
  /\binteger\(\s*("[^"]+"|`[^`]+`)\s*,\s*\{\s*mode:\s*"number"\s*\}\s*\)\.autoincrement\(\)/g,
  (_m, name) => `integer(${name}, { mode: "number" })`
);

// ---- 3. mysqlEnum → text({ enum: [...] })
src = src.replace(
  /\bmysqlEnum\(\s*("[^"]+"|`[^`]+`)\s*,\s*(\[[\s\S]*?\])\s*\)/g,
  (_m, name, arr) => `text(${name}, { enum: ${arr} })`
);

// ---- 4. bigint(..., { ... unsigned: true ... }) → integer(..., { ... } without unsigned)
src = src.replace(
  /\bbigint\(\s*("[^"]+"|`[^`]+`)\s*,\s*\{([\s\S]*?)\}\s*\)/g,
  (_m, name, opts) => {
    const cleaned = opts
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/^unsigned\s*:/.test(s))
      .join(", ");
    return `integer(${name}, {${cleaned}})`;
  }
);
// bigint(..., { mode: "number" }) (no unsigned)
src = src.replace(
  /\bbigint\(\s*("[^"]+"|`[^`]+`)\s*,\s*\{\s*mode:\s*"number"\s*\}\s*\)/g,
  (_m, name) => `integer(${name}, { mode: "number" })`
);
// bare bigint(...)
src = src.replace(/\bbigint\(\s*("[^"]+"|`[^`]+`)\s*\)/g, (_m, name) => `integer(${name}, { mode: "number" })`);

// ---- 5. int(...) → integer({ mode: "number" }, ...) — preserve any second
//         argument (like { unsigned: true } becomes no-op under sqlite).
src = src.replace(
  /\bint\(\s*("[^"]+"|`[^`]+`)\s*,\s*\{([\s\S]*?)\}\s*\)/g,
  (_m, name, opts) => {
    const cleaned = opts
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/^unsigned\s*:/.test(s))
      .join(", ");
    return `integer(${name}, { mode: "number"${cleaned ? `, ${cleaned}` : ""} })`;
  }
);
// bare int(...)
src = src.replace(/\bint\(\s*("[^"]+"|`[^`]+`)\s*\)/g, (_m, name) => `integer(${name}, { mode: "number" })`);

// ---- 6. timestamp(...) → integer(..., { mode: "timestamp" })
src = src.replace(
  /\btimestamp\(\s*("[^"]+"|`[^`]+`)\s*\)/g,
  (_m, name) => `integer(${name}, { mode: "timestamp" })`
);

// ---- 7. varchar(..., { length: N }) → text(..., { length: N })
src = src.replace(
  /\bvarchar\(\s*("[^"]+"|`[^`]+`)\s*,\s*\{\s*length:\s*(\d+)\s*\}\s*\)/g,
  (_m, name, len) => `text(${name}, { length: ${len} })`
);
// bare varchar(...)
src = src.replace(/\bvarchar\(\s*("[^"]+"|`[^`]+`)\s*\)/g, (_m, name) => `text(${name})`);

// ---- 8. json(...) → text(..., { mode: "json" })
src = src.replace(/\bjson\(\s*("[^"]+"|`[^`]+`)\s*\)/g, (_m, name) => `text(${name}, { mode: "json" })`);

// ---- 9. decimal(...) → text(...) (we drop precision/scale; sqlite stores
//         as text, app-side enforces format).
src = src.replace(
  /\bdecimal\(\s*("[^"]+"|`[^`]+`)\s*,\s*\{([\s\S]*?)\}\s*\)/g,
  (_m, name) => `text(${name})`
);
src = src.replace(/\bdecimal\(\s*("[^"]+"|`[^`]+`)\s*\)/g, (_m, name) => `text(${name})`);

// ---- 10. Sanity sweep: catch any leftover mysql-core names that should
//          not survive a sqlite schema.
const forbidden = ["mysqlTable", "mysqlEnum", "serial(", "bigint(", "int(\"", "int('", "timestamp(", "varchar(", "json(\"", "json('", "decimal("];
for (const tok of forbidden) {
  // We allow `int(` only as the sqlite-core `int` alias (a bare identifier
  // appearing in import). The token below is column-call form, not the
  // bare import alias; we have already rewritten those.
  if (tok === 'int("' || tok === "int('") {
    if (src.includes(tok)) {
      fail(`leftover ${tok} — column call site not rewritten`);
    }
    continue;
  }
  if (src.includes(tok)) {
    fail(`leftover ${tok} in transformed source — review rules above`);
  }
}

// ---- 11. Audit summary ----
function count(re) {
  return (src.match(re) || []).length;
}
const summary = {
  sqliteTable: count(/\bsqliteTable\(/g),
  integer: count(/\binteger\(/g),
  text: count(/\btext\(/g),
  uniqueIndex: count(/\buniqueIndex\(/g),
  index: count(/\bindex\(/g),
  references: count(/\.references\(/g),
  defaultNow: count(/\.defaultNow\(\)/g),
  $onUpdate: count(/\$\onUpdate\(/g),
};
console.log("[sqlite-schema-transform] audit:");
for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);

const outPath = inPlace ? schemaPath : path.join(repoRoot, "db", "schema.ts.new");
fs.writeFileSync(outPath, src, "utf8");
console.log(`[sqlite-schema-transform] wrote ${path.relative(repoRoot, outPath)}`);
