import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applySnapshot, emptyBoardState, type BoardState } from "./changes.ts";
import { job, minutes } from "./test-utils.ts";
import type { NormalizedJob } from "./types.ts";

// A small alphabet of IDs makes overlaps between snapshots (the interesting cases) very common.
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

const arbSnapshot: fc.Arbitrary<NormalizedJob[]> = fc
  .dictionary(
    fc.constantFrom(...IDS),
    fc.record({
      title: fc.constantFrom("Engineer", "Designer", "Manager"),
      location: fc.constantFrom("Remote", "Berlin", null),
    }),
  )
  .map((byId) => Object.entries(byId).map(([id, fields]) => job(id, fields)));

/** A snapshot together with the same roles in a different order. */
const arbSnapshotAndPermutation = arbSnapshot.chain((snapshot) =>
  fc
    .shuffledSubarray(snapshot, { minLength: snapshot.length, maxLength: snapshot.length })
    .map((shuffled) => ({ snapshot, shuffled })),
);

interface Step {
  snapshot: NormalizedJob[];
  gapMinutes: number;
}
type History = Step[];

const arbHistory: fc.Arbitrary<History> = fc.array(
  fc.record({ snapshot: arbSnapshot, gapMinutes: fc.integer({ min: 0, max: 45 }) }),
  { maxLength: 8 },
);

/** Replays a history from an empty board; returns the state and the clock after the last step. */
function replay(history: History): { state: BoardState; clock: number } {
  let state = emptyBoardState();
  let clock = 0;
  for (const { snapshot, gapMinutes } of history) {
    clock += gapMinutes;
    state = applySnapshot(state, snapshot, minutes(clock)).state;
  }
  return { state, clock };
}

const ids = (state: BoardState) => state.jobs.map((j) => j.externalId);
const runs = { numRuns: 300 };

describe("change detection, for any sequence of snapshots", () => {
  it("applying the same snapshot twice announces nothing new the second time", () => {
    fc.assert(
      fc.property(arbHistory, arbSnapshot, fc.integer({ min: 0, max: 45 }), (history, snapshot, gap) => {
        const { state, clock } = replay(history);
        const once = applySnapshot(state, snapshot, minutes(clock + gap));
        const twice = applySnapshot(once.state, snapshot, minutes(clock + gap + 1));
        expect(twice.events.filter((e) => e.type !== "closed")).toEqual([]);
      }),
      runs,
    );
  });

  it("the baseline poll announces nothing, whatever the board holds", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        const result = applySnapshot(emptyBoardState(), snapshot, minutes(0));
        expect(result.events).toEqual([]);
        expect(result.onStrike).toEqual([]);
        expect(result.suspicious).toBeNull();
      }),
      runs,
    );
  });

  it("the order of roles inside a snapshot never changes the result", () => {
    fc.assert(
      fc.property(arbHistory, arbSnapshotAndPermutation, fc.integer({ min: 0, max: 45 }), (history, { snapshot, shuffled }, gap) => {
        const { state, clock } = replay(history);
        const a = applySnapshot(state, snapshot, minutes(clock + gap));
        const b = applySnapshot(state, shuffled, minutes(clock + gap));
        expect(b).toEqual(a);
      }),
      runs,
    );
  });

  it("a role that was listed in the previous poll is never closed by the next one", () => {
    fc.assert(
      fc.property(arbHistory, arbSnapshot, arbSnapshot, fc.integer({ min: 0, max: 120 }), (history, first, second, gap) => {
        const { state, clock } = replay(history);
        const afterFirst = applySnapshot(state, first, minutes(clock + 1));
        const afterSecond = applySnapshot(afterFirst.state, second, minutes(clock + 1 + gap));
        const listedBefore = new Set(first.map((j) => j.externalId));
        for (const event of afterSecond.events) {
          if (event.type === "closed") expect(listedBefore.has(event.job.externalId)).toBe(false);
        }
      }),
      runs,
    );
  });

  it("an empty list never closes anything within twenty minutes", () => {
    fc.assert(
      fc.property(arbSnapshot, fc.array(fc.integer({ min: 0, max: 19 }), { minLength: 1, maxLength: 6 }), (snapshot, offsets) => {
        let state = applySnapshot(emptyBoardState(), snapshot, minutes(0)).state;
        for (const offset of [...offsets].sort((a, b) => a - b)) {
          const result = applySnapshot(state, [], minutes(offset + 1));
          expect(result.events).toEqual([]);
          state = result.state;
        }
      }),
      runs,
    );
  });

  it("a role that returns before it is closed is never closed", () => {
    fc.assert(
      fc.property(arbHistory, fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), (history, gapA, gapB) => {
        const { state, clock } = replay(history);
        const listed = state.jobs.filter((j) => j.status === "open").map((j) => job(j.externalId, { title: j.title, location: j.location }));
        // Everything open vanishes once, then everything comes back.
        const gone = applySnapshot(state, [], minutes(clock + gapA));
        const back = applySnapshot(gone.state, listed, minutes(clock + gapA + gapB));
        expect(back.events.filter((e) => e.type === "closed")).toEqual([]);
        for (const row of back.state.jobs) {
          if (listed.some((j) => j.externalId === row.externalId)) expect(row.status).toBe("open");
        }
      }),
      runs,
    );
  });

  it("keeps its books straight: no role is both open and closed, none is ever deleted, IDs are unique and sorted", () => {
    fc.assert(
      fc.property(arbHistory, (history) => {
        let state = emptyBoardState();
        let clock = 0;
        const everSeen = new Set<string>();
        for (const { snapshot, gapMinutes } of history) {
          clock += gapMinutes;
          state = applySnapshot(state, snapshot, minutes(clock)).state;
          for (const j of snapshot) everSeen.add(j.externalId);
        }
        expect(ids(state)).toEqual([...ids(state)].sort());
        expect(new Set(ids(state)).size).toBe(state.jobs.length);
        expect(new Set(ids(state))).toEqual(everSeen);
        for (const row of state.jobs) {
          if (row.status === "open") expect(row.closedAt).toBeNull();
          else expect(row.closedAt).not.toBeNull();
          if (row.missedPolls === 0) expect(row.missedSince).toBeNull();
          else expect(row.missedSince).not.toBeNull();
        }
      }),
      runs,
    );
  });

  it("every event matches what happened to the role", () => {
    fc.assert(
      fc.property(arbHistory, arbSnapshot, fc.integer({ min: 0, max: 60 }), (history, snapshot, gap) => {
        const { state, clock } = replay(history);
        const before = new Map(state.jobs.map((j) => [j.externalId, j]));
        const result = applySnapshot(state, snapshot, minutes(clock + gap));
        const after = new Map(result.state.jobs.map((j) => [j.externalId, j]));
        for (const event of result.events) {
          const id = event.job.externalId;
          const was = before.get(id);
          const now = after.get(id);
          switch (event.type) {
            case "appeared":
              expect(was).toBeUndefined();
              expect(now?.baseline).toBe(false);
              break;
            case "reopened":
              expect(was?.status).toBe("closed");
              expect(now?.status).toBe("open");
              break;
            case "closed":
              expect(was?.status).toBe("open");
              expect(now?.status).toBe("closed");
              break;
            case "updated":
              expect(was?.status).toBe("open");
              expect(event.changes.length).toBeGreaterThan(0);
              break;
          }
        }
      }),
      runs,
    );
  });
});
