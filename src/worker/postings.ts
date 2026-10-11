import type { BoardState, TrackedJob } from "../core/changes.ts";
import type { EventRecord, EventType, WritePlan } from "../core/persist.ts";
import { norm } from "../core/text.ts";
import type { Queryable } from "../db/pool.ts";
import type { ClaimedBoard } from "./types.ts";

/** How far back a closed role can be and still count as the one that came back. */
const REPOST_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

interface PostingRow {
  id: string;
  external_id: string;
  title: string;
  location: string | null;
  department: string | null;
  remote: boolean | null;
  url: string;
  posted_at: Date | null;
  source_updated_at: Date | null;
  content_hash: string;
  first_seen_at: Date;
  last_seen_at: Date;
  status: "open" | "closed";
  closed_at: Date | null;
  missed_polls: number;
  missed_since: Date | null;
  reopen_count: number;
  baseline: boolean;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

function toTrackedJob(row: PostingRow): TrackedJob {
  return {
    externalId: row.external_id,
    title: row.title,
    location: row.location,
    department: row.department,
    remote: row.remote,
    url: row.url,
    postedAt: iso(row.posted_at),
    sourceUpdatedAt: iso(row.source_updated_at),
    contentHash: row.content_hash,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    status: row.status,
    closedAt: iso(row.closed_at),
    missedPolls: row.missed_polls,
    missedSince: iso(row.missed_since),
    reopenCount: row.reopen_count,
    baseline: row.baseline,
  };
}

export interface LoadedBoard {
  state: BoardState;
  /** The database ID of each role, by the provider's ID. */
  ids: Map<string, string>;
}

/** Every role this board has ever had, as the change-detection reducer wants it. */
export async function loadBoardState(db: Queryable, boardId: string, baselinedAt: string | null): Promise<LoadedBoard> {
  const { rows } = await db.query<PostingRow>(
    `select id, external_id, title, location, department, remote, url, posted_at, source_updated_at, content_hash,
            first_seen_at, last_seen_at, status, closed_at, missed_polls, missed_since, reopen_count, baseline
       from posting
      where board_id = $1
      order by external_id`,
    [boardId],
  );
  return {
    state: { baselinedAt, jobs: rows.map(toTrackedJob) },
    ids: new Map(rows.map((row) => [row.external_id, row.id])),
  };
}

/** One array per column, in the order the SQL below unpacks them. */
function columnArrays(jobs: readonly TrackedJob[], repostOf: ReadonlyArray<string | null>): unknown[] {
  return [
    jobs.map((j) => j.externalId),
    jobs.map((j) => j.title),
    jobs.map((j) => norm(j.title)),
    jobs.map((j) => j.location),
    jobs.map((j) => (j.location === null ? null : norm(j.location))),
    jobs.map((j) => j.department),
    jobs.map((j) => j.remote),
    jobs.map((j) => j.url),
    jobs.map((j) => j.postedAt),
    jobs.map((j) => j.sourceUpdatedAt),
    jobs.map((j) => j.firstSeenAt),
    jobs.map((j) => j.lastSeenAt),
    jobs.map((j) => j.missedPolls),
    jobs.map((j) => j.missedSince),
    jobs.map((j) => j.status),
    jobs.map((j) => j.closedAt),
    jobs.map((j) => j.reopenCount),
    [...repostOf],
    jobs.map((j) => j.contentHash),
    jobs.map((j) => j.baseline),
  ];
}

const UNPACK = `unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::boolean[], $10::text[],
          $11::timestamptz[], $12::timestamptz[], $13::timestamptz[], $14::timestamptz[], $15::int[], $16::timestamptz[],
          $17::text[], $18::timestamptz[], $19::int[], $20::bigint[], $21::text[], $22::boolean[])
          as u(external_id, title, title_norm, location, location_norm, department, remote, url,
               posted_at, source_updated_at, first_seen_at, last_seen_at, missed_polls, missed_since,
               status, closed_at, reopen_count, repost_of_id, content_hash, baseline)`;

async function insertPostings(
  db: Queryable,
  board: ClaimedBoard,
  jobs: readonly TrackedJob[],
  repostOf: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; external_id: string }>(
    `insert into posting (board_id, company_id, external_id, title, title_norm, location, location_norm, department, remote,
                          url, posted_at, source_updated_at, first_seen_at, last_seen_at, missed_polls, missed_since,
                          status, closed_at, reopen_count, repost_of_id, content_hash, baseline)
     select $1::bigint, $2::bigint, u.external_id, u.title, u.title_norm, u.location, u.location_norm, u.department,
            u.remote, u.url, u.posted_at, u.source_updated_at, u.first_seen_at, u.last_seen_at, u.missed_polls,
            u.missed_since, u.status, u.closed_at, u.reopen_count, u.repost_of_id, u.content_hash, u.baseline
       from ${UNPACK}
     returning id, external_id`,
    [board.id, board.companyId, ...columnArrays(jobs, repostOf)],
  );
  return new Map(rows.map((row) => [row.external_id, row.id]));
}

/** Rewrites the roles whose row changed. Everything that never changes after the first sighting is left out. */
async function updatePostings(db: Queryable, board: ClaimedBoard, jobs: readonly TrackedJob[]): Promise<void> {
  const result = await db.query(
    `update posting p
        set title = u.title, title_norm = u.title_norm, location = u.location, location_norm = u.location_norm,
            department = u.department, remote = u.remote, url = u.url, posted_at = u.posted_at,
            source_updated_at = u.source_updated_at, last_seen_at = u.last_seen_at, missed_polls = u.missed_polls,
            missed_since = u.missed_since, status = u.status, closed_at = u.closed_at, reopen_count = u.reopen_count,
            content_hash = u.content_hash
       from ${UNPACK}
      where p.board_id = $1 and p.company_id = $2::bigint and p.external_id = u.external_id`,
    [board.id, board.companyId, ...columnArrays(jobs, jobs.map(() => null))],
  );
  if (result.rowCount !== jobs.length) {
    throw new Error(`expected to update ${jobs.length} roles of board ${board.id} but updated ${result.rowCount}`);
  }
}

