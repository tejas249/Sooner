import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BoardEntries, type BoardEntry } from "../core/boards.ts";
import { seedBoards } from "./seed.ts";
import { testDatabase } from "./testing/database.ts";
import { insertBoard, insertCompany } from "./testing/factories.ts";

const db = testDatabase();
const NOW = new Date("2026-10-11T12:00:00Z");

const entry = (slug: string, over: Partial<BoardEntry> = {}): BoardEntry => ({
  slug,
  name: slug.toUpperCase(),
  segment: "global",
  country: "US",
  provider: "greenhouse",
  token: slug,
  rolesWhenConfirmed: 10,
  confirmedVia: "hint",
  ...over,
});

interface CompanyRow {
  slug: string;
  name: string;
  segment: string | null;
  country: string | null;
}
interface BoardRow {
  slug: string;
  provider: string;
  token: string;
  active: boolean;
  next_poll_at: Date;
  poll_interval_sec: number;
  etag: string | null;
  consecutive_failures: number;
}

const tables = async () => ({
  companies: (await db.pool.query<CompanyRow>("select slug, name, segment, country from company order by slug")).rows,
  boards: (
    await db.pool.query<BoardRow>(
      `select c.slug, b.provider, b.token, b.active, b.next_poll_at, b.poll_interval_sec, b.etag, b.consecutive_failures
         from board b join company c on c.id = b.company_id order by b.provider, b.token`,
    )
  ).rows,
});

