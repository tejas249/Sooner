import type { SiteStats } from "../../web/site-stats.ts";
import { PROVIDER_LABELS } from "../../web/site-stats.ts";

/** Every company we watch, grouped by who it is picked for. Names are text only: no logos without permission. */
export function CompanyList({ groups }: { groups: SiteStats["bySegment"] }) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <div key={group.segment}>
          <h3 className="text-sm font-medium text-muted">
            {group.label} <span className="ml-1 font-mono text-xs">{group.boards.length}</span>
          </h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {group.boards.map((board) => (
              <li
                key={board.slug}
                className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm"
              >
                <span>{board.name}</span>
                <span className="font-mono text-xs text-muted">{PROVIDER_LABELS[board.provider]}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
