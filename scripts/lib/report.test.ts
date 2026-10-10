import { beforeAll, describe, expect, it } from "vitest";
import { applySnapshot, emptyBoardState, type ApplyResult, type JobEvent } from "../../src/core/changes.ts";
import { job, jobs, many, minutes, T0 } from "../../src/core/test-utils.ts";
import type { BoardEntry } from "./boards-file.ts";
import { renderChanges, renderDelays, renderSummaryLine, summarizeRound, type BoardResult } from "./report.ts";

beforeAll(() => {
  process.env["NO_COLOR"] = "1"; // plain text, so the assertions read the same everywhere
});

const board: BoardEntry = {
  slug: "acme",
  name: "Acme",
  segment: "global",
  provider: "greenhouse",
  token: "acme",
  rolesWhenConfirmed: 3,
  confirmedVia: "hint",
};

const result = (applied: ApplyResult | null, kind: BoardResult["kind"] = "downloaded", over: Partial<BoardResult> = {}): BoardResult => ({
  board,
  kind,
  applied,
  status: 200,
  ms: 100,
  bytes: 1000,
  reason: null,
  openRoles: 3,
  ...over,
});

const baselined = (...ids: string[]) => applySnapshot(emptyBoardState(), jobs(...ids), minutes(0)).state;
const now = minutes(10);

describe("summarizeRound", () => {
  it("counts each outcome and adds up bytes and open roles", () => {
    const summary = summarizeRound([
      result(null, "baseline", { bytes: 500, openRoles: 10 }),
      result(null, "downloaded", { bytes: 300, openRoles: 5 }),
      result(null, "unchanged", { bytes: 0, openRoles: 7 }),
      result(null, "unchanged", { bytes: 0, openRoles: 1 }),
      result(null, "failed", { bytes: 0, openRoles: 2 }),
    ]);
    expect(summary).toEqual({ boards: 5, baseline: 1, downloaded: 1, unchanged: 2, failed: 1, bytes: 800, openRoles: 25 });
  });

  it("reads as one line", () => {
    const line = renderSummaryLine({ boards: 50, baseline: 0, downloaded: 9, unchanged: 41, failed: 0, bytes: 6_100_000, openRoles: 8750 }, 14_200);
    expect(line).toBe("  50 boards in 14.2 s: 9 downloaded · 41 unchanged (304) · 0 failed · 6.1 MB read · 8,750 open roles tracked");
  });
});

describe("renderChanges", () => {
  it("says nothing when nothing changed", () => {
    expect(renderChanges([result(applySnapshot(baselined("a"), jobs("a"), minutes(5)))], now)).toEqual([]);
  });

  it("lists a new role with its company, place, age and link", () => {
    const applied = applySnapshot(baselined("a"), [job("a"), job("n", { title: "Staff Engineer", location: "Berlin", postedAt: minutes(7).toISOString() })], minutes(8));
    const text = renderChanges([result(applied)], now).join("\n");
    expect(text).toContain("New roles (1)");
    expect(text).toMatch(/\+ Acme\s+Staff Engineer\s+Berlin\s+posted 3 min ago/);
    expect(text).toContain("https://example.test/jobs/n");
  });

  it("says when a new role has no posting date", () => {
    const applied = applySnapshot(baselined("a"), [job("a"), job("n", { postedAt: null })], minutes(8));
    expect(renderChanges([result(applied)], now).join("\n")).toContain("no posting date");
  });

  it("shows what an edit changed, old value to new", () => {
    const applied = applySnapshot(baselined("a"), [job("a", { title: "Principal Engineer", remote: false })], minutes(8));
    const text = renderChanges([result(applied)], now).join("\n");
    expect(text).toContain("Edited roles (1)");
    expect(text).toContain('title "Role a" -> "Principal Engineer"; remote true -> false');
  });

  it("shows roles that closed, roles waiting for a second check, and roles that came back", () => {
    const first = applySnapshot(baselined("a", "b", "c"), jobs("b", "c"), minutes(5));
    expect(renderChanges([result(first)], now).join("\n")).toMatch(/Missing, waiting for a second check \(1\)[\s\S]*\? Acme\s+Role a\s+not listed \(check 1 of 2\)/);

    const second = applySnapshot(first.state, jobs("b", "c"), minutes(8));
    expect(renderChanges([result(second)], now).join("\n")).toMatch(/Closed roles \(1\)[\s\S]*- Acme\s+Role a\s+closed after 0 d open \(missing on 2 checks\)/);

    const back = applySnapshot(second.state, jobs("a", "b", "c"), minutes(9));
    expect(renderChanges([result(back)], now).join("\n")).toContain("Reopened roles (1)");
  });

  it("holds back a mass disappearance and says why", () => {
    const state = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    const text = renderChanges([result(applySnapshot(state, many(5), minutes(5)))], now).join("\n");
    expect(text).toContain("Held back (1)");
    expect(text).toContain("! Acme: 5 of 10 open roles vanished at once. Closing waits for 3 checks over 20 minutes.");
  });

  it("caps a long list and says how many more there were", () => {
    const applied = applySnapshot(baselined("a"), [job("a"), ...many(12, 100)], minutes(8));
    const lines = renderChanges([result(applied)], now, 5);
    expect(lines.filter((l) => l.startsWith("  + "))).toHaveLength(5);
    expect(lines.join("\n")).toContain("... and 7 more");
  });

  it("cannot be driven by a job title: control characters are replaced before anything is printed", () => {
    const esc = String.fromCharCode(0x1b);
    const applied = applySnapshot(
      baselined("a"),
      [job("a"), job("n", { title: `Engineer${esc}[2J${esc}[31mFREE MONEY`, location: `Berlin${esc}]0;owned`, url: `https://example.test/${esc}x` })],
      minutes(8),
    );
    const text = renderChanges([result(applied)], now).join("\n");
    expect(text).not.toContain(esc);
    expect(text).toContain("Engineer [2J [31mFREE MONEY");
  });
});

describe("renderDelays", () => {
  const appeared = (id: string, postedMinutesAgo: number | null): JobEvent => {
    const base = applySnapshot(emptyBoardState(), [], new Date(T0)).state;
    const postedAt = postedMinutesAgo === null ? null : new Date(T0 + 600_000 - postedMinutesAgo * 60_000).toISOString();
    const event = applySnapshot(base, [job(id, { postedAt })], new Date(T0 + 600_000)).events[0];
    if (!event) throw new Error("expected an appeared event");
    return event;
  };

  it("says so when nothing new appeared", () => {
    expect(renderDelays([])[0]).toMatch(/No new roles appeared/);
  });

  it("says so when new roles carry no provider date", () => {
    expect(renderDelays([appeared("a", null)])[0]).toMatch(/none carries a provider date/);
  });

  it("reports the median, the 95th percentile and the longest delay", () => {
    const lines = renderDelays([appeared("a", 2), appeared("b", 4), appeared("c", 12), appeared("d", null)]);
    expect(lines[0]).toBe("Detection delay for 3 of 4 new roles that carry a provider date:");
    expect(lines[1]).toBe("  median 4.0 min · 95th percentile 11.2 min · longest 12.0 min");
  });
});
