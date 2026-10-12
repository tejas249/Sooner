import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testDatabase } from "./testing/database.ts";
import { insertBoard, insertCompany, insertPosting } from "./testing/factories.ts";

/**
 * docs/operating.sql is what the person running Sooner pastes into psql when something looks wrong, so every query in it has
 * to run against the schema as it is today. This runs each one, on an empty database and on one with a little in it.
 */

const db = testDatabase();

/** The numbered queries in the file: the text of each, without its comment lines. */
function queries(): Array<{ number: number; sql: string }> {
  const text = readFileSync(join(import.meta.dirname, "..", "..", "docs", "operating.sql"), "utf8");
  const blocks = text.split(/^-- (?=\d+\. )/m).slice(1);
  return blocks.map((block) => ({
    number: Number(/^(\d+)\./.exec(block)?.[1]),
    sql: block
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .slice(1) // the first line is the heading, which the split above left without its dashes
      .join("\n")
      .trim(),
  }));
}

describe("docs/operating.sql", () => {
  it("has the numbered queries the docs refer to, each one a single statement", () => {
    const found = queries();
    expect(found.map((q) => q.number)).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
    expect(found.length).toBeGreaterThanOrEqual(14);
    for (const query of found) expect(query.sql.replace(/;\s*$/, ""), `query ${query.number}`).not.toContain(";");
  });

  it("runs every query on an empty database", async () => {
    for (const query of queries()) await expect(db.pool.query(query.sql), `query ${query.number}`).resolves.toBeDefined();
  });

  it("runs every query on a database with a board, a role, a poll and an alert in it", async () => {
    const company = await insertCompany(db.pool);
    const board = await insertBoard(db.pool, company, { consecutiveFailures: 2, nextPollAt: new Date(Date.now() - 600_000).toISOString() });
    const posting = await insertPosting(db.pool, { boardId: board, companyId: company });
    await db.pool.query("insert into posting_event (posting_id, company_id, type) values ($1, $2, 'appeared')", [posting, company]);
    await db.pool.query("insert into poll_run (board_id, queue_lag_ms, http_status, error) values ($1, 4200, 503, 'the feed changed shape: x'), ($1, null, 200, null)", [board]);
    await db.pool.query(
      "insert into alert_state (key, severity, title, detail, opened_at) values ('queue-lag', 'critical', 'Boards are being polled late', 'x', now())",
    );
    for (const query of queries()) await expect(db.pool.query(query.sql), `query ${query.number}`).resolves.toBeDefined();
  });

  it("gives the 48-hour check's numbers for the polls it was told about", async () => {
    const company = await insertCompany(db.pool);
    const board = await insertBoard(db.pool, company);
    for (const lag of [1000, 3000, 5000, 61_000]) {
      await db.pool.query("insert into poll_run (board_id, queue_lag_ms, http_status) values ($1, $2, 304)", [board, lag]);
    }
    const query = queries().find((q) => q.number === 14);
    const { rows } = await db.pool.query(query?.sql ?? "select 1");
    expect(rows[0]).toMatchObject({
      polls: "4",
      success_pct: "100.00",
      polls_with_lag: "4",
      median_lag_sec: "4.0",
      worst_lag_sec: "61.0",
      started_within_a_minute_pct: "75.00",
    });
  });
});
