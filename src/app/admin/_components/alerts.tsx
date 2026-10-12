import type { AlertView } from "../../../web/admin-data.ts";

const SEVERITY = {
  critical: "bg-accent-ink text-canvas",
  warning: "border border-accent-ink bg-accent-soft text-accent-ink",
} as const;

/** Alerts as a list. All text, including what came from a provider, is rendered as text and escaped by React. */
export function AlertList({ alerts, empty }: { alerts: readonly AlertView[]; empty: string }) {
  if (alerts.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {alerts.map((alert) => (
        <li key={alert.key} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${SEVERITY[alert.severity]}`}>
              {alert.severity === "critical" ? "Critical" : "Warning"}
            </span>
            <h3 className="font-medium">{alert.title}</h3>
          </div>
          <p className="mt-2 text-sm text-muted text-pretty">{alert.detail}</p>
          <p className="mt-2 text-xs text-muted">
            {alert.when} · {alert.told} · <code className="font-mono">{alert.key}</code>
          </p>
        </li>
      ))}
    </ul>
  );
}
