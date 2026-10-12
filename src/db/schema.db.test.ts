import { describe, expect, it } from "vitest";
import { insertBoard, insertCompany, insertPosting } from "./testing/factories.ts";
import { testDatabase } from "./testing/database.ts";

const db = testDatabase();

/** Runs a statement that the schema must refuse, and returns the name of the constraint that refused it. */
async function refusedBy(sql: string, values: unknown[] = []): Promise<string | undefined> {
  try {
    await db.pool.query(sql, values);
  } catch (error) {
    return (error as { constraint?: string }).constraint;
  }
  return "(not refused)";
}

async function setup() {
  const companyId = await insertCompany(db.pool);
  const boardId = await insertBoard(db.pool, companyId);
  return { companyId, boardId };
}

describe("company", () => {
  it("needs a lower-case slug, a name and a two-letter upper-case country", async () => {
    expect(await refusedBy("insert into company (slug, name) values ('Has Caps', 'x')")).toBe("company_slug_format");
    expect(await refusedBy("insert into company (slug, name) values ('ok', '')")).toBe("company_name_not_empty");
    expect(await refusedBy("insert into company (slug, name, country) values ('ok', 'x', 'us')")).toBe("company_country_format");
    expect(await refusedBy("insert into company (slug, name, segment) values ('ok', 'x', 'galactic')")).toBe("company_segment_known");
  });

  it("has one row per slug", async () => {
    await insertCompany(db.pool, { slug: "acme" });
    expect(await refusedBy("insert into company (slug, name) values ('acme', 'Other')")).toBe("company_slug_key");
  });
});

describe("board", () => {
  it("accepts only the three providers and a token that is safe to put in a URL", async () => {
    const companyId = await insertCompany(db.pool);
    expect(await refusedBy("insert into board (company_id, provider, token) values ($1, 'workable', 'acme')", [companyId])).toBe(
      "board_provider_known",
    );
    for (const token of ["Has Caps", "a/b", "../x", "x?y", ""]) {
      expect(await refusedBy("insert into board (company_id, provider, token) values ($1, 'lever', $2)", [companyId, token])).toBe(
        "board_token_format",
      );
    }
  });

  it("has one row per provider and token", async () => {
    const { companyId } = await setup();
    expect(await refusedBy("insert into board (company_id, provider, token) values ($1, 'greenhouse', 'acme')", [companyId])).toBe(
      "board_provider_token_key",
    );
  });

  it("holds a lease only as a whole: until and token together", async () => {
    const { boardId } = await setup();
    expect(await refusedBy("update board set claimed_until = now() where id = $1", [boardId])).toBe("board_lease_complete");
    expect(await refusedBy("update board set claim_token = gen_random_uuid() where id = $1", [boardId])).toBe("board_lease_complete");
    await db.pool.query("update board set claimed_until = now(), claim_token = gen_random_uuid() where id = $1", [boardId]);
    await db.pool.query("update board set claimed_until = null, claim_token = null where id = $1", [boardId]);
  });

  it("refuses a zero interval and a negative failure count", async () => {
    const { boardId } = await setup();
    expect(await refusedBy("update board set poll_interval_sec = 0 where id = $1", [boardId])).toBe("board_interval_positive");
    expect(await refusedBy("update board set consecutive_failures = -1 where id = $1", [boardId])).toBe("board_failures_not_negative");
  });
});

describe("what a board remembers about trouble (migration 0002)", () => {
  it("starts as an ordinary board: not a priority, no 404s, never switched off", async () => {
    const { boardId } = await setup();
    const { rows } = await db.pool.query(
      "select priority, consecutive_not_found, deactivated_at, deactivated_reason, active from board where id = $1",
      [boardId],
    );
    expect(rows[0]).toEqual({ priority: false, consecutive_not_found: 0, deactivated_at: null, deactivated_reason: null, active: true });
  });

  it("cannot count a negative number of 404s", async () => {
    const { boardId } = await setup();
    expect(await refusedBy("update board set consecutive_not_found = -1 where id = $1", [boardId])).toBe("board_not_found_not_negative");
  });
});

describe("alert_state", () => {
  const insert = (key: string, severity = "warning") =>
    db.pool.query("insert into alert_state (key, severity, title, opened_at) values ($1, $2, 'Something', now())", [key, severity]);

  it("keeps one row per kind of problem", async () => {
    await insert("queue-lag");
    expect(await refusedBy("insert into alert_state (key, severity, title, opened_at) values ('queue-lag', 'warning', 'x', now())")).toBe(
      "alert_state_pkey",
    );
  });

  it("knows two severities, and counts sends from zero", async () => {
    await insert("a", "critical");
    expect(await refusedBy("insert into alert_state (key, severity, title, opened_at) values ('b', 'meh', 'x', now())")).toBe("alert_severity_known");
    expect(await refusedBy("update alert_state set send_count = -1 where key = 'a'")).toBe("alert_send_count_not_negative");
    const { rows } = await db.pool.query("select send_count, last_sent_at, resolved_at, detail from alert_state where key = 'a'");
    expect(rows[0]).toEqual({ send_count: 0, last_sent_at: null, resolved_at: null, detail: "" });
  });
});

