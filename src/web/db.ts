import { createPool, type Pool } from "../db/pool.ts";

/**
 * The website's connection to the database. Only the admin page uses it so far; the public pages read data/boards.json.
 *
 * The pool is created the first time it is asked for and kept on globalThis, so a development server that reloads its code
 * does not open a new pool each time. It is small and lets idle connections go quickly, because on a serverless host many
 * copies of this code can be alive at once and each one's connections count against the database's limit. Use the database's
 * pooled connection string here (the one with "-pooler" on Neon); the worker uses the direct one.
 *
 * Returns null when DATABASE_URL is not set, which is how the site runs before there is a database.
 */
const KEY = Symbol.for("sooner.web.pool");

export function webPool(env: Readonly<Record<string, string | undefined>> = process.env): Pool | null {
  const url = env["DATABASE_URL"]?.trim();
  if (!url) return null;
  const holder = globalThis as unknown as Record<symbol, Pool | undefined>;
  holder[KEY] ??= createPool(url, { max: 3, applicationName: "sooner-web", idleTimeoutMs: 10_000, onError: () => undefined });
  return holder[KEY];
}
