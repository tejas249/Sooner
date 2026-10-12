import { describe, expect, it } from "vitest";
import boardsFile from "../../data/boards.json" with { type: "json" };
import { BoardEntries, BoardEntry, SEGMENTS, slugify } from "./boards.ts";
import { PROVIDERS } from "./types.ts";

describe("slugify", () => {
  it.each([
    ["Stripe", "stripe"],
    ["Urban Company", "urban-company"],
    ["Yellow.ai", "yellow-ai"],
    ["  Café & Co.  ", "cafe-co"],
    ["1Password", "1password"],
  ])("turns %j into %j", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });
});

describe("a board entry", () => {
  const valid = {
    slug: "acme",
    name: "Acme",
    segment: "global",
    provider: "greenhouse",
    token: "acme",
    rolesWhenConfirmed: 3,
    confirmedVia: "hint",
  };

  it("accepts a well-formed line", () => {
    expect(BoardEntry.parse(valid)).toEqual(valid);
  });

  it.each([
    ["a token that could change the URL", { token: "../x" }],
    ["an unknown provider", { provider: "workday" }],
    ["an unknown segment", { segment: "europe" }],
    ["a slug with capitals", { slug: "Acme" }],
    ["a negative role count", { rolesWhenConfirmed: -1 }],
    ["a country that is not two letters", { country: "USA" }],
  ])("refuses %s", (_name, change) => {
    expect(BoardEntry.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});

// data/boards.json is what the poller reads and what the website shows, so a mistake in it should fail CI, not production.
describe("data/boards.json", () => {
  const boards = BoardEntries.parse(boardsFile);

  it("lists at least the 300 boards the guide asks for", () => {
    expect(boards.length).toBeGreaterThanOrEqual(300);
  });

  it("keeps the five-minute rhythm for the 50 boards picked first, and for no others", () => {
    // The worker's capacity is worked out for exactly this: fifty boards every five minutes, the rest adapting between half an
    // hour and six hours (docs/worker.md). More boards on the fast rhythm would not fit under one request a second to each host.
    expect(boards.filter((b) => b.priority)).toHaveLength(50);
  });

  it("has no company or board listed twice", () => {
    expect(new Set(boards.map((b) => b.slug)).size).toBe(boards.length);
    expect(new Set(boards.map((b) => `${b.provider}:${b.token}`)).size).toBe(boards.length);
  });

  it("covers every provider and every audience segment", () => {
    for (const provider of PROVIDERS) expect(boards.some((b) => b.provider === provider)).toBe(true);
    for (const segment of SEGMENTS) expect(boards.some((b) => b.segment === segment)).toBe(true);
  });

  it("only lists boards that had open roles when they were confirmed", () => {
    for (const board of boards) expect(board.rolesWhenConfirmed, board.slug).toBeGreaterThan(0);
  });
});
