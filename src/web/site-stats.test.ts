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
    expect(siteStats([])).toEqual({ companies: 0, fast: 0, providers: 0, roles: 0, byProvider: [], bySegment: [] });
  });

  describe("what the page shows first", () => {
    const many = [
      entry({ slug: "z-fast", name: "Zed", token: "z", priority: true }),
      entry({ slug: "a-slow", name: "Ada", token: "a" }),
      entry({ slug: "m-slow", name: "Max", token: "m" }),
      entry({ slug: "b-fast", name: "Bea", token: "b", priority: true }),
      entry({ slug: "i-only", name: "Ira", token: "i", segment: "india" }),
      entry({ slug: "r-all", name: "Rex", token: "r", segment: "remote-first", priority: true }),
    ];
    const grouped = siteStats(many);
    const group = (label: string) => grouped.bySegment.find((g) => g.label === label);

    it("puts the boards polled every five minutes first and the rest behind a toggle, each in alphabetical order", () => {
      expect(group("Global tech")?.shown.map((b) => b.name)).toEqual(["Bea", "Zed"]);
      expect(group("Global tech")?.hidden.map((b) => b.name)).toEqual(["Ada", "Max"]);
    });

    it("shows a group in full when none of its boards, or all of them, are on the fast rhythm", () => {
      expect(group("India")).toMatchObject({ hidden: [] });
      expect(group("India")?.shown.map((b) => b.name)).toEqual(["Ira"]);
      expect(group("Remote-first")).toMatchObject({ hidden: [] });
      expect(group("Remote-first")?.shown.map((b) => b.name)).toEqual(["Rex"]);
    });

    it("keeps every board of the group in `boards`, shown or not", () => {
      expect(group("Global tech")?.boards.map((b) => b.name)).toEqual(["Ada", "Bea", "Max", "Zed"]);
    });

    it("counts the boards on the fast rhythm", () => {
      expect(grouped.fast).toBe(3);
    });
  });

  it("adds up to the real data file", () => {
    const entries = BoardEntries.parse(boardsFile);
    const real = siteStats(entries);
    expect(real.companies).toBe(entries.length);
    expect(real.providers).toBe(3);
    expect(real.bySegment.reduce((sum, s) => sum + s.boards.length, 0)).toBe(entries.length);
    expect(real.byProvider.reduce((sum, p) => sum + p.boards, 0)).toBe(entries.length);
  });
});
