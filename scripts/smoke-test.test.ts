import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The smoke test is the last line of the deploy pipeline, so the script itself is tested here against a fake site.
let server: http.Server;
let host = "";
let reportedCommit = "41a9c07";
let reportedEnv = "production";
let dropHeaders = false;
/** What the fake site answers for /admin without a password: 404 when it is switched off, 401 when it asks for one. */
let adminStatus = 404;

const HOME = "<html><h1>Know when a role opens, sooner.</h1><h2>Companies it watches</h2></html>";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const headers: Record<string, string> = dropHeaders
      ? {}
      : {
          "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "x-content-type-options": "nosniff",
        };
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commit: reportedCommit, env: reportedEnv }));
    } else if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html", ...headers });
      res.end(HOME);
    } else if (req.url === "/admin") {
      res.writeHead(adminStatus, adminStatus === 401 ? { "www-authenticate": 'Basic realm="Sooner admin"' } : {}).end("x");
    } else if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-Agent: *\nAllow: /\nDisallow: /api/\n");
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const exec = promisify(execFile);

// Asynchronous on purpose: the fake site lives in this process, so a blocking spawn would stop it answering the script.
async function smoke(expectedSha: string | undefined, args: string[] = [host]) {
  try {
    const { stdout, stderr } = await exec("bash", ["scripts/smoke-test.sh", ...args], {
      env: { ...process.env, SMOKE_SCHEME: "http", SMOKE_RETRIES: "2", SMOKE_DELAY: "0", EXPECTED_SHA: expectedSha ?? "" },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("scripts/smoke-test.sh", () => {
  it("passes when the site serves the commit that was pushed", async () => {
    reportedCommit = "41a9c07";
    reportedEnv = "production";
    dropHeaders = false;
    const { code, out } = await smoke("41a9c0790e20c33e72cbe2f8c08dd3566ef7633e");
    expect(out).toContain("All checks passed.");
    expect(code).toBe(0);
  });

  it("fails when the site is still serving an older commit, which is what a stale deploy looks like", async () => {
    reportedCommit = "0000000";
    const { code, out } = await smoke("41a9c0790e20c33e72cbe2f8c08dd3566ef7633e");
    expect(out).toContain("FAIL  /api/health did not report commit 41a9c07 in production");
    expect(code).toBe(1);
    reportedCommit = "41a9c07";
  });

  it("fails when what is live is not the production environment", async () => {
    reportedEnv = "preview";
    const { code, out } = await smoke("41a9c0790e20c33e72cbe2f8c08dd3566ef7633e");
    expect(out).toContain("FAIL  /api/health");
    expect(code).toBe(1);
    reportedEnv = "production";
  });

  it("fails when the security headers are missing", async () => {
    dropHeaders = true;
    const { code, out } = await smoke("41a9c0790e20c33e72cbe2f8c08dd3566ef7633e");
    expect(out).toContain("FAIL  sends a Content-Security-Policy that forbids framing");
    expect(out).toContain("FAIL  sends HSTS");
    expect(code).toBe(1);
    dropHeaders = false;
  });

  it.each([404, 401])("accepts an admin page that is switched off (404) or asks for a password (401): it answered %s", async (status) => {
    adminStatus = status;
    const { code, out } = await smoke(undefined);
    expect(out).toContain("the admin page is not open to the public");
    expect(code).toBe(0);
    adminStatus = 404;
  });

  it.each([200, 500, 302])("fails when the admin page answers %s without a password", async (status) => {
    adminStatus = status;
    const { code, out } = await smoke(undefined);
    expect(out).toContain(`FAIL  the admin page is not open to the public (got HTTP ${status}, expected 401 or 404)`);
    expect(code).toBe(1);
    adminStatus = 404;
  });

  it("checks any commit when none is expected, and refuses to run without a host", async () => {
    expect((await smoke(undefined)).code).toBe(0);
    const noHost = await smoke(undefined, []);
    expect(noHost.code).not.toBe(0);
    expect(noHost.out).toContain("usage: scripts/smoke-test.sh <host>");
  });
});