describe("seedBoards", () => {
  it("adds a company and a board for every entry", async () => {
    const report = await seedBoards(db.pool, [entry("acme"), entry("globex", { provider: "ashby", segment: "india", country: "IN" })], { now: NOW });
    expect(report).toMatchObject({ companiesAdded: 2, companiesUpdated: 0, boardsAdded: 2, boardsAlreadyThere: 0 });
    const { companies, boards } = await tables();
    expect(companies).toEqual([
      { slug: "acme", name: "ACME", segment: "global", country: "US" },
      { slug: "globex", name: "GLOBEX", segment: "india", country: "IN" },
    ]);
    expect(boards.map((b) => [b.slug, b.provider, b.token, b.active, b.poll_interval_sec])).toEqual([
      ["globex", "ashby", "globex", true, 1800], // the helper sorts by provider
      ["acme", "greenhouse", "acme", true, 1800],
    ]);
  });

  it("seeds the real list", async () => {
    const entries = BoardEntries.parse(JSON.parse(readFileSync("data/boards.json", "utf8")));
    const report = await seedBoards(db.pool, entries, { now: NOW });
    const companies = new Set(entries.map((e) => e.slug)).size;
    expect(report).toMatchObject({ companiesAdded: companies, boardsAdded: entries.length });
    const { rows } = await db.pool.query<{ provider: string; n: number }>("select provider, count(*)::int as n from board group by provider order by provider");
    const expected = new Map<string, number>();
    for (const e of entries) expected.set(e.provider, (expected.get(e.provider) ?? 0) + 1);
    expect(rows).toEqual([...expected].sort(([a], [b]) => (a < b ? -1 : 1)).map(([provider, n]) => ({ provider, n })));
    const priorities = await db.pool.query<{ n: number }>("select count(*)::int as n from board where priority");
    expect(priorities.rows[0]?.n).toBe(entries.filter((e) => e.priority).length);
  });

  it("marks priority boards, and an entry without the flag is an ordinary board", async () => {
    await seedBoards(db.pool, [entry("vip", { priority: true }), entry("plain")], { now: NOW });
    const { rows } = await db.pool.query<{ token: string; priority: boolean }>("select token, priority from board order by token");
    expect(rows).toEqual([
      { token: "plain", priority: false },
      { token: "vip", priority: true },
    ]);
  });

  it("brings a board's priority in line with the list when it changes, and says so", async () => {
    await seedBoards(db.pool, [entry("a", { priority: true }), entry("b")], { now: NOW });
    const again = await seedBoards(db.pool, [entry("a"), entry("b", { priority: true })], { now: NOW });
    expect(again).toMatchObject({ boardsAdded: 0, boardsAlreadyThere: 2, boardsRepriced: 2 });
    const { rows } = await db.pool.query<{ token: string; priority: boolean }>("select token, priority from board order by token");
    expect(rows).toEqual([
      { token: "a", priority: false },
      { token: "b", priority: true },
    ]);
    const third = await seedBoards(db.pool, [entry("a"), entry("b", { priority: true })], { now: NOW });
    expect(third.boardsRepriced).toBe(0);
  });

  it("changes nothing when it is run again", async () => {
    const entries = [entry("acme"), entry("globex"), entry("initech")];
    await seedBoards(db.pool, entries, { now: NOW });
    const before = await tables();
    const again = await seedBoards(db.pool, entries, { now: new Date(NOW.getTime() + 3_600_000) });
    expect(again).toMatchObject({ companiesAdded: 0, companiesUpdated: 0, boardsAdded: 0, boardsAlreadyThere: 3 });
    expect(await tables()).toEqual(before);
  });

  it("staggers the first polls of new boards across the spread", async () => {
    await seedBoards(db.pool, [entry("a"), entry("b"), entry("c"), entry("d")], { now: NOW, spreadSec: 60 });
    const { boards } = await tables();
    expect(boards.map((b) => b.next_poll_at.getTime() - NOW.getTime())).toEqual([0, 15_000, 30_000, 45_000]);
  });

  it("starts everything at once with no spread", async () => {
    await seedBoards(db.pool, [entry("a"), entry("b")], { now: NOW, spreadSec: 0 });
    const { boards } = await tables();
    expect(boards.map((b) => b.next_poll_at.getTime() - NOW.getTime())).toEqual([0, 0]);
  });

  it("staggers only the boards it adds, and leaves the schedule of the others alone", async () => {
    await seedBoards(db.pool, [entry("old")], { now: NOW });
    await db.pool.query(
      "update board set next_poll_at = $1, poll_interval_sec = 4050, etag = 'W/\"x\"', consecutive_failures = 3, last_error = 'HTTP 503'",
      ["2026-10-12T00:00:00Z"],
    );
    await seedBoards(db.pool, [entry("old"), entry("new")], { now: NOW, spreadSec: 60 });
    const { boards } = await tables();
    expect(boards.find((b) => b.slug === "old")).toMatchObject({ poll_interval_sec: 4050, etag: 'W/"x"', consecutive_failures: 3 });
    expect(boards.find((b) => b.slug === "old")?.next_poll_at.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(boards.find((b) => b.slug === "new")?.next_poll_at.getTime()).toBe(NOW.getTime());
  });

  it("brings a company's name, segment and country up to date", async () => {
    await seedBoards(db.pool, [entry("acme")], { now: NOW });
    const report = await seedBoards(db.pool, [entry("acme", { name: "Acme Inc.", segment: "remote-first", country: undefined })], { now: NOW });
    expect(report).toMatchObject({ companiesAdded: 0, companiesUpdated: 1, boardsAdded: 0 });
    expect((await tables()).companies).toEqual([{ slug: "acme", name: "Acme Inc.", segment: "remote-first", country: null }]);
  });

  it("makes one company for two boards of it, one per provider", async () => {
    const report = await seedBoards(
      db.pool,
      [entry("acme"), entry("acme", { provider: "lever", token: "acme-jobs" })],
      { now: NOW },
    );
    expect(report).toMatchObject({ companiesAdded: 1, boardsAdded: 2 });
    const { rows } = await db.pool.query<{ n: number }>("select count(*)::int as n from company");
    expect(rows[0]?.n).toBe(1);
  });

  it("never switches a board back on: that is how an opt-out is honoured", async () => {
    await seedBoards(db.pool, [entry("acme"), entry("globex")], { now: NOW });
    await db.pool.query("update board set active = false where token = 'acme'");
    const report = await seedBoards(db.pool, [entry("acme"), entry("globex")], { now: NOW });
    expect(report.boardsSwitchedOff).toEqual(["greenhouse:acme"]);
    expect((await tables()).boards.find((b) => b.slug === "acme")?.active).toBe(false);
  });

  it("reports boards that are no longer in the list but keeps polling them, unless asked not to", async () => {
    await seedBoards(db.pool, [entry("acme"), entry("gone")], { now: NOW });
    const kept = await seedBoards(db.pool, [entry("acme")], { now: NOW });
    expect(kept.boardsNotInList).toEqual(["greenhouse:gone"]);
    expect(kept.boardsDeactivated).toEqual([]);
    expect((await tables()).boards.find((b) => b.slug === "gone")?.active).toBe(true);

    const switchedOff = await seedBoards(db.pool, [entry("acme")], { now: NOW, deactivateMissing: true });
    expect(switchedOff.boardsDeactivated).toEqual(["greenhouse:gone"]);
    const { boards } = await tables();
    expect(boards.find((b) => b.slug === "gone")?.active).toBe(false);
    expect(boards.find((b) => b.slug === "acme")?.active).toBe(true);
    // Nothing is deleted: the board and its history stay.
    expect(boards).toHaveLength(2);
  });

  it("does not report a board that is already switched off as missing", async () => {
    await seedBoards(db.pool, [entry("acme"), entry("gone")], { now: NOW });
    await db.pool.query("update board set active = false where token = 'gone'");
    const report = await seedBoards(db.pool, [entry("acme")], { now: NOW, deactivateMissing: true });
    expect(report.boardsNotInList).toEqual([]);
    expect(report.boardsDeactivated).toEqual([]);
  });

  it("leaves boards alone that it does not know about when they belong to other companies", async () => {
    const companyId = await insertCompany(db.pool, { slug: "manual" });
    await insertBoard(db.pool, companyId, { provider: "lever", token: "manual-board" });
    const report = await seedBoards(db.pool, [entry("acme")], { now: NOW });
    expect(report.boardsNotInList).toEqual(["lever:manual-board"]);
  });

  it("lets two seeds run at the same time without adding anything twice", async () => {
    const entries = [entry("a"), entry("b"), entry("c"), entry("d"), entry("e")];
    const reports = await Promise.all([seedBoards(db.pool, entries, { now: NOW }), seedBoards(db.pool, entries, { now: NOW }), seedBoards(db.pool, entries, { now: NOW })]);
    expect(reports.reduce((sum, r) => sum + r.boardsAdded, 0)).toBe(5);
    expect(reports.reduce((sum, r) => sum + r.companiesAdded, 0)).toBe(5);
    const { rows } = await db.pool.query<{ n: number }>("select count(*)::int as n from board");
    expect(rows[0]?.n).toBe(5);
  });

  it("does nothing, harmlessly, with an empty list", async () => {
    const report = await seedBoards(db.pool, [], { now: NOW });
    expect(report).toMatchObject({ companiesAdded: 0, boardsAdded: 0 });
  });
});
