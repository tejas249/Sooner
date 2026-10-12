import { describe, expect, it } from "vitest";
import {
  CHALLENGE,
  MIN_PASSWORD_LENGTH,
  adminAccess,
  adminOffReason,
  adminPassword,
  constantTimeEqual,
  passwordFromBasicAuth,
} from "./admin-auth.ts";

const PASSWORD = "correct horse battery staple 42";
const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("adminPassword", () => {
  it("is the configured password", () => {
    expect(adminPassword({ ADMIN_PASSWORD: PASSWORD })).toBe(PASSWORD);
  });

  it("is null, so the admin page stays off, when none is set", () => {
    expect(adminPassword({})).toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: undefined })).toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: "" })).toBeNull();
  });

  it(`is null for a password shorter than ${MIN_PASSWORD_LENGTH} characters: a weak password never switches the page on`, () => {
    expect(adminPassword({ ADMIN_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH - 1) })).toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH) })).not.toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: "admin" })).toBeNull();
  });

  it("keeps spaces: a passphrase is a password", () => {
    expect(adminPassword({ ADMIN_PASSWORD: "  spaces matter at both ends  " })).toBe("  spaces matter at both ends  ");
  });
});

describe("adminOffReason", () => {
  it("says what is wrong without ever repeating the password", () => {
    expect(adminOffReason({})).toBe("ADMIN_PASSWORD is not set");
    expect(adminOffReason({ ADMIN_PASSWORD: "" })).toBe("ADMIN_PASSWORD is not set");
    const short = adminOffReason({ ADMIN_PASSWORD: "hunter2" });
    expect(short).toMatch(/shorter than 16/);
    expect(short).not.toContain("hunter2");
    expect(adminOffReason({ ADMIN_PASSWORD: PASSWORD })).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("is true only for equal strings, of any length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("é", "é")).toBe(true);
  });
});

describe("passwordFromBasicAuth", () => {
  it("reads the password and ignores the user name", () => {
    expect(passwordFromBasicAuth(basic("admin", PASSWORD))).toBe(PASSWORD);
    expect(passwordFromBasicAuth(basic("", PASSWORD))).toBe(PASSWORD);
    expect(passwordFromBasicAuth(basic("anyone at all", PASSWORD))).toBe(PASSWORD);
  });

  it("keeps colons in the password, and non-ASCII text", () => {
    expect(passwordFromBasicAuth(basic("u", "pass:with:colons"))).toBe("pass:with:colons");
    expect(passwordFromBasicAuth(basic("u", "pässwörd ✓ 日本語"))).toBe("pässwörd ✓ 日本語");
  });

  it("accepts the scheme in any case", () => {
    expect(passwordFromBasicAuth(basic("u", "pw").replace("Basic", "basic"))).toBe("pw");
    expect(passwordFromBasicAuth(basic("u", "pw").replace("Basic", "BASIC"))).toBe("pw");
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["another scheme", "Bearer abc.def.ghi"],
    ["a scheme with nothing after it", "Basic"],
    ["something that is not base64", "Basic not*base64!"],
    ["credentials with no colon", `Basic ${Buffer.from("justapassword").toString("base64")}`],
    ["extra words after the credentials", `${basic("u", "pw")} extra`],
  ])("is null for %s", (_name, header) => {
    expect(passwordFromBasicAuth(header)).toBeNull();
  });
});

describe("adminAccess", () => {
  const env = { ADMIN_PASSWORD: PASSWORD };

  it("is off, whatever the request says, when no usable password is set", () => {
    expect(adminAccess({}, basic("u", PASSWORD))).toBe("off");
    expect(adminAccess({ ADMIN_PASSWORD: "short" }, basic("u", "short"))).toBe("off");
  });

  it("allows the right password", () => {
    expect(adminAccess(env, basic("admin", PASSWORD))).toBe("allowed");
  });

  it("denies no credentials, the wrong password, and near misses", () => {
    expect(adminAccess(env, null)).toBe("denied");
    expect(adminAccess(env, basic("admin", "wrong"))).toBe("denied");
    expect(adminAccess(env, basic("admin", `${PASSWORD} `))).toBe("denied");
    expect(adminAccess(env, basic("admin", PASSWORD.slice(0, -1)))).toBe("denied");
    expect(adminAccess(env, basic("admin", PASSWORD.toUpperCase()))).toBe("denied");
    expect(adminAccess(env, basic("admin", ""))).toBe("denied");
  });

  it("denies a header that merely contains the password", () => {
    expect(adminAccess(env, `Basic ${PASSWORD}`)).toBe("denied");
    expect(adminAccess(env, `Bearer ${PASSWORD}`)).toBe("denied");
  });
});

describe("the challenge", () => {
  it("makes a browser ask for a password", () => {
    expect(CHALLENGE).toMatch(/^Basic realm="[^"]+"/);
  });
});
