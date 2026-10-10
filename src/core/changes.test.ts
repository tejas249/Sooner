import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  confirmPending,
  detectionDelaySec,
  emptyBoardState,
  type BoardState,
  type JobEvent,
} from "./changes.ts";
import { deepFreeze, job, jobs, many, minutes } from "./test-utils.ts";

const types = (events: JobEvent[]) => events.map((e) => `${e.type}:${e.job.externalId}`);
const find = (state: BoardState, id: string) => state.jobs.find((j) => j.externalId === id);

/** A board that was baselined at minute 0 with these roles. */
const baselined = (...ids: string[]) => applySnapshot(emptyBoardState(), jobs(...ids), minutes(0)).state;

describe("the first poll is a baseline", () => {
  const result = applySnapshot(emptyBoardState(), jobs("a", "b"), minutes(0));

  it("records every role and announces none of them", () => {
    expect(result.events).toEqual([]);
    expect(result.state.jobs.map((j) => [j.externalId, j.baseline, j.status])).toEqual([
      ["a", true, "open"],
      ["b", true, "open"],
    ]);
  });

  it("remembers when it happened, even for an empty board", () => {
    expect(result.state.baselinedAt).toBe(minutes(0).toISOString());
    expect(applySnapshot(emptyBoardState(), [], minutes(5)).state.baselinedAt).toBe(minutes(5).toISOString());
  });

  it("makes roles that appear later alertable, because they are not baseline", () => {
    const later = applySnapshot(applySnapshot(emptyBoardState(), [], minutes(0)).state, jobs("x"), minutes(5));
    expect(types(later.events)).toEqual(["appeared:x"]);
    expect(find(later.state, "x")?.baseline).toBe(false);
  });
});

describe("a new role", () => {
  it("appears once and is then just part of the board", () => {
    const first = applySnapshot(baselined("a"), jobs("a", "b"), minutes(5));
    expect(types(first.events)).toEqual(["appeared:b"]);
    expect(find(first.state, "b")).toMatchObject({ firstSeenAt: minutes(5).toISOString(), baseline: false, status: "open" });

    const again = applySnapshot(first.state, jobs("a", "b"), minutes(10));
    expect(again.events).toEqual([]);
  });

  it("ignores a repeated ID inside one snapshot", () => {
    const result = applySnapshot(baselined("a"), [job("a"), job("n"), job("n", { title: "Other" })], minutes(5));
    expect(types(result.events)).toEqual(["appeared:n"]);
    expect(find(result.state, "n")?.title).toBe("Role n");
  });
});

describe("an edited role", () => {
  it("reports what changed, with the old and new value", () => {
    const state = baselined("a");
    const edited = applySnapshot(state, [job("a", { title: "Staff Engineer", location: "Berlin", remote: false })], minutes(5));
    expect(types(edited.events)).toEqual(["updated:a"]);
    const event = edited.events[0];
    expect(event?.type === "updated" && event.changes).toEqual([
      { field: "title", from: "Role a", to: "Staff Engineer" },
      { field: "location", from: "Remote", to: "Berlin" },
      { field: "remote", from: true, to: false },
    ]);
    expect(find(edited.state, "a")).toMatchObject({ title: "Staff Engineer", location: "Berlin", remote: false });
  });

  it("stays quiet when only the provider's own dates move", () => {
    const state = baselined("a");
    const result = applySnapshot(
      state,
      [job("a", { postedAt: "2026-10-07T00:00:00.000Z", sourceUpdatedAt: "2026-10-08T11:59:00.000Z" })],
      minutes(5),
    );
    expect(result.events).toEqual([]);
    expect(find(result.state, "a")?.sourceUpdatedAt).toBe("2026-10-08T11:59:00.000Z"); // still recorded
  });
});

