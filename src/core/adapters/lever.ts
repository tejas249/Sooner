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

// Lever ships whole descriptions with every posting. None of that is listed here, so none of it is kept.
const Posting = z.object({
  id: z.string().min(1),
  text: z.string(),
  hostedUrl: employerUrl,
  createdAt: z.number().nullish(),
  workplaceType: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      department: z.string().nullish(),
      team: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
});

const Postings = z.array(Posting);

function remoteFrom(workplaceType: string | null | undefined): boolean | null {
  switch (workplaceType?.toLowerCase()) {
    case "remote":
      return true;
    case "hybrid":
    case "on-site":
    case "onsite":
      return false;
    default:
      return null; // "unspecified", missing, or a value we have not seen
  }
}

export const lever: Adapter = {
  provider: "lever",
  host: "api.lever.co",
  minIntervalSec: 0,
  timeoutMs: 120_000,

  url(token) {
    assertToken(token);
    return `https://api.lever.co/v0/postings/${token}?mode=json`;
  },

  parse(json) {
    const postings = parseFeed("lever", Postings, json);
    const jobs = postings.map((posting): NormalizedJob => {
      const categories = posting.categories;
      return {
        externalId: posting.id,
        title: requireTitle("lever", posting.id, posting.text),
        location: text(categories?.location) ?? text(categories?.allLocations?.[0]),
        department: text(categories?.department) ?? text(categories?.team),
        remote: remoteFrom(posting.workplaceType),
        url: posting.hostedUrl,
        // Treat with care: Lever's createdAt can be when the posting was drafted, not when it went public.
        postedAt: toIso(posting.createdAt),
        sourceUpdatedAt: null,
      };
    });
    rejectDuplicateIds("lever", jobs);
    return jobs;
  },
};
