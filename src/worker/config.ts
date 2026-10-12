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
  /**
   * Where alerts to the owner are delivered: a chat webhook (Discord, Slack or any JSON endpoint) or a Telegram bot. With
   * neither, alerts are still tracked, logged and shown on the admin page.
   */
  alertWebhookUrl: string | null;
  alertTelegram: { botToken: string; chatId: string } | null;
  /** How often the worker looks at its own health. */
  monitorIntervalSec: number;
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The webhook address is a secret, so a problem with it is described without repeating it. */
function webhookProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "ALERT_WEBHOOK_URL is not a valid URL";
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  return "ALERT_WEBHOOK_URL must be an https address";
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
  const webhook = env["ALERT_WEBHOOK_URL"]?.trim() || null;
  if (webhook) {
    const problem = webhookProblem(webhook);
    if (problem) problems.push(problem);
  }
  const botToken = env["ALERT_TELEGRAM_BOT_TOKEN"]?.trim() || null;
  const chatId = env["ALERT_TELEGRAM_CHAT_ID"]?.trim() || null;
  if ((botToken === null) !== (chatId === null)) {
    problems.push("ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID must be set together");
  }
  const config: WorkerConfig = {
    databaseUrl,
    contact,
    pollingEnabled: flag(env, "POLLING_ENABLED", true, problems),
    allBoardsFollowed: flag(env, "ALL_BOARDS_FOLLOWED", false, problems),
    dbPoolMax: whole(env, "DB_POOL_MAX", 10, 2, 50, problems),
    shutdownGraceSec: whole(env, "SHUTDOWN_GRACE_SEC", 25, 1, 300, problems),
    workerId: (env["WORKER_ID"]?.trim() || `${hostname()}-${process.pid}`).slice(0, 80),
    alertWebhookUrl: webhook,
    alertTelegram: botToken !== null && chatId !== null ? { botToken, chatId } : null,
    monitorIntervalSec: whole(env, "MONITOR_INTERVAL_SEC", 60, 10, 600, problems),
  };
  if (problems.length > 0) throw new Error(`the worker is not configured correctly:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return config;
}
