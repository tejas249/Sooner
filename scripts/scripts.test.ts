import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The command-line scripts run as TypeScript directly on Node, which needs every relative import to carry its .ts extension.
// TypeScript's own checks no longer insist on that (the website needs a bundler-style config), so this test starts each
// script for real. A missing extension shows up as a module error; a healthy script gets as far as complaining about the
// flag it was given.
describe.each(["poll-local", "detect-ats", "check-feeds", "db-migrate", "db-seed", "build-worker"])("scripts/%s.ts", (name) => {
  it("loads, and fails only because of the bad flag we pass it", () => {
    const result = spawnSync(process.execPath, [`scripts/${name}.ts`, "--no-such-flag"], { encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Unknown option '--no-such-flag'/);
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ERR_UNKNOWN_FILE_EXTENSION/);
    expect(result.status).toBe(1);
  });
});
