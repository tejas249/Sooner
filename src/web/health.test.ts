import { describe, expect, it } from "vitest";
import { health } from "./health.ts";

describe("health", () => {
  it("reports the deployed commit (first seven characters) and environment on Vercel", () => {
    expect(health({ VERCEL_GIT_COMMIT_SHA: "41a9c0790e20c33e72cbe2f8c08dd3566ef7633e", VERCEL_ENV: "production" })).toEqual({
      status: "ok",
      commit: "41a9c07",
      env: "production",
    });
  });

  it("says it is local when run anywhere else", () => {
    expect(health({})).toEqual({ status: "ok", commit: "local", env: "development" });
  });

  it("reports a preview deployment as one", () => {
    expect(health({ VERCEL_GIT_COMMIT_SHA: "abcdef1234", VERCEL_ENV: "preview" }).env).toBe("preview");
  });
});
