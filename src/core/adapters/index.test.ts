import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../types.ts";
import { adapters } from "./index.ts";

describe.each(PROVIDERS)("the %s adapter", (provider) => {
  const adapter = adapters[provider];

  it("is registered under its own name", () => {
    expect(adapter.provider).toBe(provider);
  });

  it("only ever builds https URLs on the host it declares, which is what the politeness gate is keyed on", () => {
    const url = new URL(adapter.url("acme"));
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(adapter.host);
    expect(url.pathname + url.search).toContain("acme");
  });

  it("has a sensible timeout", () => {
    expect(adapter.timeoutMs).toBeGreaterThanOrEqual(10_000);
  });
});

describe("provider differences that the rest of the system relies on", () => {
  it("never polls Ashby faster than its 60-second edge cache", () => {
    expect(adapters.ashby.minIntervalSec).toBe(60);
    expect(adapters.greenhouse.minIntervalSec).toBe(0);
    expect(adapters.lever.minIntervalSec).toBe(0);
  });

  it("gives Lever the longest timeout, because it builds big answers slowly", () => {
    expect(adapters.lever.timeoutMs).toBeGreaterThan(adapters.greenhouse.timeoutMs);
    expect(adapters.lever.timeoutMs).toBeGreaterThan(adapters.ashby.timeoutMs);
  });
});
