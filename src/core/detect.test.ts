import { describe, expect, it } from "vitest";
import { boardEvidence, findBoardRefs, guessTokens } from "./detect.ts";

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

describe("boardEvidence", () => {
  it("counts how often the company's name appears, ignoring case", () => {
    const text = JSON.stringify({ company_name: "Stripe", jobs: [{ title: "Engineer at STRIPE" }, { note: "stripe is hiring" }] });
    expect(boardEvidence(text, "Stripe", "https://stripe.com")).toEqual({ name: 3, domain: 0 });
  });

  it("counts the website's address wherever it appears, with or without www and a path", () => {
    const text = "apply at https://stripe.com/jobs/1, mail jobs@stripe.com, see www.stripe.com and careers.stripe.com";
    expect(boardEvidence(text, "Stripe", "https://www.stripe.com/en-in").domain).toBe(4);
  });

  it("matches whole words only: a name inside another word is not the company", () => {
    expect(boardEvidence("a nonlinear problem, linearly", "Linear").name).toBe(0);
    expect(boardEvidence("Join Linear. Linear's team", "Linear").name).toBe(2);
  });

  it("does not mistake a different address for the company's own", () => {
    expect(boardEvidence("see notstripe.com, stripe-payments.com and stripe.company", "Stripe", "https://stripe.com").domain).toBe(0);
  });

  it("takes names with punctuation and spaces literally", () => {
    expect(boardEvidence("About Observe.AI: we build. Observe.AI is", "Observe.AI").name).toBe(2);
    expect(boardEvidence("ObserveXAI", "Observe.AI").name).toBe(0);
    expect(boardEvidence("Scale AI hires. scale ai too", "Scale AI").name).toBe(2);
  });

  it("also looks for a longer first word of a name with several words, since boards often say just 'Grafana'", () => {
    expect(boardEvidence("Grafana is open source", "Grafana Labs").name).toBe(1);
    // A short first word is too common to count.
    expect(boardEvidence("a new approach to new things", "New Relic").name).toBe(0);
  });

  it("finds nothing when there is nothing to look for", () => {
    expect(boardEvidence("anything", "").name).toBe(0);
    expect(boardEvidence("anything", "Acme", "not a url").domain).toBe(0);
    expect(boardEvidence("", "Acme", "https://acme.com")).toEqual({ name: 0, domain: 0 });
  });
});
