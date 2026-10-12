import {
  agoLabel,
  boardState,
  formatSeconds,
  isHeldBack,
  nextPollLabel,
  type BoardState,
  type HealthBoard,
} from "../core/health.ts";

/**
 * What the admin page shows for a board, worked out from the health data. Plain strings and numbers only: nothing here is
 * rendered as HTML by this module, and nothing provider-controlled is trusted (the page escapes it like all text).
 */

export interface BoardRowView {
  id: string;
  name: string;
  /** "greenhouse:airbnb" */
  source: string;
  state: BoardState;
  stateLabel: string;
  /** Needs a human's eye: a fault, a feed that changed shape, a board that vanished, or a drop that is held back. */
  attention: boolean;
  priority: boolean;
  openRoles: number;
  onStrike: number;
  lastPolled: string;
  nextPoll: string;
  interval: string;
  failures: number;
  /** The most useful single sentence about why the board is in this state, or null when there is nothing to add. */
  note: string | null;
  canPoll: boolean;
  canPause: boolean;
  canResume: boolean;
}

const STATE_LABEL: Record<BoardState, string> = {
  ok: "OK",
  waiting: "Waiting",
  failing: "Failing",
  degraded: "Degraded",
  "format-changed": "Format changed",
  gone: "Gone",
  paused: "Off",
};

/** Most urgent first, so the page opens on what needs doing. */
const URGENCY: Record<BoardState, number> = {
  "format-changed": 0,
  gone: 1,
  degraded: 2,
  failing: 3,
  waiting: 4,
  ok: 5,
  paused: 6,
};

export function boardRowView(board: HealthBoard, now: Date): BoardRowView {
  const state = boardState(board);
  const heldBack = board.active && isHeldBack(board);
  const attention = state === "format-changed" || state === "gone" || state === "degraded" || state === "failing" || heldBack;

  let note: string | null = null;
  if (heldBack) note = `${board.onStrike} of ${board.openRoles} roles vanished at once; closing is held back`;
  else if (state === "gone" || state === "paused") note = board.deactivatedReason;
  else if (state === "failing" || state === "degraded" || state === "format-changed") note = board.lastError;

  return {
    id: board.id,
    name: board.name,
    source: `${board.provider}:${board.token}`,
    state,
    stateLabel: STATE_LABEL[state],
    attention,
    priority: board.priority,
    openRoles: board.openRoles,
    onStrike: board.onStrike,
    lastPolled: agoLabel(board.lastPolledAt, now),
    nextPoll: nextPollLabel(board, now),
    interval: board.active ? formatSeconds(board.pollIntervalSec) : "—",
    failures: board.consecutiveFailures,
    note,
    canPoll: board.active,
    canPause: board.active,
    canResume: !board.active,
  };
}

/** The rows in the order the page shows them: what needs attention first, then by company. */
export function boardRows(boards: readonly HealthBoard[], now: Date): BoardRowView[] {
  return boards
    .map((board) => boardRowView(board, now))
    .sort((a, b) => Number(b.attention) - Number(a.attention) || URGENCY[a.state] - URGENCY[b.state] || a.name.localeCompare(b.name));
}
