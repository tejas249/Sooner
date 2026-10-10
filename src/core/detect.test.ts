import { describe, expect, it } from "vitest";
import { findBoardRefs, guessTokens } from "./detect.ts";

describe("findBoardRefs", () => {
  it("finds hosted boards for all three providers, in order of appearance", () => {
    const html = `
      <a href="https://jobs.lever.co/plaid">Plaid roles</a>
      <a href="https://boards.greenhouse.io/stripe/jobs/123">Stripe</a>
      <a href="https://job-boards.greenhouse.io/figma">Figma</a>
      <a href="https://jobs.ashbyhq.com/ramp/abc-123">Ramp</a>`;
    expect(findBoardRefs(html)).toEqual([
      { provider: "greenhouse", token: "stripe" },
      { provider: "greenhouse", token: "figma" },
      { provider: "lever", token: "plaid" },
      { provider: "ashby", token: "ramp" },
    ]);
  });

  it("reads the token out of the Greenhouse embed snippet instead of mistaking 'embed' for a board", () => {
    const html = `<script src="https://boards.greenhouse.io/embed/job_board/js?for=discord"></script>
                  <iframe src="https://boards.greenhouse.io/embed/job_board?for=airbnb&amp;b=1"></iframe>`;
    expect(findBoardRefs(html)).toEqual([
      { provider: "greenhouse", token: "discord" },
      { provider: "greenhouse", token: "airbnb" },
    ]);
  });

  it("sees links inside JSON where slashes are escaped", () => {
    const html = String.raw`{"url":"https:\/\/jobs.lever.co\/mistral"}`;
    expect(findBoardRefs(html)).toEqual([{ provider: "lever", token: "mistral" }]);
  });

  it("lower-cases tokens and reports each board once", () => {
    const html = `jobs.lever.co/Plaid jobs.lever.co/plaid jobs.lever.co/PLAID/apply`;
    expect(findBoardRefs(html)).toEqual([{ provider: "lever", token: "plaid" }]);
  });

  it("ignores hosts that only look similar and pages with no board", () => {
    expect(findBoardRefs(`<a href="https://example.com/jobs.lever.co.evil/x">x</a> nothing here`)).toEqual([]);
    expect(findBoardRefs("")).toEqual([]);
  });

  it("does not report API paths as boards", () => {
    expect(findBoardRefs("https://boards.greenhouse.io/v1/boards/x/jobs https://boards.greenhouse.io/embed/job_app?for=x")).toEqual([]);
  });
});

describe("guessTokens", () => {
  it("offers the name run together, hyphenated, and the website's first label", () => {
    expect(guessTokens("Urban Company", "https://www.urbancompany.com")).toEqual(["urbancompany", "urban-company"]);
    expect(guessTokens("Stripe", "https://stripe.com")).toEqual(["stripe"]);
    expect(guessTokens("Cloud Flare", "https://cloudflare.com")).toEqual(["cloudflare", "cloud-flare"]);
  });

  it("drops accents and punctuation", () => {
    expect(guessTokens("Café & Co.")).toEqual(["cafeco", "cafe-co"]);
  });

  it("ignores a website that is not a URL, and names with nothing usable", () => {
    expect(guessTokens("Acme", "not a url")).toEqual(["acme"]);
    expect(guessTokens("***")).toEqual([]);
  });
});
