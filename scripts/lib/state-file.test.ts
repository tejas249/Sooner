import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySnapshot, emptyBoardState } from "../../src/core/changes.ts";
import { job, jobs, minutes } from "../../src/core/test-utils.ts";
import { emptyPollState, loadPollState, savePollState, type PollState } from "./state-file.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sooner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the saved poll state", () => {
  it("starts empty when nothing has been saved", () => {
    expect(loadPollState(join(dir, "missing.json"))).toEqual(emptyPollState());
  });

  it("survives a save and a load unchanged, including roles on strike and closed roles", () => {
    const base = applySnapshot(emptyBoardState(), [...jobs("a", "b", "c"), job("d", { remote: null, postedAt: null })], minutes(0)).state;
    const struck = applySnapshot(base, jobs("a", "b"), minutes(5)).state;
    const closed = applySnapshot(struck, jobs("a", "b"), minutes(9)).state;
    const state: PollState = {
      version: 1,
      boards: {
        "greenhouse:acme": { etag: 'W/"x"', polledAt: minutes(9).toISOString(), state: closed },
        "lever:beta": { etag: null, polledAt: null, state: struck },
      },
    };
    const path = join(dir, "nested", "state.json");
    savePollState(path, state);
    expect(loadPollState(path)).toEqual(state);
  });

  it("leaves no temporary file behind", () => {
    savePollState(join(dir, "state.json"), emptyPollState());
    expect(() => readFileSync(join(dir, "state.json.tmp"))).toThrow();
  });

  it("refuses a file that is not what a run would have written, and says how to recover", () => {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ version: 2, boards: {} }));
    expect(() => loadPollState(path)).toThrow(/not in the expected format/);
    expect(() => loadPollState(path)).toThrow(/--fresh/);
    writeFileSync(path, "{ not json");
    expect(() => loadPollState(path)).toThrow(/not valid JSON/);
  });
});
