import { describe, expect, it } from "vitest";
import { oneLine } from "./sanitize.ts";

describe("oneLine", () => {
  it("collapses whitespace and trims", () => {
    expect(oneLine("  HTTP   503 \n\t Service Unavailable ")).toBe("HTTP 503 Service Unavailable");
  });

  it("turns control characters into spaces", () => {
    const NUL = String.fromCharCode(0);
    const ESCAPE = String.fromCharCode(0x1b);
    expect(oneLine(`a${NUL}b${ESCAPE}[31mc`)).toBe("a b [31mc");
  });

  it("cuts long text with an ellipsis and never beyond the limit", () => {
    const out = oneLine("x".repeat(1000), 50);
    expect([...out]).toHaveLength(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not split a character made of two UTF-16 units", () => {
    const out = oneLine("🙂".repeat(100), 10);
    expect([...out]).toHaveLength(10);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("leaves short plain text alone", () => {
    expect(oneLine("timeout")).toBe("timeout");
    expect(oneLine("")).toBe("");
  });
});
