import { hostname } from "node:os";
import { databaseUrlFrom } from "../db/url.ts";
import { buildUserAgent } from "./user-agent.ts";

export interface WorkerConfig {
  databaseUrl: string;
  /** Goes into the User-Agent of every request. */
  contact: string;
  /** false stops all polling while the process stays up. */
  pollingEnabled: boolean;
  /**
   * Treat every board as followed, so it is polled every five minutes. Off by default: with hundreds of boards that is more
   * requests than the politeness gate can serve on time. The boards marked priority in data/boards.json are polled that fast
   * anyway; the rest speed up when they change and slow down when they are quiet.
   */
  allBoardsFollowed: boolean;
  dbPoolMax: number;
  /** How long polls in flight may take to finish when the worker is told to stop. */
  shutdownGraceSec: number;
  /** Shows up in the logs, so lines from two workers can be told apart. */
  workerId: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function flag(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  problems.push(`${name} must be true or false, not "${raw.slice(0, 20)}"`);
  return fallback;
}

function whole(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

/** Reads and checks the environment. Every problem is reported together, so one restart fixes them all. */
export function loadConfig(env: Env): WorkerConfig {
  const problems: string[] = [];
  const attempt = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return fallback;
    }
  };

  const databaseUrl = attempt(() => databaseUrlFrom(env), "");
  const contact = attempt(() => {
    const value = (env["HR_CONTACT"] ?? "").trim();
    buildUserAgent(value);
    return value;
  }, "");
  const config: WorkerConfig = {
    databaseUrl,
    contact,
    pollingEnabled: flag(env, "POLLING_ENABLED", true, problems),
    allBoardsFollowed: flag(env, "ALL_BOARDS_FOLLOWED", false, problems),
    dbPoolMax: whole(env, "DB_POOL_MAX", 10, 2, 50, problems),
    shutdownGraceSec: whole(env, "SHUTDOWN_GRACE_SEC", 25, 1, 300, problems),
    workerId: (env["WORKER_ID"]?.trim() || `${hostname()}-${process.pid}`).slice(0, 80),
  };
  if (problems.length > 0) throw new Error(`the worker is not configured correctly:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return config;
}
