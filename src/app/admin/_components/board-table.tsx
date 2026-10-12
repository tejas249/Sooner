import type { BoardState } from "../../../core/health.ts";
import type { BoardRowView } from "../../../web/admin-view.ts";
import { pauseAction, pollNowAction, resumeAction } from "../actions.ts";

/** The state as a badge. Fill and outline differ as well as the words, so it does not rely on colour. */
const BADGE: Record<BoardState, string> = {
  ok: "border border-line text-muted",
  waiting: "border border-dashed border-line text-muted",
  paused: "border border-dashed border-line text-muted",
  failing: "border border-accent-ink bg-accent-soft text-accent-ink",
  degraded: "bg-accent-ink text-canvas",
  "format-changed": "bg-accent-ink text-canvas",
  gone: "bg-accent-ink text-canvas",
};

const button =
  "rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-2 focus-visible:bg-surface-2";

function BoardButton({ board, label, action }: { board: BoardRowView; label: string; action: (data: FormData) => Promise<never> }) {
  return (
    <form action={action}>
      <input type="hidden" name="board" value={board.id} />
      <button type="submit" className={button} aria-label={`${label}: ${board.name}`}>
        {label}
      </button>
    </form>
  );
}

export function BoardTable({ boards }: { boards: readonly BoardRowView[] }) {
  if (boards.length === 0) return <p className="text-muted">No boards to show.</p>;
  return (
    <div
      role="region"
      aria-label="Boards, scrollable"
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-line bg-surface"
    >
      <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
        <caption className="sr-only">Every board, with its state, roles, last and next poll, and what you can do to it</caption>
        <thead>
          <tr className="border-b border-line text-muted">
            <th scope="col" className="px-4 py-3 font-medium">Company</th>
            <th scope="col" className="px-3 py-3 font-medium">State</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Roles</th>
            <th scope="col" className="px-3 py-3 font-medium">Last poll</th>
            <th scope="col" className="px-3 py-3 font-medium">Next poll</th>
            <th scope="col" className="px-3 py-3 font-medium">Note</th>
            <th scope="col" className="px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {boards.map((board) => (
            <tr key={board.id} className="border-b border-line align-top last:border-b-0">
              <th scope="row" className="px-4 py-3 text-left font-medium">
                {board.name}
                <span className="block font-mono text-xs font-normal text-muted">
                  {board.source}
                  {board.priority ? " · priority" : ""}
                </span>
              </th>
              <td className="px-3 py-3">
                <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[board.state]}`}>{board.stateLabel}</span>
                {board.failures > 0 ? <span className="mt-1 block text-xs text-muted">{board.failures} in a row</span> : null}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {board.openRoles.toLocaleString("en-US")}
                {board.onStrike > 0 ? <span className="block text-xs text-muted">{board.onStrike} missing</span> : null}
              </td>
              <td className="px-3 py-3 whitespace-nowrap text-muted">{board.lastPolled}</td>
              <td className="px-3 py-3 whitespace-nowrap text-muted">
                {board.nextPoll}
                {board.state !== "paused" && board.state !== "gone" ? <span className="block text-xs">every {board.interval}</span> : null}
              </td>
              <td className="max-w-xs px-3 py-3 text-xs text-muted">{board.note ? <span className="text-pretty break-words">{board.note}</span> : null}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {board.canPoll ? <BoardButton board={board} label="Poll now" action={pollNowAction} /> : null}
                  {board.canPause ? <BoardButton board={board} label="Pause" action={pauseAction} /> : null}
                  {board.canResume ? <BoardButton board={board} label="Resume" action={resumeAction} /> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
