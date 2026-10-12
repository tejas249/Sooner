import { z } from "zod";
import { SEGMENTS, slug } from "../../src/core/boards.ts";

// The confirmed-board list (data/boards.json) is shared with the website, so its schema lives in src/core/boards.ts.
export { BoardEntries, BoardEntry, SEGMENTS, slugify, type Segment } from "../../src/core/boards.ts";

const boardSpec = z.string().regex(/^(greenhouse|lever|ashby):[a-z0-9][a-z0-9_-]{0,63}$/, "use provider:token, for example greenhouse:stripe");

/** One line of data/candidates.json: a company you picked, and whatever you already know about where it hires. */
export const Candidate = z.object({
  name: z.string().min(1),
  slug: slug.optional(),
  segment: z.enum(SEGMENTS),
  country: z.string().length(2).optional(),
  website: z.url().optional(),
  /** A careers page to read once for links to a job board. */
  careers: z.url().optional(),
  /** Boards you already believe it uses. They are confirmed against the provider before anything is written. */
  boards: z.array(boardSpec).optional(),
  /** Passed on to the board: poll it at the fast rhythm. See BoardEntry. */
  priority: z.boolean().optional(),
});
export type Candidate = z.infer<typeof Candidate>;
export const Candidates = z.array(Candidate);
