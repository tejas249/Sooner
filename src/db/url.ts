/**
 * The database URL from the environment. A URL carries the password, so nothing here ever puts the URL itself into an
 * error message or a log line: use `describeDatabase` to say which database a command is about to touch.
 */
export function databaseUrlFrom(env: Readonly<Record<string, string | undefined>>): string {
  const value = env["DATABASE_URL"]?.trim();
  if (!value) {
    throw new Error(
      "DATABASE_URL is not set. For local development run `npm run db:dev` in another terminal and put the URL it prints in .env (see .env.example).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  }
  return value;
}

/** "host:port/database", without the user or the password. */
export function describeDatabase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${decodeURIComponent(parsed.pathname)}`;
}
