import type { Tile } from "../../../web/admin-data.ts";

/** The numbers that say how the worker is doing. A tile that is outside what is healthy says so in words, not only in style. */
export function Tiles({ tiles }: { tiles: readonly Tile[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={`rounded-xl border bg-surface p-4 ${tile.attention ? "border-accent-ink" : "border-line"}`}
        >
          <dt className="flex items-center justify-between gap-2 text-sm text-muted">
            {tile.label}
            {tile.attention ? (
              <span className="rounded-full bg-accent-ink px-2 py-0.5 text-xs font-medium text-canvas">Check</span>
            ) : null}
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{tile.value}</dd>
          <dd className="mt-1 text-sm text-muted">{tile.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
