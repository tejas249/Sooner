// What /api/health reports. The post-deploy smoke test compares `commit` with the commit that was just pushed, which
// proves the public address serves the new build and not a stale one.

export interface Health {
  status: "ok";
  /** The first seven characters of the deployed commit, or "local" outside Vercel. */
  commit: string;
  /** "production", "preview" or "development". */
  env: string;
}

export function health(env: Record<string, string | undefined>): Health {
  return {
    status: "ok",
    // Vercel injects the full SHA at build and run time; locally there is none.
    commit: env["VERCEL_GIT_COMMIT_SHA"]?.slice(0, 7) ?? "local",
    env: env["VERCEL_ENV"] ?? "development",
  };
}
