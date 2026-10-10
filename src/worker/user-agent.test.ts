import { describe, expect, it } from "vitest";
import { buildUserAgent } from "./user-agent.ts";

describe("buildUserAgent", () => {
  it("puts the contact in the header so a company can reach whoever is polling", () => {
    expect(buildUserAgent("me@example.test")).toBe("Sooner/0.1 (+me@example.test)");
    expect(buildUserAgent("  https://example.test/bot  ")).toBe("Sooner/0.1 (+https://example.test/bot)");
  });

  it.each([undefined, "", "   "])("refuses to run without a contact (%j)", (value) => {
    expect(() => buildUserAgent(value)).toThrow(/HR_CONTACT is empty/);
  });

  it.each([
    ["a line break", "me@example.test\nX-Injected: 1"],
    ["a control character", "me@example.test\u0007"],
    ["parentheses", "me (at) example.test"],
    ["a very long value", "x".repeat(201)],
  ])("refuses a contact with %s", (_name, value) => {
    expect(() => buildUserAgent(value)).toThrow(/one line of at most 200 characters/);
  });
});
