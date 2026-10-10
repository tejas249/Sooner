import { describe, expect, it } from "vitest";
import recorded from "../../../fixtures/ashby/ramp.json" with { type: "json" };
import { FeedFormatError } from "../errors.ts";
import { ashby } from "./ashby.ts";

const job = (over: Record<string, unknown> = {}) => ({
  id: "22222222-2222-2222-2222-222222222222",
  title: "Backend Engineer",
  jobUrl: "https://jobs.ashbyhq.com/acme/22222222-2222-2222-2222-222222222222",
  isListed: true,
  publishedAt: "2026-03-01T09:30:00.000+00:00",
  location: "Berlin",
  department: "Engineering",
  team: "Platform",
  isRemote: false,
  workplaceType: "Hybrid",
  ...over,
});
const board = (jobs: unknown[]) => ({ apiVersion: "1", jobs });

describe("ashby adapter, recorded Ramp response", () => {
  const jobs = ashby.parse(recorded);

  it("turns every recorded role into the internal shape", () => {
    expect(jobs).toHaveLength(6);
    expect(jobs[0]).toEqual({
      externalId: "34413f8d-26bf-4bbc-8ade-eb309a0e2245",
      title: "Security Engineer, Cloud", // the feed says " Security Engineer, Cloud"
      location: "New York, NY (HQ)",
      department: "Engineering",
      remote: false,
      url: "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
      postedAt: "2026-04-07T17:12:35.753Z",
      sourceUpdatedAt: null,
    });
  });

  it("trims titles with a stray space at either end", () => {
    expect(jobs.map((j) => j.title)).toContain("Account Executive | Strategic");
    for (const j of jobs) expect(j.title).toBe(j.title.trim());
  });

  it("follows workplaceType, not the isRemote flag, which is also true for hybrid roles", () => {
    const hybridWithFlag = jobs[0]; // workplaceType Hybrid, isRemote true in the recording
    expect(hybridWithFlag?.remote).toBe(false);
    const remote = jobs.find((j) => j.title === "Account Manager | Mid-Market");
    expect(remote?.remote).toBe(true);
    const onSite = jobs.find((j) => j.title === "Product Manager | Growth");
    expect(onSite?.remote).toBe(false);
  });
});

describe("ashby adapter, edge cases", () => {
  it("builds the feed URL from a token and never polls faster than the 60-second edge cache", () => {
    expect(ashby.url("ramp")).toBe("https://api.ashbyhq.com/posting-api/job-board/ramp");
    expect(ashby.minIntervalSec).toBe(60);
    expect(() => ashby.url("a b")).toThrow(RangeError);
  });

  it("drops roles that are not listed, so they close through the normal two-miss path", () => {
    const jobs = ashby.parse(board([job({ id: "a" }), job({ id: "b", isListed: false })]));
    expect(jobs.map((j) => j.externalId)).toEqual(["a"]);
  });

  it("accepts an empty board", () => {
    expect(ashby.parse(board([]))).toEqual([]);
  });

  it("uses the team when there is no department", () => {
    const [j] = ashby.parse(board([job({ department: undefined })]));
    expect(j?.department).toBe("Platform");
  });

  it.each([
    [{ workplaceType: "Remote", isRemote: false }, true],
    [{ workplaceType: "remote", isRemote: undefined }, true],
    [{ workplaceType: "Hybrid", isRemote: true }, false],
    [{ workplaceType: "OnSite", isRemote: true }, false],
    [{ workplaceType: "On-Site", isRemote: undefined }, false],
    [{ workplaceType: undefined, isRemote: true }, true],
    [{ workplaceType: undefined, isRemote: false }, false],
    [{ workplaceType: undefined, isRemote: undefined }, null],
    [{ workplaceType: "Brand new value", isRemote: undefined }, null],
  ])("reads %j as remote = %j", (fields, expected) => {
    const [j] = ashby.parse(board([job(fields)]));
    expect(j?.remote).toBe(expected);
  });

  it("requires isListed instead of guessing what a missing flag means", () => {
    expect(() => ashby.parse(board([job({ isListed: undefined })]))).toThrow(FeedFormatError);
  });

  it.each([
    ["null", null],
    ["a bare list", []],
    ["jobs that is not a list", { jobs: {} }],
    ["a missing title", board([job({ title: undefined })])],
  ])("fails the whole response on %s", (_name, payload) => {
    expect(() => ashby.parse(payload)).toThrow(FeedFormatError);
  });

  it("upgrades an http link to https and refuses other schemes", () => {
    const [j] = ashby.parse(board([job({ jobUrl: "http://jobs.ashbyhq.com/x/1" })]));
    expect(j?.url).toBe("https://jobs.ashbyhq.com/x/1");
    expect(() => ashby.parse(board([job({ jobUrl: "javascript:alert(1)" })]))).toThrow(FeedFormatError);
  });

  it("refuses a repeated role ID", () => {
    expect(() => ashby.parse(board([job(), job({ title: "Other" })]))).toThrow(/appears twice/);
  });

  it("does not fail on a role that is unlisted and also malformed in a field we do not use", () => {
    expect(ashby.parse(board([job({ id: "a" }), job({ id: "b", isListed: false, department: 7 })])).length).toBe(1);
  });
});
