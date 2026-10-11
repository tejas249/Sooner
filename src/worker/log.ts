export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type Level = "info" | "warn" | "error";

/** Errors do not survive JSON.stringify (they turn into {}), so they are written as their name and message. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * One JSON object per line: easy to read in a terminal, easy for a log service to index. The time, level and message
 * always come first and cannot be overwritten by a field. Log ids and counts, never emails, tokens or connection strings.
 */
export function createLogger(write: (line: string) => void, clock: () => Date = () => new Date()): Logger {
  const log = (level: Level, message: string, fields: LogFields = {}): void => {
    const extra = Object.entries(fields).filter(([key]) => key !== "time" && key !== "level" && key !== "msg");
    write(JSON.stringify({ time: clock().toISOString(), level, msg: message, ...Object.fromEntries(extra) }, replacer));
  };
  return {
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

export interface LogEntry {
  level: Level;
  msg: string;
  [field: string]: unknown;
}

/** A logger that keeps its lines, for tests. */
export function createMemoryLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = createLogger((line) => entries.push(JSON.parse(line) as LogEntry));
  return { logger, entries };
}
