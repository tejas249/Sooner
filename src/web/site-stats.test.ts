import { describe, expect, it } from "vitest";
import boardsFile from "../../data/boards.json" with { type: "json" };
import { BoardEntries, type BoardEntry } from "../core/boards.ts";
import { siteStats } from "./site-stats.ts";

const entry = (over: Partial<BoardEntry>): BoardEntry => ({
  slug: "acme",
  name: "Acme",
  segment: "global",
  provider: "greenhouse",
  token: "acme",
  rolesWhenConfirmed: 10,
  confirmedVia: "hint",
  ...over,
});

describe("siteStats", () => {
  const stats = siteStats([
    entry({ slug: "b", name: "Beta", token: "b", segment: "india", provider: "lever", rolesWhenConfirmed: 5 }),
    entry({ slug: "a", name: "alpha", token: "a", segment: "global", provider: "greenhouse", rolesWhenConfirmed: 7 }),
    entry({ slug: "c", name: "Charlie", token: "c", segment: "global", provider: "greenhouse", rolesWhenConfirmed: 3 }),
  ]);

  it("counts companies, providers in use and open roles", () => {
    expect(stats).toMatchObject({ companies: 3, providers: 2, roles: 15 });
    expect(stats.byProvider.map((p) => [p.provider, p.boards])).toEqual([
      ["greenhouse", 2],
      ["lever", 1],
    ]);
  });

  it("groups by audience in a fixed order and sorts names without regard to case", () => {
    expect(stats.bySegment.map((s) => [s.label, s.boards.map((b) => b.name)])).toEqual([
      ["Global tech", ["alpha", "Charlie"]],
      ["India", ["Beta"]],
    ]);
  });

  it("copes with an empty list", () => {
    expect(siteStats([])).toEqual({ companies: 0, providers: 0, roles: 0, byProvider: [], bySegment: [] });
  });

  it("adds up to the real data file", () => {
    const real = siteStats(BoardEntries.parse(boardsFile));
    expect(real.companies).toBe(50);
    expect(real.providers).toBe(3);
    expect(real.bySegment.reduce((sum, s) => sum + s.boards.length, 0)).toBe(50);
    expect(real.byProvider.reduce((sum, p) => sum + p.boards, 0)).toBe(50);
  });
});
