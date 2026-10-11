import { describe, expect, it } from "vitest";
import { createLogger, createMemoryLogger } from "./log.ts";

describe("createLogger", () => {
  it("writes one JSON object per line, time first", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line), () => new Date("2026-10-08T12:00:00Z"));
    log.info("poll", { board_id: "7", status: 200 });
    expect(lines).toEqual(['{"time":"2026-10-08T12:00:00.000Z","level":"info","msg":"poll","board_id":"7","status":200}']);
    expect(lines[0]).not.toContain("\n");
  });

  it("has three levels", () => {
    const { logger, entries } = createMemoryLogger();
    logger.info("a");
    logger.warn("b");
    logger.error("c");
    expect(entries.map((e) => [e.level, e.msg])).toEqual([["info", "a"], ["warn", "b"], ["error", "c"]]);
  });

  it("writes an error as its name and message instead of {}", () => {
    const { logger, entries } = createMemoryLogger();
    logger.error("boom", { error: new TypeError("bad thing") });
    expect(entries[0]?.["error"]).toEqual({ name: "TypeError", message: "bad thing" });
  });

  it("writes a bigint as text instead of throwing", () => {
    const { logger, entries } = createMemoryLogger();
    logger.info("n", { n: 12345678901234567890n });
    expect(entries[0]?.["n"]).toBe("12345678901234567890");
  });

  it("does not let a field overwrite the time, level or message", () => {
    const { logger, entries } = createMemoryLogger();
    logger.warn("real", { level: "info", msg: "fake", time: "yesterday", extra: 1 });
    expect(entries[0]).toMatchObject({ level: "warn", msg: "real", extra: 1 });
    expect(entries[0]?.["time"]).not.toBe("yesterday");
  });
});
