import { z } from "zod";
import { TOKEN_RE } from "../../src/core/adapters/index.ts";
import { PROVIDERS } from "../../src/core/types.ts";

export const SEGMENTS = ["global", "india", "remote-first"] as const;
export type Segment = (typeof SEGMENTS)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lower-case letters, digits and hyphens");
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
});
export type Candidate = z.infer<typeof Candidate>;
export const Candidates = z.array(Candidate);

/** One line of data/boards.json: a confirmed board, ready to poll. This is the seed for the `company` and `board` tables. */
export const BoardEntry = z.object({
  slug,
  name: z.string().min(1),
  segment: z.enum(SEGMENTS),
  country: z.string().length(2).optional(),
  provider: z.enum(PROVIDERS),
  token: z.string().regex(TOKEN_RE),
  /** How many roles the board listed when it was confirmed. Only for reading the file; polling does not use it. */
  rolesWhenConfirmed: z.number().int().nonnegative(),
  confirmedVia: z.enum(["hint", "careers", "guess"]),
});
export type BoardEntry = z.infer<typeof BoardEntry>;
export const BoardEntries = z.array(BoardEntry);

export const slugify = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