describe("posting", () => {
  it("identifies a role by board and external ID", async () => {
    const ids = await setup();
    await insertPosting(db.pool, ids, { externalId: "42" });
    expect(await refusedBy(
      `insert into posting (board_id, company_id, external_id, title, title_norm, url, first_seen_at, last_seen_at, content_hash)
       values ($1, $2, '42', 't', 't', 'https://x.example', now(), now(), 'h')`,
      [ids.boardId, ids.companyId],
    )).toBe("posting_board_id_external_id_key");
  });

  it("is never both open and closed", async () => {
    const ids = await setup();
    const id = await insertPosting(db.pool, ids);
    expect(await refusedBy("update posting set status = 'closed' where id = $1", [id])).toBe("posting_closed_consistent");
    expect(await refusedBy("update posting set closed_at = now() where id = $1", [id])).toBe("posting_closed_consistent");
    await db.pool.query("update posting set status = 'closed', closed_at = now(), missed_polls = 2, missed_since = now() where id = $1", [id]);
  });

  it("has a miss count and a missing-since time that agree", async () => {
    const ids = await setup();
    const id = await insertPosting(db.pool, ids);
    expect(await refusedBy("update posting set missed_polls = 1 where id = $1", [id])).toBe("posting_misses_consistent");
    expect(await refusedBy("update posting set missed_since = now() where id = $1", [id])).toBe("posting_misses_consistent");
    expect(await refusedBy("update posting set missed_polls = -1, missed_since = now() where id = $1", [id])).toBe("posting_misses_consistent");
  });

  it("builds its search column from title, location and department", async () => {
    const ids = await setup();
    const id = await insertPosting(db.pool, ids, { title: "Staff Engineer, Payments", location: "Bengaluru" });
    const { rows } = await db.pool.query<{ hit: boolean; miss: boolean }>(
      `select search @@ to_tsquery('simple', 'payments & bengaluru') as hit, search @@ to_tsquery('simple', 'designer') as miss
         from posting where id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ hit: true, miss: false });
  });

  it("finds a title by similarity, which is what repost matching uses", async () => {
    const ids = await setup();
    await insertPosting(db.pool, ids, { title: "Senior Software Engineer", titleNorm: "senior software engineer" });
    const { rows } = await db.pool.query("select id from posting where similarity(title_norm, 'senior software engineer ii') >= 0.7");
    expect(rows).toHaveLength(1);
  });

  it("is the origin of at most one repost", async () => {
    const ids = await setup();
    const origin = await insertPosting(db.pool, ids, {
      externalId: "old",
      status: "closed",
      closedAt: "2026-09-20T00:00:00.000Z",
      missedPolls: 2,
      missedSince: "2026-09-20T00:00:00.000Z",
    });
    await insertPosting(db.pool, ids, { externalId: "new-1", repostOfId: origin });
    await expect(insertPosting(db.pool, ids, { externalId: "new-2", repostOfId: origin })).rejects.toMatchObject({
      constraint: "posting_repost_of_uidx",
    });
  });
});

describe("posting_event", () => {
  it("accepts only the five event types", async () => {
    const ids = await setup();
    const postingId = await insertPosting(db.pool, ids);
    for (const type of ["appeared", "updated", "closed", "reopened", "reposted"]) {
      await db.pool.query("insert into posting_event (posting_id, company_id, type) values ($1, $2, $3)", [postingId, ids.companyId, type]);
    }
    expect(await refusedBy("insert into posting_event (posting_id, company_id, type) values ($1, $2, 'deleted')", [postingId, ids.companyId])).toBe(
      "posting_event_type_known",
    );
  });
});

describe("cascades", () => {
  it("deleting a company removes its boards, postings, events and poll runs", async () => {
    const ids = await setup();
    const postingId = await insertPosting(db.pool, ids);
    await db.pool.query("insert into posting_event (posting_id, company_id, type) values ($1, $2, 'appeared')", [postingId, ids.companyId]);
    await db.pool.query("insert into poll_run (board_id, http_status) values ($1, 200)", [ids.boardId]);

    await db.pool.query("delete from company where id = $1", [ids.companyId]);

    for (const table of ["board", "posting", "posting_event", "poll_run"]) {
      const { rows } = await db.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(rows[0]?.n, table).toBe(0);
    }
  });
});

describe("indexes", () => {
  it("includes the partial and search indexes the queries depend on", async () => {
    const { rows } = await db.pool.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public'");
    const names = new Set(rows.map((r) => r.indexname));
    for (const wanted of [
      "board_due_idx",
      "posting_open_company_idx",
      "posting_recent_idx",
      "posting_on_strike_idx",
      "posting_closed_company_idx",
      "posting_search_idx",
      "posting_title_trgm_idx",
      "posting_repost_of_uidx",
      "posting_event_company_idx",
      "posting_event_posting_idx",
      "posting_event_unalerted_idx",
      "poll_run_board_idx",
      "board_inactive_idx",
      "alert_state_open_idx",
    ]) {
      expect(names.has(wanted), wanted).toBe(true);
    }
  });

  it("lets the claim query use the small partial index on due boards", async () => {
    const companyId = await insertCompany(db.pool);
    for (let i = 0; i < 300; i++) await insertBoard(db.pool, companyId, { token: `t${i}`, nextPollAt: `2026-10-01T00:${String(i % 60).padStart(2, "0")}:00Z` });
    // Whether the planner prefers the index depends on table statistics, which is not what this checks. It checks that the
    // index can serve the query, so sequential scans are switched off for the duration of the explain.
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("analyze board");
      await client.query("set local enable_seqscan = off");
      const { rows } = await client.query<Record<string, string>>(
        "explain select id from board where active and next_poll_at <= '2026-10-01T00:05:00Z' order by next_poll_at limit 10",
      );
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/board_due_idx/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
