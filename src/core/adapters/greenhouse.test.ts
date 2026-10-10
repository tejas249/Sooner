import { describe, expect, it } from "vitest";
import recorded from "../../../fixtures/greenhouse/stripe.json" with { type: "json" };
import { FeedFormatError } from "../errors.ts";
import { greenhouse } from "./greenhouse.ts";

const job = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: "Backend Engineer",
  absolute_url: "https://example.test/jobs/1",
  first_published: "2026-01-01T10:00:00-05:00",
  updated_at: "2026-01-02T10:00:00-05:00",
  location: { name: "Paris" },
  ...over,
});
const board = (jobs: unknown[], total = jobs.length) => ({ jobs, meta: { total } });

describe("greenhouse adapter, recorded Stripe response", () => {
  const jobs = greenhouse.parse(recorded);

  it("turns every recorded role into the internal shape", () => {
    expect(jobs).toHaveLength(8);
    expect(jobs[0]).toEqual({
      externalId: "8172510",
      title: "Abuse Investigator",
      location: "Seattle, San Francisco, New York City",
      department: null,
      remote: null,
      url: "https://stripe.com/jobs/search?gh_jid=8172510",
      postedAt: "2026-09-09T14:50:29.000Z", // the feed says 10:50:29-04:00
      sourceUpdatedAt: "2026-10-07T23:02:27.000Z",
    });
  });

  it("trims the stray spaces the feed puts around titles and places", () => {
    const grower = jobs.find((j) => j.externalId === "7993151");
    expect(grower?.title).toBe("Account Executive, Enterprise (Grower)");
    const hunter = jobs.find((j) => j.externalId === "7825578");
    expect(hunter?.title).toBe("Account Executive, Enterprise Hunter (DACH Market)");
    expect(hunter?.location).toBe("Germany");
  });

  it("says remote only when the place name does, and otherwise leaves it unknown", () => {
    const remote = Object.fromEntries(jobs.map((j) => [j.externalId, j.remote]));
    expect(remote).toMatchObject({ "8172503": true, "8201690": true, "7993151": true, "8172510": null, "5416444": null });
  });

  it("keeps the employer's own link and the provider's dates in UTC", () => {
    for (const j of jobs) {
      expect(j.url).toMatch(/^https:\/\/stripe\.com\/jobs\/search\?gh_jid=\d+$/);
      expect(j.postedAt).toMatch(/Z$/);
    }
  });
});

describe("greenhouse adapter, edge cases", () => {
  it("builds the feed URL from a token and refuses anything that could change the URL", () => {
    expect(greenhouse.url("stripe")).toBe("https://boards-api.greenhouse.io/v1/boards/stripe/jobs");
    for (const bad of ["", "Stripe", "a/b", "../x", "a b", "x?y=1", "x#y", "-x", "a".repeat(65)]) {
      expect(() => greenhouse.url(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it("accepts an empty board", () => {
    expect(greenhouse.parse(board([]))).toEqual([]);
  });

  it("ignores fields it does not use", () => {
    const plain = greenhouse.parse(board([job()]));
    const noisy = greenhouse.parse(board([job({ education: "x", metadata: [{ a: 1 }], brand_new_field: { deep: true } })]));
    expect(noisy).toEqual(plain);
  });

  it("copes with a missing place and missing dates", () => {
    const [a, b, c] = greenhouse.parse(
      board([
        job({ id: 1, location: null }),
        job({ id: 2, location: { name: "  " }, first_published: null, updated_at: undefined }),
        job({ id: 3, first_published: "not a date" }),
      ]),
    );
    expect(a?.location).toBeNull();
    expect(b).toMatchObject({ location: null, postedAt: null, sourceUpdatedAt: null });
    expect(c?.postedAt).toBeNull();
  });

  it("accepts a board with no meta block", () => {
    expect(greenhouse.parse({ jobs: [job()] })).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["a bare array", []],
    ["an empty object", {}],
    ["jobs that is not a list", { jobs: "nope" }],
    ["an id that is text", board([job({ id: "1" })])],
    ["a missing title", board([job({ title: undefined })])],
    ["a missing link", board([job({ absolute_url: undefined })])],
    ["a javascript link", board([job({ absolute_url: "javascript:alert(1)" })])],
  ])("fails the whole response on %s", (_name, payload) => {
    expect(() => greenhouse.parse(payload)).toThrow(FeedFormatError);
  });

  it("upgrades an http link to https, because some boards still publish them, and keeps the rest of the link as given", () => {
    const [j] = greenhouse.parse(board([job({ absolute_url: " http://www.example.test/about/careers?gh_jid=1 " })]));
    expect(j?.url).toBe("https://www.example.test/about/careers?gh_jid=1");
  });

  it.each(["ftp://example.test/1", "data:text/html,hi", "//example.test/1", "example.test/1", ""])("refuses %j as a link", (link) => {
    expect(() => greenhouse.parse(board([job({ absolute_url: link })]))).toThrow(FeedFormatError);
  });

  it("names the provider in its errors so an alert says which feed changed", () => {
    expect(() => greenhouse.parse({ jobs: "nope" })).toThrow(/^greenhouse: unexpected response shape/);
  });

  it("refuses an empty title rather than showing a blank role", () => {
    expect(() => greenhouse.parse(board([job({ title: "  \t " })]))).toThrow(/empty title/);
  });

  it("refuses a list shorter than the board's own total, which would make missing roles look closed", () => {
    expect(() => greenhouse.parse(board([job()], 5))).toThrow(/meta\.total is 5 but the list holds 1/);
  });

  it("refuses a repeated role ID", () => {
    expect(() => greenhouse.parse(board([job({ id: 7 }), job({ id: 7, title: "Other" })]))).toThrow(/appears twice/);
  });
});
