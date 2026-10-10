import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "./security-headers.ts";

const directive = (policy: string, name: string): string[] =>
  (policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "").split(" ").slice(1);

describe("contentSecurityPolicy", () => {
  const prod = contentSecurityPolicy();

  it("forbids framing the site, plugins, <base> tricks and form hijacking", () => {
    expect(directive(prod, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(prod, "object-src")).toEqual(["'none'"]);
    expect(directive(prod, "base-uri")).toEqual(["'self'"]);
    expect(directive(prod, "form-action")).toEqual(["'self'"]);
    expect(directive(prod, "frame-src")).toEqual(["'none'"]);
  });

  it("lets nothing load from, or talk to, any address but the site itself", () => {
    for (const name of ["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src"]) {
      const sources = directive(prod, name).filter((s) => !s.startsWith("'") && s !== "data:" && s !== "blob:");
      expect(sources, name).toEqual([]);
    }
  });

  it("upgrades insecure requests in production, and allows eval and websockets only in development", () => {
    expect(prod).toContain("upgrade-insecure-requests");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain("ws://");
    const dev = contentSecurityPolicy({ dev: true });
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws://localhost:*");
  });
});

describe("securityHeaders", () => {
  const headers = Object.fromEntries(securityHeaders().map((h) => [h.key, h.value]));

  it("sends the standard set", () => {
    expect(headers["Strict-Transport-Security"]).toMatch(/^max-age=31536000/);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("switches off browser features the site never uses", () => {
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(headers["Permissions-Policy"]).toContain(`${feature}=()`);
    }
  });

  it("sends each header once", () => {
    const keys = securityHeaders().map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
