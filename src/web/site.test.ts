import { describe, expect, it } from "vitest";
import { siteUrl } from "./site.ts";

describe("siteUrl", () => {
  it("prefers an address set by hand, which is how a custom domain is switched on", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://sooner.dev", VERCEL_PROJECT_PRODUCTION_URL: "sooner.vercel.app" }).href).toBe("https://sooner.dev/");
  });

  it("falls back to the Vercel project's production address", () => {
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "sooner.vercel.app" }).href).toBe("https://sooner.vercel.app/");
  });

  it("uses localhost when there is neither", () => {
    expect(siteUrl({}).href).toBe("http://localhost:3000/");
  });
});
