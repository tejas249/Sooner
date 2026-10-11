import { describe, expect, it } from "vitest";
import recorded from "../../../fixtures/lever/spotify.json" with { type: "json" };
import { FeedFormatError } from "../errors.ts";
import { lever } from "./lever.ts";

const posting = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  text: "Backend Engineer",
  hostedUrl: "https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111",
  createdAt: 1_790_000_000_000,
  workplaceType: "hybrid",
  categories: { location: "Berlin", department: "Engineering", team: "Platform", allLocations: ["Berlin", "Paris"] },
  ...over,
});

describe("lever adapter, recorded Spotify response", () => {
  const jobs = lever.parse(recorded);

  it("turns every recorded posting into the internal shape", () => {
    expect(jobs).toHaveLength(6);
    expect(jobs[1]).toEqual({
      externalId: "2193db3f-77c5-43b8-b030-8f92c9882bf1",
      title: "Android Engineer - Experience",
      location: "London",
      department: "Engineering",
      remote: false,
      url: "https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9882bf1",
      postedAt: "2026-06-23T11:29:45.805Z", // createdAt is milliseconds since the epoch
      sourceUpdatedAt: null,
    });
  });

  it("maps the three workplace types", () => {
    const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j.remote]));
    expect(byTitle["Associate – Audiobook Licensing & Author Partnerships"]).toBe(true); // remote
    expect(byTitle["Android Engineer - Experience"]).toBe(false); // hybrid
    expect(byTitle["Artist Label Partnerships Manager, Taiwan"]).toBe(false); // onsite
  });

  it("does not carry descriptions into the internal shape", () => {
    for (const j of jobs) expect(Object.keys(j).sort()).toEqual([
      "department", "externalId", "location", "postedAt", "remote", "sourceUpdatedAt", "title", "url",
    ]);
  });
});

describe("lever adapter, edge cases", () => {
  it("builds the feed URL from a token", () => {
    expect(lever.url("spotify")).toBe("https://api.lever.co/v0/postings/spotify?mode=json");
    expect(() => lever.url("a/b")).toThrow(RangeError);
  });

  it("accepts an empty board", () => {
    expect(lever.parse([])).toEqual([]);
  });

  it("falls back to the first of allLocations, and to the team when there is no department", () => {
    const [job] = lever.parse([
      posting({ categories: { allLocations: ["Madrid", "Lisbon"], team: "Growth" } }),
    ]);
    expect(job).toMatchObject({ location: "Madrid", department: "Growth" });
  });

  it("leaves place and department empty when the feed has none", () => {
    const jobs = lever.parse([posting({ id: "a", categories: {} }), posting({ id: "b", categories: null })]);
    for (const job of jobs) expect(job).toMatchObject({ location: null, department: null });
  });

  it.each([
    ["remote", true],
    ["Remote", true],
    ["hybrid", false],
    ["onsite", false],
    ["on-site", false],
    ["unspecified", null],
    [undefined, null],
    ["something-new", null],
  ])("reads workplaceType %j as remote = %j", (workplaceType, expected) => {
    const [job] = lever.parse([posting({ workplaceType })]);
    expect(job?.remote).toBe(expected);
  });

  it("turns a missing or nonsense createdAt into no date rather than a wrong one", () => {
    const [a, b] = lever.parse([
      posting({ id: "a", createdAt: undefined }),
      posting({ id: "b", createdAt: Number.MAX_SAFE_INTEGER }),
    ]);
    expect(a?.postedAt).toBeNull();
    expect(b?.postedAt).toBeNull();
  });

  it.each([
    ["an object instead of a list", { postings: [] }],
    ["null", null],
    ["a posting with no id", [posting({ id: undefined })]],
    ["a posting with no text", [posting({ text: undefined })]],
    ["an error body", { ok: false, error: "Document not found" }],
  ])("fails the whole response on %s", (_name, payload) => {
    expect(() => lever.parse(payload)).toThrow(FeedFormatError);
  });

  it("upgrades an http link to https and refuses other schemes", () => {
    const [j] = lever.parse([posting({ hostedUrl: "http://jobs.lever.co/acme/1" })]);
    expect(j?.url).toBe("https://jobs.lever.co/acme/1");
    expect(() => lever.parse([posting({ hostedUrl: "javascript:alert(1)" })])).toThrow(FeedFormatError);
  });

  it("refuses a repeated posting ID", () => {
    expect(() => lever.parse([posting(), posting({ text: "Other" })])).toThrow(/appears twice/);
  });
});

describe("lever adapter, control characters", () => {
  const NUL = String.fromCharCode(0);

  it("cleans a control character out of a title and a place instead of passing it on", () => {
    const [job] = lever.parse([posting({ text: `Backend${NUL}Engineer`, categories: { location: `Ber${NUL}lin` } })]);
    expect(job?.title).toBe("Backend Engineer");
    expect(job?.location).toBe("Ber lin");
  });

  it("fails the response when an ID or a link carries one: the feed is not what we think it is", () => {
    expect(() => lever.parse([posting({ id: `abc${NUL}def` })])).toThrow(FeedFormatError);
    expect(() => lever.parse([posting({ hostedUrl: `https://jobs.lever.co/acme/1${NUL}` })])).toThrow(FeedFormatError);
  });

  it("fails the response for an absurdly long ID", () => {
    expect(() => lever.parse([posting({ id: "x".repeat(201) })])).toThrow(FeedFormatError);
  });
});
