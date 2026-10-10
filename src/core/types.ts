export const PROVIDERS = ["greenhouse", "lever", "ashby"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * One open role, in the one shape every adapter produces. Nothing outside src/core/adapters knows which provider a
 * role came from. Descriptions and pay are deliberately absent: we keep titles, places, dates and links only.
 */
export interface NormalizedJob {
  /** The provider's own ID for the role, as text. Unique within one board. */
  externalId: string;
  title: string;
  location: string | null;
  department: string | null;
  /** true = the feed says remote, false = the feed says on-site or hybrid, null = the feed does not say. */
  remote: boolean | null;
  /** The employer's own apply page. Always https. */
  url: string;
  /** The provider's date for when the role went live, ISO 8601 in UTC. Null when the feed has none. */
  postedAt: string | null;
  /** The provider's last-edit date, ISO 8601 in UTC. Only Greenhouse supplies one. */
  sourceUpdatedAt: string | null;
}
