import { describe, expect, it } from "vitest";
import { clean, contentHash, norm } from "./text.ts";

// Built from code points so the invisible characters are visible in this file.
const NBSP = String.fromCharCode(0x00a0);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

describe("clean", () => {
  it("collapses runs of whitespace, including non-breaking spaces, and trims", () => {
    expect(clean(`  Senior \t Engineer${NBSP}${NBSP}(Remote)\n`)).toBe("Senior Engineer (Remote)");
  });

  it("removes zero-width characters that make equal-looking titles compare as different", () => {
    expect(clean(`Sen${ZERO_WIDTH_SPACE}ior Engineer${BYTE_ORDER_MARK}`)).toBe("Senior Engineer");
  });

  it("returns an empty string for missing input", () => {
    expect(clean(null)).toBe("");
    expect(clean(undefined)).toBe("");
    expect(clean("   ")).toBe("");
  });
});

describe("norm", () => {
  it("lower-cases and turns punctuation into single spaces", () => {
    expect(norm("Senior Software Engineer (Remote) - US")).toBe("senior software engineer remote us");
  });

  it("strips accents instead of splitting words at them", () => {
    expect(norm("Zürich Office")).toBe("zurich office");
    expect(norm("São Paulo")).toBe("sao paulo");
  });

  it("keeps letters and digits from any script", () => {
    expect(norm("エンジニア L5")).toBe("エンジニア l5");
  });

  it("does not damage scripts whose letters are built from combining marks", () => {
    expect(norm("इंजीनियर (Remote)")).toBe("इंजीनियर remote"); // Devanagari vowel signs stay
    expect(norm("ガ ギ グ")).toBe("ガ ギ グ"); // katakana voiced marks stay
  });

  it("folds compatibility forms such as full-width letters", () => {
    expect(norm("ＳＲＥ　Ｌ５")).toBe("sre l5");
  });

  it("gives an empty string when nothing is left", () => {
    expect(norm("--- ()")).toBe("");
    expect(norm(undefined)).toBe("");
  });
});

describe("contentHash", () => {
  const base = {
    title: "Backend Engineer",
    location: "Remote",
    department: "Engineering",
    remote: true,
    url: "https://x.test/1",
  };

  it("is stable for the same fields", () => {
    expect(contentHash(base)).toBe(contentHash({ ...base }));
  });

  it("ignores whitespace noise in the text fields", () => {
    expect(contentHash({ ...base, title: "  Backend   Engineer " })).toBe(contentHash(base));
  });

  it.each([
    ["title", { title: "Frontend Engineer" }],
    ["location", { location: "Berlin" }],
    ["department", { department: "Data" }],
    ["remote", { remote: false }],
    ["url", { url: "https://x.test/2" }],
  ])("changes when the %s changes", (_field, change) => {
    expect(contentHash({ ...base, ...change })).not.toBe(contentHash(base));
  });

  it("tells unknown remote (null) apart from not remote (false)", () => {
    expect(contentHash({ ...base, remote: null })).not.toBe(contentHash({ ...base, remote: false }));
  });
});