describe("a role that goes missing", () => {
  it("is not closed the first time. It starts a countdown", () => {
    const result = applySnapshot(baselined("a", "b", "c"), jobs("a", "b"), minutes(5));
    expect(result.events).toEqual([]);
    expect(result.suspicious).toBeNull();
    expect(result.onStrike.map((s) => [s.job.externalId, s.strikes, s.needed])).toEqual([["c", 1, 2]]);
    expect(find(result.state, "c")).toMatchObject({
      status: "open",
      missedPolls: 1,
      missedSince: minutes(5).toISOString(),
    });
  });

  it("is closed when it is missing again at least two minutes after it first went missing", () => {
    const first = applySnapshot(baselined("a", "b", "c"), jobs("a", "b"), minutes(5));
    const second = applySnapshot(first.state, jobs("a", "b"), minutes(7));
    expect(types(second.events)).toEqual(["closed:c"]);
    const closed = second.events[0];
    expect(closed?.type === "closed" && closed.strikes).toBe(2);
    expect(find(second.state, "c")).toMatchObject({ status: "closed", closedAt: minutes(7).toISOString() });
    expect(second.onStrike).toEqual([]);
  });

  it("is not closed by two misses that are less than two minutes apart", () => {
    const first = applySnapshot(baselined("a", "b", "c"), jobs("a", "b"), minutes(5));
    const second = applySnapshot(first.state, jobs("a", "b"), minutes(5.5));
    expect(second.events).toEqual([]);
    expect(find(second.state, "c")).toMatchObject({ status: "open", missedPolls: 2 });
    const third = applySnapshot(second.state, jobs("a", "b"), minutes(7.5));
    expect(types(third.events)).toEqual(["closed:c"]);
  });

  it("is never closed if it comes back before the confirmation", () => {
    const first = applySnapshot(baselined("a", "b", "c"), jobs("a", "b"), minutes(5));
    const back = applySnapshot(first.state, jobs("a", "b", "c"), minutes(7));
    expect(back.events).toEqual([]);
    expect(find(back.state, "c")).toMatchObject({ status: "open", missedPolls: 0, missedSince: null });
    // and the countdown starts over rather than carrying the old miss
    const missAgain = applySnapshot(back.state, jobs("a", "b"), minutes(9));
    expect(missAgain.events).toEqual([]);
    expect(find(missAgain.state, "c")?.missedPolls).toBe(1);
  });

  it("records how long the role was open, from the provider's date", () => {
    const state = applySnapshot(
      emptyBoardState(),
      [job("a", { postedAt: "2026-09-08T12:00:00.000Z" }), job("b")],
      minutes(0),
    ).state;
    const first = applySnapshot(state, jobs("b"), minutes(5));
    const second = applySnapshot(first.state, jobs("b"), minutes(10));
    const closed = second.events[0];
    expect(closed?.type === "closed" && closed.openDays).toBe(30);
  });

  it("counts from when we first saw the role if the provider gave no date", () => {
    const state = applySnapshot(emptyBoardState(), [job("a", { postedAt: null }), job("b")], minutes(0)).state;
    const first = applySnapshot(state, jobs("b"), minutes(5));
    const second = applySnapshot(first.state, jobs("b"), minutes(10));
    const closed = second.events[0];
    expect(closed?.type === "closed" && closed.openDays).toBe(0);
  });
});

describe("a closed role that returns", () => {
  const closedState = () => {
    const first = applySnapshot(baselined("a", "b"), jobs("b"), minutes(5));
    return applySnapshot(first.state, jobs("b"), minutes(10)).state;
  };

  it("is reopened with its history intact", () => {
    const result = applySnapshot(closedState(), jobs("a", "b"), minutes(60));
    expect(types(result.events)).toEqual(["reopened:a"]);
    expect(find(result.state, "a")).toMatchObject({
      status: "open",
      closedAt: null,
      reopenCount: 1,
      missedPolls: 0,
      firstSeenAt: minutes(0).toISOString(),
    });
  });

  it("takes the feed's current values, so the next identical poll is not an edit", () => {
    const back = applySnapshot(closedState(), [job("a", { title: "Renamed" }), job("b")], minutes(60));
    expect(find(back.state, "a")?.title).toBe("Renamed");
    const next = applySnapshot(back.state, [job("a", { title: "Renamed" }), job("b")], minutes(65));
    expect(next.events).toEqual([]);
  });
});

describe("many roles vanishing at once", () => {
  it("needs three misses over twenty minutes, and says so", () => {
    const state = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    const keep = many(5); // r1..r5 stay, r6..r10 vanish: half the board

    const first = applySnapshot(state, keep, minutes(10));
    expect(first.suspicious).toEqual({ open: 10, missing: 5 });
    expect(first.onStrike.every((s) => s.needed === 3)).toBe(true);

    const second = applySnapshot(first.state, keep, minutes(15));
    expect(second.events).toEqual([]); // two misses are not enough here

    const third = applySnapshot(second.state, keep, minutes(25));
    expect(third.events).toEqual([]); // three misses, but only 15 minutes since the first one

    const fourth = applySnapshot(third.state, keep, minutes(30));
    expect(fourth.events.map((e) => e.type)).toEqual(Array(5).fill("closed"));
  });

  it("still waits twenty minutes even when three misses come quickly", () => {
    const state = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    const keep = many(5);
    let current = state;
    for (const at of [10, 11, 12, 13]) {
      const result = applySnapshot(current, keep, minutes(at));
      expect(result.events).toEqual([]);
      current = result.state;
    }
    expect(applySnapshot(current, keep, minutes(30)).events).toHaveLength(5);
  });

  it("treats an empty list as suspicious, whatever the board's size", () => {
    for (const size of [1, 3, 10]) {
      const state = applySnapshot(emptyBoardState(), many(size), minutes(0)).state;
      const empty = applySnapshot(state, [], minutes(5));
      expect(empty.suspicious).toEqual({ open: size, missing: size });
      expect(empty.events).toEqual([]);
    }
  });

  it("does not let new arrivals in the same snapshot hide a mass disappearance", () => {
    const state = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    // 4 of 10 vanish (40%) while 10 new roles appear. Counting the newcomers would dilute it to 4 of 20.
    const result = applySnapshot(state, [...many(6), ...many(10, 100)], minutes(5));
    expect(result.suspicious).toEqual({ open: 10, missing: 4 });
    expect(types(result.events).filter((e) => e.startsWith("appeared"))).toHaveLength(10);
  });

  it("uses 40% of at least five open roles as the line", () => {
    const hundred = applySnapshot(emptyBoardState(), many(100), minutes(0)).state;
    expect(applySnapshot(hundred, many(61), minutes(5)).suspicious).toBeNull(); // 39 of 100
    expect(applySnapshot(hundred, many(60), minutes(5)).suspicious).toEqual({ open: 100, missing: 40 });

    const four = applySnapshot(emptyBoardState(), many(4), minutes(0)).state;
    expect(applySnapshot(four, many(2), minutes(5)).suspicious).toBeNull(); // too few roles to call it a pattern
    const five = applySnapshot(emptyBoardState(), many(5), minutes(0)).state;
    expect(applySnapshot(five, many(3), minutes(5)).suspicious).toEqual({ open: 5, missing: 2 });
  });
});

