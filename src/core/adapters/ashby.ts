import { z } from "zod";
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

// isListed is required on purpose. If Ashby ever dropped it, quietly treating every role as listed (or unlisted)
// would be a wrong guess; failing the response is the honest outcome.
const Job = z.object({
  id: z.string().min(1),
  title: z.string(),
  jobUrl: employerUrl,
  isListed: z.boolean(),
  publishedAt: z.string().nullish(),
  location: z.string().nullish(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
});

const Board = z.object({ jobs: z.array(Job) });

// Unlisted roles are dropped, so their other fields are none of our business. Only the flag is checked on every role.
const Flags = z.object({ jobs: z.array(z.looseObject({ isListed: z.boolean() })) });

/**
 * workplaceType decides. The isRemote flag cannot be trusted on its own: on Ramp's board, 97 hybrid roles with no
 * remote location at all still carry isRemote true (checked 2026-10-08). The flag is only a fallback for a role that
 * has no workplaceType.
 */
function remoteFrom(job: z.output<typeof Job>): boolean | null {
  switch (job.workplaceType?.toLowerCase()) {
    case "remote":
      return true;
    case "hybrid":
    case "onsite":
    case "on-site":
      return false;
    default:
      return job.isRemote ?? null;
  }
}

export const ashby: Adapter = {
  provider: "ashby",
  host: "api.ashbyhq.com",
  // The feed is cached at the edge for 60 seconds (cache-control: max-age=60), so asking sooner buys nothing.
  minIntervalSec: 60,
  timeoutMs: 30_000,

  url(token) {
    assertToken(token);
    return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  },

  parse(json) {
    // Unlisted roles are not on the public board. Dropping them makes them close through the normal two-strike path,
    // and if Ashby lists one again it comes back as "reopened".
    const listed = parseFeed("ashby", Flags, json).jobs.filter((job) => job.isListed);
    const board = parseFeed("ashby", Board, { jobs: listed });
    const jobs = board.jobs.map(
      (job): NormalizedJob => ({
        externalId: job.id,
        title: requireTitle("ashby", job.id, job.title), // Ashby titles can carry stray spaces
        location: text(job.location),
        department: text(job.department) ?? text(job.team),
        remote: remoteFrom(job),
        url: job.jobUrl,
        postedAt: toIso(job.publishedAt),
        sourceUpdatedAt: null,
      }),
    );
    rejectDuplicateIds("ashby", jobs);
    return jobs;
  },
};
