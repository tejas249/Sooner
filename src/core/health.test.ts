import { describe, expect, it } from "vitest";
import {
  FORMAT_ERROR_PREFIX,
  GONE_REASON,
  THRESHOLDS,
  boardState,
  evaluateHealth,
  formatSeconds,
  isHeldBack,
  lagLabel,
  overdueSec,
  type HealthBoard,
  type Metrics,
} from "./health.ts";
import { minutes } from "./test-utils.ts";

const NOW = minutes(60);

const board = (over: Partial<HealthBoard> = {}): HealthBoard => ({
  id: "1",
  slug: "acme",
  name: "Acme",
  provider: "greenhouse",
  token: "acme",
  active: true,
  priority: false,
  nextPollAt: minutes(65),
  pollIntervalSec: 1800,
  claimedUntil: null,
  lastPolledAt: minutes(55),
  lastChangedAt: minutes(10),
  baselinedAt: minutes(0),
  consecutiveFailures: 0,
  consecutiveNotFound: 0,
  lastError: null,
  deactivatedAt: null,
  deactivatedReason: null,
  openRoles: 40,
  onStrike: 0,
  ...over,
});

const metrics = (over: Partial<Metrics> = {}): Metrics => ({ queueLagSec: 0, polls: 100, failedPolls: 0, boards: [board()], ...over });
const keys = (m: Metrics, open: string[] = []) => evaluateHealth(m, new Set(open)).map((c) => c.key);

describe("boardState", () => {
  it("is ok for a board that is polled and answering", () => {
    expect(boardState(board())).toBe("ok");
  });

  it("is waiting until the first answer that lists a role has arrived", () => {
    expect(boardState(board({ baselinedAt: null }))).toBe("waiting");
  });

  it("is failing after a failure and degraded after eight in a row", () => {
    expect(boardState(board({ consecutiveFailures: 1, lastError: "HTTP 503" }))).toBe("failing");
    expect(boardState(board({ consecutiveFailures: 7, lastError: "HTTP 503" }))).toBe("failing");
    expect(boardState(board({ consecutiveFailures: 8, lastError: "HTTP 503" }))).toBe("degraded");
  });

  it("is format-changed when the last answer was not the shape its adapter knows, whatever the failure count", () => {
    expect(boardState(board({ consecutiveFailures: 1, lastError: `${FORMAT_ERROR_PREFIX}: greenhouse: x` }))).toBe("format-changed");
    expect(boardState(board({ consecutiveFailures: 9, lastError: `${FORMAT_ERROR_PREFIX}: greenhouse: x` }))).toBe("format-changed");
  });

  it("tells a board that moved provider from one that was paused or opted out", () => {
    expect(boardState(board({ active: false, deactivatedReason: GONE_REASON }))).toBe("gone");
    expect(boardState(board({ active: false, deactivatedReason: "opt-out requested" }))).toBe("paused");
    expect(boardState(board({ active: false }))).toBe("paused");
  });

  it("looks at being switched off before anything else", () => {
    expect(boardState(board({ active: false, consecutiveFailures: 9, lastError: `${FORMAT_ERROR_PREFIX}: x` }))).toBe("paused");
  });
});

describe("overdueSec", () => {
  it("is how long past its time an active board that nobody is working on is", () => {
    expect(overdueSec(board({ nextPollAt: minutes(58) }), NOW)).toBe(120);
  });

  it("is zero for a board that is not due yet", () => {
    expect(overdueSec(board({ nextPollAt: minutes(61) }), NOW)).toBe(0);
  });

  it("is zero while a worker holds the board, and counts again once the lease has run out", () => {
    expect(overdueSec(board({ nextPollAt: minutes(50), claimedUntil: minutes(62) }), NOW)).toBe(0);
    expect(overdueSec(board({ nextPollAt: minutes(50), claimedUntil: minutes(59) }), NOW)).toBe(600);
  });

  it("is zero for a board that is switched off", () => {
    expect(overdueSec(board({ active: false, nextPollAt: minutes(0) }), NOW)).toBe(0);
  });
});

describe("isHeldBack", () => {
  it("uses the same rule as change detection: all of them, or 40% of at least five", () => {
    expect(isHeldBack({ openRoles: 10, onStrike: 4 })).toBe(true);
    expect(isHeldBack({ openRoles: 10, onStrike: 3 })).toBe(false);
    expect(isHeldBack({ openRoles: 3, onStrike: 3 })).toBe(true);
    expect(isHeldBack({ openRoles: 4, onStrike: 2 })).toBe(false);
    expect(isHeldBack({ openRoles: 0, onStrike: 0 })).toBe(false);
  });
});

