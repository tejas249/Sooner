import { describe, expect, it } from "vitest";
import { GONE_REASON, type HealthBoard } from "../core/health.ts";
import { minutes } from "../core/test-utils.ts";
import { boardRowView, boardRows } from "./admin-view.ts";

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
  lastPolledAt: minutes(57),
  lastChangedAt: null,
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

describe("boardRowView", () => {
  it("describes a healthy board in words", () => {
    expect(boardRowView(board({ priority: true }), NOW)).toEqual({
      id: "1",
      name: "Acme",
      source: "greenhouse:acme",
      state: "ok",
      stateLabel: "OK",
      attention: false,
      priority: true,
      openRoles: 40,
      onStrike: 0,
      lastPolled: "3 min ago",
      nextPoll: "in 5 min",
      interval: "30 min",
      failures: 0,
      note: null,
      canPoll: true,
      canPause: true,
      canResume: false,
    });
  });

  it("says never for a board that has not been polled", () => {
    const view = boardRowView(board({ lastPolledAt: null, baselinedAt: null }), NOW);
    expect(view).toMatchObject({ lastPolled: "never", state: "waiting", attention: false });
  });

  it("shows the last error of a failing board and asks for attention", () => {
    const view = boardRowView(board({ consecutiveFailures: 3, lastError: "HTTP 503" }), NOW);
    expect(view).toMatchObject({ state: "failing", stateLabel: "Failing", attention: true, note: "HTTP 503", failures: 3 });
  });

  it("calls a board with eight failures degraded", () => {
    expect(boardRowView(board({ consecutiveFailures: 8, lastError: "timeout" }), NOW)).toMatchObject({ state: "degraded", attention: true });
  });

  it("shows a feed that changed shape as the most serious state", () => {
    const view = boardRowView(board({ consecutiveFailures: 1, lastError: "the feed changed shape: ashby: x" }), NOW);
    expect(view).toMatchObject({ state: "format-changed", stateLabel: "Format changed", attention: true });
    expect(view.note).toContain("the feed changed shape");
  });

  it("explains a board that was switched off for 404s, and offers to switch it back on", () => {
    const view = boardRowView(board({ active: false, deactivatedReason: GONE_REASON, nextPollAt: minutes(0) }), NOW);
    expect(view).toMatchObject({ state: "gone", attention: true, nextPoll: "off", interval: "—", canPoll: false, canPause: false, canResume: true });
    expect(view.note).toMatch(/moved to another job-board provider/);
  });

  it("shows a board paused by hand as off, without asking for attention", () => {
    const view = boardRowView(board({ active: false, deactivatedReason: "paused from the admin page" }), NOW);
    expect(view).toMatchObject({ state: "paused", stateLabel: "Off", attention: false, note: "paused from the admin page", canResume: true });
  });

  it("flags roles that vanished at once and are held back, with the numbers", () => {
    const view = boardRowView(board({ openRoles: 50, onStrike: 30 }), NOW);
    expect(view).toMatchObject({ state: "ok", attention: true, onStrike: 30 });
    expect(view.note).toBe("30 of 50 roles vanished at once; closing is held back");
  });

  it("says when a board is being polled, due, or late", () => {
    expect(boardRowView(board({ claimedUntil: minutes(62) }), NOW).nextPoll).toBe("polling now");
    expect(boardRowView(board({ nextPollAt: minutes(59.5) }), NOW).nextPoll).toBe("due now");
    expect(boardRowView(board({ nextPollAt: minutes(50) }), NOW).nextPoll).toBe("overdue 10 min");
  });

  it("never lets a provider's text become anything but the text of the note", () => {
    const view = boardRowView(board({ consecutiveFailures: 1, lastError: '<img src=x onerror="alert(1)"> @everyone' }), NOW);
    expect(view.note).toBe('<img src=x onerror="alert(1)"> @everyone'); // kept as plain text for the page to escape
  });
});

describe("boardRows", () => {
  it("puts what needs attention first, the most urgent first, and then everything else by name", () => {
    const rows = boardRows(
      [
        board({ id: "1", name: "Zeta" }),
        board({ id: "2", name: "Beta", consecutiveFailures: 2, lastError: "HTTP 503" }),
        board({ id: "3", name: "Alpha" }),
        board({ id: "4", name: "Gamma", consecutiveFailures: 1, lastError: "the feed changed shape: x" }),
        board({ id: "5", name: "Delta", active: false, deactivatedReason: "paused from the admin page" }),
        board({ id: "6", name: "Eps", active: false, deactivatedReason: GONE_REASON }),
        board({ id: "7", name: "Kappa", baselinedAt: null }),
      ],
      NOW,
    );
    expect(rows.map((r) => `${r.name}:${r.state}`)).toEqual([
      "Gamma:format-changed",
      "Eps:gone",
      "Beta:failing",
      "Kappa:waiting",
      "Alpha:ok",
      "Zeta:ok",
      "Delta:paused",
    ]);
  });

  it("is empty for no boards", () => {
    expect(boardRows([], NOW)).toEqual([]);
  });
});
