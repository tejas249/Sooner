import { TOKEN_RE } from "./adapters/shared.ts";
import type { Provider } from "./types.ts";

export interface BoardCandidate {
  provider: Provider;
  token: string;
}

/** Words that follow a job-board host in a URL but are paths, not the name of a company's board. */
const NOT_TOKENS = new Set(["embed", "v1", "api", "static", "assets", "jobs", "job_app", "favicon", "robots", "sitemap"]);

// "(?:\\?\/)" accepts both "/" and the "\/" that JSON inside a page uses for it.
const SLASH = String.raw`\\?\/`;

const PATTERNS: ReadonlyArray<readonly [Provider, RegExp]> = [
  // The embed snippet: boards.greenhouse.io/embed/job_board/js?for=TOKEN
  ["greenhouse", new RegExp(String.raw`(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io${SLASH}embed${SLASH}job_board(?:${SLASH}js)?\?(?:[^"'\s<>]*&)?for=([a-z0-9_-]+)`, "gi")],
  // The hosted board: boards.greenhouse.io/TOKEN or job-boards.greenhouse.io/TOKEN
  ["greenhouse", new RegExp(String.raw`(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io${SLASH}([a-z0-9_-]+)`, "gi")],
  ["lever", new RegExp(String.raw`jobs(?:\.eu)?\.lever\.co${SLASH}([a-z0-9_-]+)`, "gi")],
  ["ashby", new RegExp(String.raw`jobs\.ashbyhq\.com${SLASH}([a-z0-9_-]+)`, "gi")],
];

/**
 * Looks through a careers page for links to the three job boards we can read, in the order they first appear.
 * A match is only a lead: the caller still confirms it by asking the provider's own API.
 */
export function findBoardRefs(html: string): BoardCandidate[] {
  const found: BoardCandidate[] = [];
  const seen = new Set<string>();
  for (const [provider, pattern] of PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const token = (match[1] ?? "").toLowerCase();
      if (!TOKEN_RE.test(token) || NOT_TOKENS.has(token)) continue;
      const key = `${provider}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ provider, token });
    }
  }
  return found;
}

/**
 * Likely board tokens for a company, best first: its name run together ("urbancompany"), hyphenated ("urban-company")
 * and the first label of its website ("stripe" from stripe.com). Guesses can be wrong or belong to another company, so
 * whoever uses them should look at what came back.
 */
export function guessTokens(name: string, website?: string): string[] {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const guesses = [words.join(""), words.join("-")];
  if (website) {
    try {
      const host = new URL(website).hostname.replace(/^www\./, "");
      guesses.push((host.split(".")[0] ?? "").toLowerCase());
    } catch {
      // not a URL: ignore it
    }
  }
  return [...new Set(guesses)].filter((token) => TOKEN_RE.test(token)).slice(0, 3);
}

export interface Evidence {
  /** How many times the company's name appears. */
  name: number;
  /** How many times its website's address appears. */
  domain: number;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How much a board's own answer says it belongs to this company: how often the company's name, and its website's address,
 * appear in it. A guessed board token can belong to another company with the same name, and a board that never mentions
 * the company it was matched to is almost certainly someone else's. Counts are of whole words, ignoring case. A name of
 * several words also counts its first word when that is long enough not to be common, because boards often say just "Grafana".
 */
export function boardEvidence(text: string, name: string, website?: string): Evidence {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const names = [words.join(" ")];
  const first = words[0];
  if (words.length > 1 && first !== undefined && first.length >= 5) names.push(first);

  const count = (needles: string[], before: string): number => {
    const alternatives = needles.filter((needle) => needle !== "").map(escapeRegex);
    if (alternatives.length === 0) return 0;
    const pattern = new RegExp(`(?<![${before}])(?:${alternatives.join("|")})(?![${before}])`, "giu");
    return [...text.matchAll(pattern)].length;
  };

  let host = "";
  if (website) {
    try {
      host = new URL(website).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      // not a URL: no address to look for
    }
  }
  return {
    // Longest first, so "Grafana Labs" is counted once and not again as "Grafana".
    name: count(names.sort((a, b) => b.length - a.length), "\\p{L}\\p{N}"),
    domain: count([host], "\\p{L}\\p{N}-"),
  };
}
