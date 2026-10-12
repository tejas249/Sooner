import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy.ts";

const PASSWORD = "correct horse battery staple 42";
const basic = (password: string): string => `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
const request = (authorization?: string, path = "/admin"): NextRequest =>
  new NextRequest(`http://localhost:3000${path}`, authorization ? { headers: { authorization } } : undefined);

afterEach(() => vi.unstubAllEnvs());

describe("the admin proxy", () => {
  it("makes the page not exist at all when there is no usable password", () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    const response = proxy(request(basic(PASSWORD)));
    expect(response.headers.get("x-middleware-rewrite")).toContain("/not-found-admin-is-off");
    expect(response.headers.get("www-authenticate")).toBeNull(); // nothing hints that an admin page exists
  });

  it("makes it not exist for a password that is too short, even when it is given correctly", () => {
    vi.stubEnv("ADMIN_PASSWORD", "hunter2");
    expect(proxy(request(basic("hunter2"))).headers.get("x-middleware-rewrite")).toContain("/not-found-admin-is-off");
  });

  it("asks for a password when none is given", async () => {
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const response = proxy(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm="Sooner admin"/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(PASSWORD);
  });

  it("refuses a wrong password in the same way", () => {
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    expect(proxy(request(basic("wrong"))).status).toBe(401);
  });

  it("lets the right password through, uncached and unindexed", () => {
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const response = proxy(request(basic(PASSWORD)));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("guards the page and everything under it, and nothing else", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
  });
});
