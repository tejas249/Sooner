import { z } from "zod";
import { FeedFormatError } from "../errors.ts";
import type { NormalizedJob } from "../types.ts";
import {
  assertToken,
  employerUrl,
  parseFeed,
  rejectDuplicateIds,
  requireTitle,
  text,
  toIso,
  type Adapter,
} from "./shared.ts";

// Only the fields we use are listed. Anything else Greenhouse adds is ignored.
const Job = z.object({
  id: z.number().int(),
  title: z.string(),
  absolute_url: employerUrl,
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
});

const Board = z.object({
  jobs: z.array(Job),
  meta: z.object({ total: z.number().int() }).nullish(),
});

export const greenhouse: Adapter = {
  provider: "greenhouse",
  host: "boards-api.greenhouse.io",
  minIntervalSec: 0,
  timeoutMs: 30_000,

  url(token) {
    assertToken(token);
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
  },

  parse(json) {
    const board = parseFeed("greenhouse", Board, json);
    // A list shorter than the board's own total would make every missing role look closed.
    if (board.meta && board.meta.total !== board.jobs.length) {
      throw new FeedFormatError(
        "greenhouse",
        `meta.total is ${board.meta.total} but the list holds ${board.jobs.length} roles`,
      );
    }

    const jobs = board.jobs.map((job): NormalizedJob => {
      const externalId = String(job.id);
      const location = text(job.location?.name);
      return {
        externalId,
        title: requireTitle("greenhouse", externalId, job.title),
        location,
        // The list carries no department (only the per-role call does) and no remote flag. "Remote" in the place name
        // is the one honest signal; anything else stays unknown rather than being guessed as on-site.
        department: null,
        remote: location !== null && /\bremote\b/i.test(location) ? true : null,
        url: job.absolute_url,
        postedAt: toIso(job.first_published),
        sourceUpdatedAt: toIso(job.updated_at),
      };
    });
    rejectDuplicateIds("greenhouse", jobs);
    return jobs;
  },
};