async function touchPostings(db: Queryable, board: ClaimedBoard, externalIds: readonly string[], at: Date): Promise<void> {
  const result = await db.query(
    "update posting set last_seen_at = $3::timestamptz where board_id = $1 and external_id = any($2::text[])",
    [board.id, externalIds, at.toISOString()],
  );
  if (result.rowCount !== externalIds.length) {
    throw new Error(`expected to touch ${externalIds.length} roles of board ${board.id} but touched ${result.rowCount}`);
  }
}

export interface RepostOrigin {
  id: string;
  closedAt: string;
}

/**
 * The closed role that a newly appeared one is a repost of, if any. A repost is the same role coming back, not a second
 * opening: same company, same normalised title (or a very similar one) and place, closed within the last 60 days, with
 * nothing like it open right now. That last condition is what stops a company with five identical openings from looking
 * like a repost machine. A closed role can be the origin of only one repost.
 */
export async function findRepostOrigin(
  db: Queryable,
  companyId: string,
  titleNorm: string,
  locationNorm: string | null,
  at: Date,
): Promise<RepostOrigin | null> {
  const { rows } = await db.query<{ id: string; closed_at: Date }>(
    `select p.id, p.closed_at
       from posting p
      where p.company_id = $1
        and p.status = 'closed'
        and p.closed_at <= $4::timestamptz
        and p.closed_at > $4::timestamptz - make_interval(days => $5)
        and p.location_norm is not distinct from $3::text
        and (p.title_norm = $2::text or similarity(p.title_norm, $2::text) >= 0.85)
        and not exists (
              select 1 from posting o
               where o.company_id = $1 and o.status = 'open'
                 and o.title_norm = p.title_norm and o.location_norm is not distinct from p.location_norm)
        and not exists (select 1 from posting r where r.repost_of_id = p.id)
      order by p.closed_at desc
      limit 1`,
    [companyId, titleNorm, locationNorm, at.toISOString(), REPOST_WINDOW_DAYS],
  );
  const row = rows[0];
  return row ? { id: row.id, closedAt: row.closed_at.toISOString() } : null;
}

export interface StoredEvent {
  externalId: string;
  postingId: string;
  type: EventType;
  detail: Record<string, unknown>;
}

/**
 * Writes one poll's changes: new roles (looking for a repost first, unless this is the baseline), changed roles, roles
 * seen again, and the events. Must run inside the poll's transaction, which already holds the board's row lock.
 *
 * Returns the events as stored. An `appeared` event becomes `reposted` when the role turns out to be one.
 */
export async function writeChanges(
  db: Queryable,
  board: ClaimedBoard,
  input: { plan: WritePlan; records: readonly EventRecord[]; ids: Map<string, string>; at: Date; baseline: boolean },
): Promise<StoredEvent[]> {
  const { plan, records, ids, at, baseline } = input;

  if (plan.updates.length > 0) await updatePostings(db, board, plan.updates);
  if (plan.touches.length > 0) await touchPostings(db, board, plan.touches, at);

  const reposts = new Map<string, RepostOrigin>();
  if (plan.inserts.length > 0) {
    if (baseline) {
      // The first sighting of a board can be 800 roles. One statement, no events, no repost check.
      for (const [externalId, id] of await insertPostings(db, board, plan.inserts, plan.inserts.map(() => null))) {
        ids.set(externalId, id);
      }
    } else {
      // One at a time, so each role sees the ones inserted before it: of two identical new roles, only the first can be
      // the repost of a closed one.
      for (const job of plan.inserts) {
        const origin = await findRepostOrigin(
          db,
          board.companyId,
          norm(job.title),
          job.location === null ? null : norm(job.location),
          at,
        );
        const inserted = await insertPostings(db, board, [job], [origin?.id ?? null]);
        ids.set(job.externalId, inserted.get(job.externalId) as string);
        if (origin) reposts.set(job.externalId, origin);
      }
    }
  }

  const stored = records.map((record): StoredEvent => {
    const postingId = ids.get(record.externalId);
    if (postingId === undefined) throw new Error(`no posting row for role ${record.externalId} of board ${board.id}`);
    const origin = record.type === "appeared" ? reposts.get(record.externalId) : undefined;
    if (!origin) return { ...record, postingId };
    return {
      externalId: record.externalId,
      postingId,
      type: "reposted",
      detail: {
        repostOf: origin.id,
        closedAt: origin.closedAt,
        daysSinceClosed: Math.round((at.getTime() - Date.parse(origin.closedAt)) / DAY_MS),
      },
    };
  });

  if (stored.length > 0) {
    await db.query(
      `insert into posting_event (posting_id, company_id, type, at, detail)
       select u.posting_id, $1::bigint, u.type, $2::timestamptz, u.detail::jsonb
         from unnest($3::bigint[], $4::text[], $5::text[]) with ordinality as u(posting_id, type, detail, position)
        order by u.position`,
      [
        board.companyId,
        at.toISOString(),
        stored.map((event) => event.postingId),
        stored.map((event) => event.type),
        stored.map((event) => JSON.stringify(event.detail)),
      ],
    );
  }
  return stored;
}