describe("evaluateHealth", () => {
  it("finds nothing wrong with a healthy system", () => {
    expect(evaluateHealth(metrics())).toEqual([]);
  });

  describe("queue lag", () => {
    it("is critical over five minutes", () => {
      const [condition] = evaluateHealth(metrics({ queueLagSec: 301 }));
      expect(condition).toMatchObject({ key: "queue-lag", severity: "critical" });
      expect(condition?.detail).toContain("5 min");
    });

    it("is quiet at exactly the limit", () => {
      expect(keys(metrics({ queueLagSec: THRESHOLDS.queueLagAlarmSec }))).toEqual([]);
    });

    it("stays open until the lag is back under two minutes, so it does not flap", () => {
      expect(keys(metrics({ queueLagSec: 250 }), ["queue-lag"])).toEqual(["queue-lag"]);
      expect(keys(metrics({ queueLagSec: 119 }), ["queue-lag"])).toEqual([]);
      expect(keys(metrics({ queueLagSec: 250 }))).toEqual([]); // not raised by a lag under the alarm line
    });
  });

  describe("poll success", () => {
    it("is raised when fewer than 90% of an hour's polls succeeded", () => {
      expect(keys(metrics({ polls: 100, failedPolls: 11 }))).toEqual(["poll-success"]);
      expect(keys(metrics({ polls: 100, failedPolls: 10 }))).toEqual([]);
    });

    it("needs enough polls to mean anything", () => {
      expect(keys(metrics({ polls: 10, failedPolls: 10 }))).toEqual([]);
      expect(keys(metrics({ polls: 20, failedPolls: 20 }))).toEqual(["poll-success"]);
    });

    it("clears only above 95%", () => {
      expect(keys(metrics({ polls: 100, failedPolls: 7 }), ["poll-success"])).toEqual(["poll-success"]);
      expect(keys(metrics({ polls: 100, failedPolls: 5 }), ["poll-success"])).toEqual([]);
    });

    it("says what happened", () => {
      const [condition] = evaluateHealth(metrics({ polls: 200, failedPolls: 50 }));
      expect(condition?.detail).toBe("50 of 200 polls in the last hour failed (75.0% succeeded; healthy: over 98%).");
    });
  });

  describe("degraded boards", () => {
    const degraded = (id: string) => board({ id, slug: `b${id}`, consecutiveFailures: 8, lastError: "HTTP 503" });
    const healthy = (n: number) => Array.from({ length: n }, (_, i) => board({ id: `h${i}`, slug: `h${i}` }));

    it("is raised when more than 5% of the active boards are degraded", () => {
      expect(keys(metrics({ boards: [...healthy(38), degraded("1"), degraded("2"), degraded("3")] }))).toEqual(["degraded-boards"]);
      expect(keys(metrics({ boards: [...healthy(38), degraded("1"), degraded("2")] }))).toEqual([]);
    });

    it("does not count boards that are switched off", () => {
      const off = board({ id: "x", active: false, consecutiveFailures: 9 });
      expect(keys(metrics({ boards: [...healthy(4), off, off, off] }))).toEqual([]);
    });

    it("clears below 2%", () => {
      const boards = [...healthy(98), degraded("1"), degraded("2"), degraded("3")]; // 3%
      expect(keys(metrics({ boards }), ["degraded-boards"])).toEqual(["degraded-boards"]);
      expect(keys(metrics({ boards: [...healthy(99), degraded("1")] }), ["degraded-boards"])).toEqual([]);
    });
  });

  describe("one board", () => {
    it("is flagged when it was switched off for answering 404", () => {
      const conditions = evaluateHealth(metrics({ boards: [board({ id: "7", active: false, deactivatedReason: GONE_REASON })] }));
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toMatchObject({ key: "board:7:gone", severity: "warning", title: "Acme was switched off" });
      expect(conditions[0]?.detail).toContain("greenhouse:acme");
      expect(conditions[0]?.detail).toContain("moved to another job-board provider");
    });

    it("is not flagged for being paused or opted out: that was a person's choice", () => {
      expect(keys(metrics({ boards: [board({ active: false, deactivatedReason: "opt-out requested" })] }))).toEqual([]);
    });

    it("is flagged, as critical, when its feed changed shape", () => {
      const conditions = evaluateHealth(
        metrics({ boards: [board({ id: "9", consecutiveFailures: 2, lastError: `${FORMAT_ERROR_PREFIX}: greenhouse: unexpected response shape` })] }),
      );
      expect(conditions[0]).toMatchObject({ key: "board:9:format", severity: "critical" });
      expect(conditions[0]?.detail).toContain("unexpected response shape");
      expect(conditions[0]?.detail).toContain("Nothing was changed");
    });

    it("is flagged when so many of its roles vanished at once that closing is held back", () => {
      const conditions = evaluateHealth(metrics({ boards: [board({ id: "3", openRoles: 50, onStrike: 30 })] }));
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toMatchObject({ key: "board:3:mass-drop", severity: "warning", title: "Acme: 30 of 50 roles vanished at once" });
    });

    it("is not flagged for a few roles on their first miss", () => {
      expect(keys(metrics({ boards: [board({ openRoles: 50, onStrike: 3 })] }))).toEqual([]);
    });

    it("can have several problems, each with its own key", () => {
      const b = board({ id: "5", openRoles: 20, onStrike: 20, consecutiveFailures: 1, lastError: `${FORMAT_ERROR_PREFIX}: x` });
      expect(keys(metrics({ boards: [b] })).sort()).toEqual(["board:5:format", "board:5:mass-drop"]);
    });
  });

  it("reports several problems at once", () => {
    expect(keys(metrics({ queueLagSec: 900, polls: 100, failedPolls: 40 })).sort()).toEqual(["poll-success", "queue-lag"]);
  });
});

describe("formatSeconds", () => {
  it.each([
    [0, "0 s"],
    [45, "45 s"],
    [89, "89 s"],
    [90, "2 min"],
    [300, "5 min"],
    [4000, "67 min"],
    [5400, "1 h 30 min"],
    [7200, "2 h"],
    [9000, "2 h 30 min"],
  ])("%s seconds is %s", (sec, text) => {
    expect(formatSeconds(sec)).toBe(text);
  });
});

describe("lagLabel", () => {
  it.each([
    [null, "—"],
    [0, "under a second"],
    [999, "under a second"],
    [1000, "1 s"],
    [38_400, "38 s"],
    [59_999, "60 s"],
    [300_000, "5 min"],
    [3_600_000, "60 min"],
  ])("%s milliseconds is %s", (ms, text) => {
    expect(lagLabel(ms)).toBe(text);
  });
});
