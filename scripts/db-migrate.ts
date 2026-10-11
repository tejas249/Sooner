/**
 * Applies the SQL migrations in migrations/ to the database named by DATABASE_URL.
 *
 *   npm run db:migrate                  apply what is pending
 *   npm run db:migrate -- --status      show what is applied and what is pending, and change nothing
 *   npm run db:migrate -- --dir some/folder
 *
 * Run it as its own step before a new worker starts (a deploy's release command, or by hand), never when the worker
 * starts. Point it at the database's direct connection string, not a pooled one: it holds a session-level advisory lock
 * so two runs cannot overlap, and a transaction pooler does not keep a session.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadMigrations, migrate, migrationStatus } from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import { databaseUrlFrom, describeDatabase } from "../src/db/url.ts";
import { bold, dim, green, yellow } from "./lib/format.ts";
import { run } from "./lib/runtime.ts";

run(async () => {
  const { values } = parseArgs({
    options: {
      status: { type: "boolean", default: false },
      dir: { type: "string", default: "migrations" },
    },
  });
  const url = databaseUrlFrom(process.env);
  const migrations = loadMigrations(resolve(values.dir));
  const pool = createPool(url, { max: 2, applicationName: "sooner-migrate" });

  try {
    console.log(`${bold("Sooner: migrations")} ${dim(`on ${describeDatabase(url)}`)}`);
    if (values.status) {
      const { applied, pending } = await migrationStatus(pool, migrations);
      for (const m of migrations) {
        const done = applied.some((row) => row.version === m.version);
        console.log(`  ${done ? green("applied") : yellow("pending")}  ${m.file}`);
      }
      console.log(dim(`  ${applied.length} applied, ${pending.length} pending`));
      return;
    }
    const result = await migrate(pool, migrations, (line) => console.log(`  ${line}`));
    console.log(
      result.applied.length === 0
        ? green(`  Up to date: all ${result.alreadyApplied} migrations were already applied.`)
        : green(`  Applied ${result.applied.length} migration${result.applied.length === 1 ? "" : "s"}.`),
    );
  } finally {
    await pool.end();
  }
});
