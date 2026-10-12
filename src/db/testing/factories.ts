import type { Queryable } from "../pool.ts";

/** Rows for tests that need a company, a board or a posting but are not about how they were created. */

export async function insertCompany(
  db: Queryable,
  fields: { slug?: string; name?: string; segment?: string | null; country?: string | null } = {},
): Promise<string> {
  const slug = fields.slug ?? "acme";
  const { rows } = await db.query<{ id: string }>(
    "insert into company (slug, name, segment, country) values ($1, $2, $3, $4) returning id",
    [slug, fields.name ?? "Acme", fields.segment ?? "global", fields.country ?? "US"],
  );
  return (rows[0] as { id: string }).id;
}

export interface BoardFields {
  provider?: string;
  token?: string;
  active?: boolean;
  nextPollAt?: string;
  pollIntervalSec?: number;
  etag?: string | null;
  baselinedAt?: string | null;
  consecutiveFailures?: number;
  claimedUntil?: string | null;
  claimToken?: string | null;
  priority?: boolean;
  consecutiveNotFound?: number;
  deactivatedReason?: string | null;
}

export async function insertBoard(db: Queryable, companyId: string, fields: BoardFields = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into board (company_id, provider, token, active, next_poll_at, poll_interval_sec, etag, baselined_at,
                        consecutive_failures, claimed_until, claim_token, priority, consecutive_not_found,
                        deactivated_at, deactivated_reason)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6, $7, $8, $9, $10, $11, $12, $13,
             case when $14::text is null then null else now() end, $14)
     returning id`,
    [
      companyId,
      fields.provider ?? "greenhouse",
      fields.token ?? "acme",
      fields.active ?? true,
      fields.nextPollAt ?? null,
      fields.pollIntervalSec ?? 1800,
      fields.etag ?? null,
      fields.baselinedAt ?? null,
      fields.consecutiveFailures ?? 0,
      fields.claimedUntil ?? null,
      fields.claimToken ?? null,
      fields.priority ?? false,
      fields.consecutiveNotFound ?? 0,
      fields.deactivatedReason ?? null,
    ],
  );
  return (rows[0] as { id: string }).id;
}

export interface PostingFields {
  externalId?: string;
  title?: string;
  titleNorm?: string;
  location?: string | null;
  locationNorm?: string | null;
  status?: "open" | "closed";
  closedAt?: string | null;
  missedPolls?: number;
  missedSince?: string | null;
  firstSeenAt?: string;
  repostOfId?: string | null;
}

export async function insertPosting(
  db: Queryable,
  ids: { boardId: string; companyId: string },
  fields: PostingFields = {},
): Promise<string> {
  const firstSeen = fields.firstSeenAt ?? "2026-10-01T00:00:00.000Z";
  const title = fields.title ?? "Software Engineer";
  const { rows } = await db.query<{ id: string }>(
    `insert into posting (board_id, company_id, external_id, title, title_norm, location, location_norm, url,
                          first_seen_at, last_seen_at, status, closed_at, missed_polls, missed_since, repost_of_id,
                          content_hash)
     values ($1, $2, $3, $4, $5, $6, $7, 'https://example.com/jobs/1', $8, $8, $9, $10, $11, $12, $13, 'hash')
     returning id`,
    [
      ids.boardId,
      ids.companyId,
      fields.externalId ?? "1",
      title,
      fields.titleNorm ?? title.toLowerCase(),
      fields.location ?? "Remote",
      fields.locationNorm ?? (fields.location ?? "Remote").toLowerCase(),
      firstSeen,
      fields.status ?? "open",
      fields.closedAt ?? null,
      fields.missedPolls ?? 0,
      fields.missedSince ?? null,
      fields.repostOfId ?? null,
    ],
  );
  return (rows[0] as { id: string }).id;
}