describe("a 304 while roles are on strike", () => {
  it("counts as the next miss, because the list has not changed since the poll that dropped them", () => {
    const first = applySnapshot(baselined("a", "b", "c"), jobs("a", "b"), minutes(5));
    const confirmed = confirmPending(first.state, minutes(7));
    expect(types(confirmed.events)).toEqual(["closed:c"]);
    expect(find(confirmed.state, "c")?.status).toBe("closed");
  });

  it("does not close early, and leaves every other role alone", () => {
    const first = applySnapshot(baselined("a", "b", "c"), jobs("a", "b"), minutes(5));
    const tooSoon = confirmPending(first.state, minutes(6));
    expect(tooSoon.events).toEqual([]);
    expect(tooSoon.onStrike.map((s) => [s.job.externalId, s.strikes])).toEqual([["c", 2]]);
    expect(find(tooSoon.state, "a")?.lastSeenAt).toBe(minutes(5).toISOString()); // not touched by a 304
  });

  it("changes nothing when no role is on strike", () => {
    const state = baselined("a", "b");
    const result = confirmPending(state, minutes(30));
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it("keeps the stricter rule after a mass disappearance", () => {
    const state = applySnapshot(emptyBoardState(), many(10), minutes(0)).state;
    const first = applySnapshot(state, many(5), minutes(10));
    const second = confirmPending(first.state, minutes(15));
    expect(second.suspicious).toEqual({ open: 10, missing: 5 });
    expect(second.events).toEqual([]);
    expect(confirmPending(second.state, minutes(31)).events).toHaveLength(5);
  });

  it("closes the roles of an emptied board only after three confirmations over twenty minutes", () => {
    const state = baselined("a");
    const first = applySnapshot(state, [], minutes(10));
    const second = confirmPending(first.state, minutes(20));
    expect(second.events).toEqual([]);
    expect(types(confirmPending(second.state, minutes(30)).events)).toEqual(["closed:a"]);
  });
});

describe("determinism and safety", () => {
  it("gives the same result however the snapshot is ordered", () => {
    const state = baselined("a", "b", "c", "d");
    const forward = applySnapshot(state, [job("x"), job("a", { title: "T" }), job("b")], minutes(5));
    const backward = applySnapshot(state, [job("b"), job("a", { title: "T" }), job("x")], minutes(5));
    expect(backward).toEqual(forward);
  });

  it("sorts events by role ID", () => {
    const result = applySnapshot(baselined("z"), [job("z"), job("m"), job("b")], minutes(5));
    expect(result.events.map((e) => e.job.externalId)).toEqual(["b", "m"]);
  });

  it("never changes its inputs", () => {
    const state = deepFreeze(baselined("a", "b", "c"));
    const snapshot = deepFreeze(jobs("a", "b", "n"));
    expect(() => applySnapshot(state, snapshot, minutes(5))).not.toThrow();
    const struck = deepFreeze(applySnapshot(state, snapshot, minutes(5)).state);
    expect(() => confirmPending(struck, minutes(8))).not.toThrow();
  });

  it("never deletes: every role we have seen stays in the state", () => {
    let state = baselined("a", "b", "c");
    for (const [at, ids] of [[5, ["a"]], [10, ["a"]], [15, []], [20, []], [40, []]] as const) {
      state = applySnapshot(state, jobs(...ids), minutes(at)).state;
    }
    expect(state.jobs.map((j) => j.externalId)).toEqual(["a", "b", "c"]);
  });
});

describe("detectionDelaySec", () => {
  const seen = (postedAt: string | null) => {
    const state = applySnapshot(applySnapshot(emptyBoardState(), [], minutes(0)).state, [job("a", { postedAt })], minutes(10));
    return find(state.state, "a");
  };

  it("is how long after the provider's date we first saw the role", () => {
    const row = seen(minutes(4).toISOString());
    expect(row && detectionDelaySec(row)).toBe(6 * 60);
  });

  it("is null when the feed has no date, or a date later than our clock", () => {
    const undated = seen(null);
    expect(undated && detectionDelaySec(undated)).toBeNull();
    const future = seen(minutes(11).toISOString());
    expect(future && detectionDelaySec(future)).toBeNull();
  });
});
