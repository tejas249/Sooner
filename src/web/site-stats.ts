import type { BoardEntry, Segment } from "../core/boards.ts";
import { SEGMENTS } from "../core/boards.ts";
import { PROVIDERS, type Provider } from "../core/types.ts";

export const SEGMENT_LABELS: Record<Segment, string> = {
  global: "Global tech",
  india: "India",
  "remote-first": "Remote-first",
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

export interface SiteStats {
  companies: number;
  /** Boards polled every five minutes. */
  fast: number;
  /** Job-board providers with at least one watched board. */
  providers: number;
  /** Open roles across all boards when the list was confirmed. */
  roles: number;
  byProvider: Array<{ provider: Provider; label: string; boards: number }>;
  /**
   * In a fixed order, each with its boards sorted by name. Segments with no boards are left out. `shown` is what the page
   * lists first: the boards polled every five minutes, which are the ones picked first. `hidden` is the rest, behind a
   * "show the rest" toggle. A group in which none or all of the boards are fast is shown in full.
   */
  bySegment: Array<{ segment: Segment; label: string; boards: BoardEntry[]; shown: BoardEntry[]; hidden: BoardEntry[] }>;
}

export function siteStats(entries: readonly BoardEntry[]): SiteStats {
  const byProvider = PROVIDERS.map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider],
    boards: entries.filter((e) => e.provider === provider).length,
  })).filter((p) => p.boards > 0);

  const bySegment = SEGMENTS.map((segment) => {
    const boards = entries.filter((e) => e.segment === segment).sort((a, b) => a.name.localeCompare(b.name, "en"));
    const fast = boards.filter((b) => b.priority === true);
    const split = fast.length > 0 && fast.length < boards.length;
    return {
      segment,
      label: SEGMENT_LABELS[segment],
      boards,
      shown: split ? fast : boards,
      hidden: split ? boards.filter((b) => b.priority !== true) : [],
    };
  }).filter((s) => s.boards.length > 0);

  return {
    companies: entries.length,
    fast: entries.filter((e) => e.priority === true).length,
    providers: byProvider.length,
    roles: entries.reduce((sum, e) => sum + e.rolesWhenConfirmed, 0),
    byProvider,
    bySegment,
  };
}
