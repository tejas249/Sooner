import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applySnapshot, confirmPending, emptyBoardState, type BoardState, type TrackedJob } from "./changes.ts";
import { eventRecords, planWrites, strikesOf } from "./persist.ts";
import { deepFreeze, job, jobs, many, minutes } from "./test-utils.ts";
import type { NormalizedJob } from "./types.ts";

const baseline = (...ids: string[]) => applySnapshot(emptyBoardState(), jobs(...ids), minutes(0)).state;

describe("planWrites", () => {
  it("inserts every role on the first poll", () => {
    const next = baseline("a", "b");
    expect(planWrites(emptyBoardState(), next)).toEqual({ inserts: next.jobs, updates: [], touches: [] });
  });

  it("only touches roles that were seen again and did not change", () => {
    const prev = baseline("a", "b", "c");
    const next = applySnapshot(prev, jobs("a", "b", "c"), minutes(10)).state;
    expect(planWrites(prev, next)).toEqual({ inserts: [], updates: [], touches: ["a", "b", "c"] });
  });

  it("updates a role whose title changed and touches the rest", () => {
    const prev = baseline("a", "b");
    const next = applySnapshot(prev, [job("a", { title: "New title" }), job("b")], minutes(10)).state;
    const plan = planWrites(prev, next);
    expect(plan.updates.map((j) => [j.externalId, j.title])).toEqual([["a", "New title"]]);
    expect(plan.touches).toEqual(["b"]);
    expect(plan.inserts).toEqual([]);
  });

  it("inserts a new role and leaves a closed one alone", () => {
    let state = baseline("a", "gone");
    state = applySnapshot(state, jobs("a"), minutes(5)).state; // gone: first miss
    state = applySnapshot(state, jobs("a"), minutes(10)).state; // gone: closed
    expect(state.jobs.find((j) => j.externalId === "gone")?.status).toBe("closed");

    const next = applySnapshot(state, jobs("a", "fresh"), minutes(15)).state;
    const plan = planWrites(state, next);
    expect(plan.inserts.map((j) => j.externalId)).toEqual(["fresh"]);
    expect(plan.touches).toEqual(["a"]);
    expect(plan.updates).toEqual([]); // the closed role is not rewritten every poll
  });

  it("updates a role that goes on strike, closes, and reopens", () => {
    let state = baseline("a", "b");
    let next = applySnapshot(state, jobs("a"), minutes(5)).state;
    expect(planWrites(state, next).updates.map((j) => [j.externalId, j.missedPolls])).toEqual([["b", 1]]);
    state = next;
    next = applySnapshot(state, jobs("a"), minutes(10)).state;
    expect(planWrites(state, next).updates.map((j) => [j.externalId, j.status])).toEqual([["b", "closed"]]);
    state = next;
    next = applySnapshot(state, jobs("a", "b"), minutes(15)).state;
    expect(planWrites(state, next).updates.map((j) => [j.externalId, j.status, j.reopenCount])).toEqual([["b", "open", 1]]);
  });

  it("writes nothing for a 304 with nothing on strike", () => {
    const prev = baseline("a", "b");
    expect(planWrites(prev, confirmPending(prev, minutes(10)).state)).toEqual({ inserts: [], updates: [], touches: [] });
  });

  it("does not change the states it is given", () => {
    const prev = deepFreeze(baseline("a", "b"));
    const next = deepFreeze(applySnapshot(prev, jobs("a", "c"), minutes(10)).state);
    expect(() => planWrites(prev, next)).not.toThrow();
  });
});

// A small alphabet of IDs makes overlaps between snapshots, the interesting cases, very common.
const IDS = ["a", "b", "c", "d", "e", "f"] as const;
const arbSnapshot: fc.Arbitrary<NormalizedJob[]> = fc
  .dictionary(
    fc.constantFrom(...IDS),
    fc.record({ title: fc.constantFrom("Engineer", "Designer"), location: fc.constantFrom("Remote", "Berlin", null) }),
  )
  .map((byId) => Object.entries(byId).map(([id, fields]) => job(id, fields)));
const arbSteps = fc.array(fc.record({ snapshot: arbSnapshot, gap: fc.integer({ min: 0, max: 30 }), is304: fc.boolean() }), { maxLength: 8 });

/** Applies a plan to a copy of the old rows, the way the database layer does. */
function apply(prev: BoardState, next: BoardState, plan: ReturnType<typeof planWrites>): TrackedJob[] {
  const rows = new Map(prev.jobs.map((j) => [j.externalId, { ...j }]));
  const nextById = new Map(next.jobs.map((j) => [j.externalId, j]));
  for (const job of plan.inserts) rows.set(job.externalId, { ...job });
  for (const job of plan.updates) rows.set(job.externalId, { ...job });
  for (const id of plan.touches) {
    const row = rows.get(id) as TrackedJob;
    rows.set(id, { ...row, lastSeenAt: (nextById.get(id) as TrackedJob).lastSeenAt });
  }
  return [...rows.values()].sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
}

