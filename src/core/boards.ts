import { z } from "zod";
import { TOKEN_RE } from "./adapters/shared.ts";
import { PROVIDERS } from "./types.ts";

/** Who a company is picked for: the guide's audience mix of global tech, Indian companies and remote-first companies. */
export const SEGMENTS = ["global", "india", "remote-first"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lower-case letters, digits and hyphens");

/**
 * One line of data/boards.json: a confirmed board, ready to poll. This is the seed for the `company` and `board` tables,
 * and the list the website shows.
 */
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
