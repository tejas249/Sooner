import type { BoardEntry } from "../../core/boards.ts";
import type { SiteStats } from "../../web/site-stats.ts";
import { PROVIDER_LABELS } from "../../web/site-stats.ts";

function Chips({ boards }: { boards: readonly BoardEntry[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {boards.map((board) => (
        <li key={board.slug} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm">
          <span>{board.name}</span>
          <span className="font-mono text-xs text-muted">{PROVIDER_LABELS[board.provider]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every company we watch, grouped by who it is picked for. Names are text only: no logos without permission. A long group
 * shows the companies checked every five minutes and keeps the rest behind a native toggle, which works without JavaScript
 * and keeps every name in the page.
 */
export function CompanyList({ groups }: { groups: SiteStats["bySegment"] }) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <div key={group.segment}>
          <h3 className="text-sm font-medium text-muted">
            {group.label} <span className="ml-1 font-mono text-xs">{group.boards.length}</span>
          </h3>
          <div className="mt-3">
            <Chips boards={group.shown} />
          </div>
          {group.hidden.length > 0 ? (
            <details className="mt-3">
              <summary className="w-fit cursor-pointer list-none rounded-full border border-line px-3.5 py-1.5 text-sm text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                Show the other {group.hidden.length}
              </summary>
              <div className="mt-3">
                <Chips boards={group.hidden} />
              </div>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}
