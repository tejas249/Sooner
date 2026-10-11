import type { BoardEntry } from "../core/boards.ts";
import { withTransaction, type Pool } from "./pool.ts";

export interface SeedOptions {
  /** The moment the new boards' first polls are measured from. */
  now: Date;
  /** The first polls of the boards added by this run are spread evenly over this many seconds, not all at once. */
  spreadSec?: number;
  /** Also switch off boards that are in the database but no longer in the list. */
  deactivateMissing?: boolean;
}

export interface SeedReport {
  companiesAdded: number;
  companiesUpdated: number;
  boardsAdded: number;
  boardsAlreadyThere: number;
  /** In the list, but switched off in the database. They stay off: switching a board off is how an opt-out is honoured. */
  boardsSwitchedOff: string[];
  /** In the database but not in the list. Still polled unless `deactivateMissing` was set. */
  boardsNotInList: string[];
  /** Switched off by this run. */
  boardsDeactivated: string[];
}

const key = (provider: string, token: string): string => `${provider}:${token}`;

/**
 * Puts the companies and boards of the list into the database. It only ever adds and corrects descriptions:
 *  - a company that exists keeps its row, with its name, segment and country brought up to date;
 *  - a board that exists is left exactly as it is, so a re-run never resets a schedule, an ETag or a failure count, and
 *    never switches a board back on;
 *  - a board that is new becomes due shortly, staggered across `spreadSec` so fifty boards do not all start in one second.
 *
 * Running it twice in a row changes nothing the second time.
 */
export async function seedBoards(pool: Pool, entries: readonly BoardEntry[], options: SeedOptions): Promise<SeedReport> {
  const spreadSec = options.spreadSec ?? 60;
  return withTransaction(pool, async (client) => {
    // Two seeds at once would both see "no such board" and race to add it. They queue instead.
    await client.query("lock table company, board in share row exclusive mode");

    const companies = await client.query<{ id: string; slug: string; name: string; segment: string | null; country: string | null }>(
      "select id, slug, name, segment, country from company where slug = any($1::text[])",
      [entries.map((e) => e.slug)],
    );
    const known = new Map(companies.rows.map((row) => [row.slug, row]));
    const report: SeedReport = {
      companiesAdded: 0,
      companiesUpdated: 0,
      boardsAdded: 0,
      boardsAlreadyThere: 0,
      boardsSwitchedOff: [],
      boardsNotInList: [],
      boardsDeactivated: [],
    };

    const companyIds = new Map<string, string>(companies.rows.map((row) => [row.slug, row.id]));
    for (const entry of entries) {
      const country = entry.country ?? null;
      const existing = known.get(entry.slug);
      if (!existing) {
        const { rows } = await client.query<{ id: string }>(
          "insert into company (slug, name, segment, country) values ($1, $2, $3, $4) returning id",
          [entry.slug, entry.name, entry.segment, country],
        );
        const id = (rows[0] as { id: string }).id;
        companyIds.set(entry.slug, id);
        // A company can have a board on more than one provider, so a later entry may name it again.
        known.set(entry.slug, { id, slug: entry.slug, name: entry.name, segment: entry.segment, country });
        report.companiesAdded++;
      } else if (existing.name !== entry.name || existing.segment !== entry.segment || existing.country !== country) {
        await client.query("update company set name = $2, segment = $3, country = $4 where id = $1", [
          existing.id,
          entry.name,
          entry.segment,
          country,
        ]);
        known.set(entry.slug, { ...existing, name: entry.name, segment: entry.segment, country });
        report.companiesUpdated++;
      }
    }

    const boards = await client.query<{ provider: string; token: string; active: boolean }>(
      "select provider, token, active from board",
    );
    const present = new Map(boards.rows.map((row) => [key(row.provider, row.token), row.active]));
    const fresh = entries.filter((entry) => !present.has(key(entry.provider, entry.token)));

    for (const [index, entry] of fresh.entries()) {
      const delaySec = Math.floor((index * spreadSec) / Math.max(fresh.length, 1));
      await client.query(
        "insert into board (company_id, provider, token, next_poll_at) values ($1, $2, $3, $4::timestamptz)",
        [companyIds.get(entry.slug), entry.provider, entry.token, new Date(options.now.getTime() + delaySec * 1000).toISOString()],
      );
      report.boardsAdded++;
    }

    const listed = new Set(entries.map((entry) => key(entry.provider, entry.token)));
    for (const entry of entries) {
      const id = key(entry.provider, entry.token);
      if (present.has(id)) {
        report.boardsAlreadyThere++;
        if (present.get(id) === false) report.boardsSwitchedOff.push(id);
      }
    }
    report.boardsNotInList = [...present.entries()].filter(([id, active]) => active && !listed.has(id)).map(([id]) => id).sort();

    if (options.deactivateMissing && report.boardsNotInList.length > 0) {
      const result = await client.query<{ provider: string; token: string }>(
        `update board set active = false
          where active and (provider || ':' || token) = any($1::text[])
          returning provider, token`,
        [report.boardsNotInList],
      );
      report.boardsDeactivated = result.rows.map((row) => key(row.provider, row.token)).sort();
    }
    return report;
  });
}