describe("planWrites, for any sequence of polls", () => {
  it("turns the old rows into exactly the new state", () => {
    fc.assert(
      fc.property(arbSteps, (steps) => {
        let state = emptyBoardState();
        let clock = 0;
        for (const { snapshot, gap, is304 } of steps) {
          clock += gap;
          const result = is304 && state.baselinedAt !== null ? confirmPending(state, minutes(clock)) : applySnapshot(state, snapshot, minutes(clock));
          const plan = planWrites(state, result.state);
          expect(apply(state, result.state, plan)).toEqual(result.state.jobs);
          state = result.state;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never drops a role: the reducer only ever adds rows or changes them", () => {
    fc.assert(
      fc.property(arbSteps, (steps) => {
        let state = emptyBoardState();
        let clock = 0;
        for (const { snapshot, gap } of steps) {
          clock += gap;
          const next = applySnapshot(state, snapshot, minutes(clock)).state;
          const kept = new Set(next.jobs.map((j) => j.externalId));
          for (const old of state.jobs) expect(kept.has(old.externalId)).toBe(true);
          state = next;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("eventRecords", () => {
  it("records no evidence for an appearance", () => {
    const prev = baseline("a");
    const result = applySnapshot(prev, jobs("a", "b"), minutes(10));
    expect(eventRecords(result, prev)).toEqual([{ externalId: "b", type: "appeared", detail: {} }]);
  });

  it("records which fields changed", () => {
    const prev = baseline("a");
    const result = applySnapshot(prev, [job("a", { title: "Staff Role", location: "Berlin" })], minutes(10));
    const [record] = eventRecords(result, prev);
    expect(record?.type).toBe("updated");
    expect(record?.detail).toEqual({
      changes: [
        { field: "title", from: "Role a", to: "Staff Role" },
        { field: "location", from: "Remote", to: "Berlin" },
      ],
    });
  });

  it("records how long a closed role was open and how many misses it took", () => {
    const prev = baseline("a", "b");
    const first = applySnapshot(prev, jobs("a"), minutes(60));
    const result = applySnapshot(first.state, jobs("a"), minutes(65));
    const [record] = eventRecords(result, first.state);
    expect(record).toEqual({ externalId: "b", type: "closed", detail: { openDays: 0, strikes: 2, suspicious: false } });
  });

  it("says when a role closed under the stricter rule for a mass disappearance", () => {
    const prev = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    let state = prev;
    let last = applySnapshot(state, many(5), minutes(10)); // half vanished at once
    expect(last.suspicious).not.toBeNull();
    state = last.state;
    last = applySnapshot(state, many(5), minutes(20));
    state = last.state;
    last = applySnapshot(state, many(5), minutes(30));
    const records = eventRecords(last, state);
    expect(records).toHaveLength(5);
    expect(records.every((r) => r.type === "closed" && r.detail["suspicious"] === true && r.detail["strikes"] === 3)).toBe(true);
  });

  it("remembers when a reopened role had closed", () => {
    let state = baseline("a", "b");
    state = applySnapshot(state, jobs("a"), minutes(5)).state;
    const closed = applySnapshot(state, jobs("a"), minutes(10));
    const reopened = applySnapshot(closed.state, jobs("a", "b"), minutes(20));
    const [record] = eventRecords(reopened, closed.state);
    expect(record?.type).toBe("reopened");
    expect(record?.detail).toEqual({ reopenCount: 1, closedAt: minutes(10).toISOString() });
  });
});

describe("strikesOf", () => {
  it("is none when nothing is waiting for a confirmation", () => {
    const prev = baseline("a");
    expect(strikesOf(applySnapshot(prev, jobs("a"), minutes(5)))).toBe("none");
  });

  it("is pending after one miss", () => {
    const prev = baseline("a", "b");
    expect(strikesOf(applySnapshot(prev, jobs("a"), minutes(5)))).toBe("pending");
  });

  it("is suspicious when half the board vanished at once", () => {
    const prev = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    expect(strikesOf(applySnapshot(prev, many(5), minutes(5)))).toBe("suspicious");
  });

  it("is none again once the last waiting role has closed", () => {
    const prev = baseline("a", "b");
    const first = applySnapshot(prev, jobs("a"), minutes(5));
    expect(strikesOf(applySnapshot(first.state, jobs("a"), minutes(10)))).toBe("none");
  });
});
