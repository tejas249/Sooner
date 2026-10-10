/**
 * Works out which job board each company in data/candidates.json uses, confirms it with the provider's own API, and
 * writes the confirmed ones to data/boards.json (the seed for the `company` and `board` tables).
 *
 *   npm run detect                       confirm the whole list and rewrite data/boards.json
 *   npm run detect -- --dry              look, but write nothing
 *   npm run detect -- --no-guess         trust only what the list says; do not try names
 *
 * For each company it tries, in order:
 *   1. the boards you listed ("boards": ["greenhouse:stripe"]),
 *   2. the careers page, read once for links to a job board ("careers": "https://..."),
 *   3. guesses from the company's name and website, on all three providers.
 * A board only counts when the provider's API answers 200 with a shape its adapter understands. Guesses can still land
 * on another company's board, so every guess is shown for you to check.
 *
 * Every request goes through the same politeness gate as polling (one per second per host).
 * The careers page is fetched from the list you wrote. Never point this at addresses other people can type.
 */
import { parseArgs } from "node:util";
import { findBoardRefs, guessTokens } from "../src/core/detect.ts";
import { PROVIDERS, isProvider } from "../src/core/types.ts";
import { fetchBoard, type BoardRef } from "../src/worker/fetch-board.ts";
import type { Fetcher } from "../src/worker/fetcher.ts";
import { mapPool } from "../src/worker/pool.ts";
import { BoardEntries, Candidates, slugify, type BoardEntry, type Candidate } from "./lib/boards-file.ts";
import { bold, column, dim, formatDuration, green, red, yellow } from "./lib/format.ts";
import { readJson, writeJson } from "./lib/json-file.ts";
import { createRuntime, run } from "./lib/runtime.ts";

type Via = BoardEntry["confirmedVia"];

type Detection =
  | { kind: "found"; ref: BoardRef; roles: number; via: Via; sampleHost: string | null }
  | { kind: "missing"; tried: string[]; notes: string[] }
  | { kind: "unreachable"; tried: string[]; reason: string };

type Probe =
  | { kind: "found"; roles: number; sampleHost: string | null }
  | { kind: "missing" }
  | { kind: "unreachable"; reason: string };

const spec = (ref: BoardRef): string => `${ref.provider}:${ref.token}`;

async function probe(fetcher: Fetcher, ref: BoardRef): Promise<Probe> {
  const out = await fetchBoard(fetcher, ref);
  switch (out.kind) {
    case "ok": {
      const first = out.jobs[0];
      return { kind: "found", roles: out.jobs.length, sampleHost: first ? new URL(first.url).host : null };
    }
    case "error":
      return out.status === 404 ? { kind: "missing" } : { kind: "unreachable", reason: out.reason };
    case "unchanged":
      return { kind: "missing" }; // cannot happen without an ETag
    case "retry":
    case "invalid":
      return { kind: "unreachable", reason: out.reason };
  }
}

async function detect(fetcher: Fetcher, candidate: Candidate, guessing: boolean): Promise<Detection> {
  const tried: string[] = [];
  const notes: string[] = [];
  let unreachable: string | null = null;

  const attempt = async (ref: BoardRef, via: Via): Promise<Detection | null> => {
    if (tried.includes(spec(ref))) return null;
    tried.push(spec(ref));
    const result = await probe(fetcher, ref);
    if (result.kind === "unreachable") unreachable = `${spec(ref)}: ${result.reason}`;
    // An empty board is plausible for a hint, but a guess that finds nothing is more likely the wrong company.
    if (result.kind === "found" && (via !== "guess" || result.roles > 0)) {
      return { kind: "found", ref, roles: result.roles, via, sampleHost: result.sampleHost };
    }
    return null;
  };

  for (const hint of candidate.boards ?? []) {
    const [provider, token] = hint.split(":");
    if (!isProvider(provider) || !token) continue;
    const found = await attempt({ provider, token }, "hint");
    if (found) return found;
  }

  if (candidate.careers) {
    const page = await fetcher.get(candidate.careers, { accept: "text/html", maxRedirects: 3, maxBytes: 3_000_000 });
    if (page.kind !== "ok") {
      notes.push(`careers page: ${page.kind === "unchanged" ? "unexpected 304" : page.reason}`);
    } else {
      const refs = findBoardRefs(page.text);
      if (refs.length === 0) notes.push("careers page: no job-board links in the HTML (it may be built by JavaScript)");
      for (const ref of refs) {
        const found = await attempt(ref, "careers");
        if (found) return found;
      }
    }
  }

  if (guessing) {
    for (const token of guessTokens(candidate.name, candidate.website)) {
      for (const provider of PROVIDERS) {
        const found = await attempt({ provider, token }, "guess");
        if (found) return found;
      }
    }
  }

  return unreachable ? { kind: "unreachable", tried, reason: unreachable } : { kind: "missing", tried, notes };
}

run(async () => {
  const { values } = parseArgs({
    options: {
      candidates: { type: "string", default: "data/candidates.json" },
      out: { type: "string", default: "data/boards.json" },
      "no-guess": { type: "boolean", default: false },
      dry: { type: "boolean", default: false },
      concurrency: { type: "string", default: "6" },
    },
  });

  const candidates = readJson(values.candidates, Candidates, "the candidate list");
  const slugs = new Set<string>();
  for (const c of candidates) {
    const slug = c.slug ?? slugify(c.name);
    if (slugs.has(slug)) throw new Error(`two candidates share the slug "${slug}". Give one of them a "slug".`);
    slugs.add(slug);
  }

  const { fetcher, userAgent } = createRuntime();
  console.log(dim(`User-Agent: ${userAgent}`));
  console.log(`Checking ${candidates.length} companies (one request per second per provider at most)...\n`);

  const started = Date.now();
  let done = 0;
  const results = await mapPool(candidates, Math.max(1, Number(values.concurrency) || 6), async (candidate) => {
    const detection = await detect(fetcher, candidate, !values["no-guess"]);
    done++;
    const prefix = `${String(done).padStart(3)}/${candidates.length} ${column(candidate.name, 24)}`;
    if (detection.kind === "found") {
      const flag = detection.via === "guess" ? yellow(" check it") : "";
      const host = detection.sampleHost ? dim(`  jobs link to ${detection.sampleHost}`) : "";
      console.log(`${prefix} ${green(column(spec(detection.ref), 34))} ${String(detection.roles).padStart(4)} roles  ${dim(`(${detection.via})`)}${flag}${host}`);
    } else if (detection.kind === "unreachable") {
      console.log(`${prefix} ${red("could not tell")}  ${detection.reason}`);
    } else {
      const why = [...(detection.tried.length > 0 ? [`tried ${detection.tried.join(", ")}`] : []), ...detection.notes];
      console.log(`${prefix} ${red("not found")}  ${dim(why.join("; ") || "nothing to try: add boards, a careers page, or allow guessing")}`);
    }
    return detection;
  });

  const entries: BoardEntry[] = [];
  const seenBoards = new Map<string, string>();
  candidates.forEach((candidate, i) => {
    const detection = results[i];
    if (detection?.kind !== "found") return;
    const key = spec(detection.ref);
    const owner = seenBoards.get(key);
    if (owner) {
      console.log(yellow(`\n${candidate.name} resolves to ${key}, which ${owner} already uses. Skipping the second.`));
      return;
    }
    seenBoards.set(key, candidate.name);
    entries.push({
      slug: candidate.slug ?? slugify(candidate.name),
      name: candidate.name,
      segment: candidate.segment,
      ...(candidate.country ? { country: candidate.country } : {}),
      provider: detection.ref.provider,
      token: detection.ref.token,
      rolesWhenConfirmed: detection.roles,
      confirmedVia: detection.via,
    });
  });
  entries.sort((a, b) => a.segment.localeCompare(b.segment) || a.name.localeCompare(b.name));
  BoardEntries.parse(entries); // never write a file the poller would refuse to read

  const count = (pick: (e: BoardEntry) => string) => {
    const tally = new Map<string, number>();
    for (const e of entries) tally.set(pick(e), (tally.get(pick(e)) ?? 0) + 1);
    return [...tally].map(([key, n]) => `${key} ${n}`).join(" · ");
  };
  console.log(`\n${bold(`${entries.length} of ${candidates.length} confirmed`)} in ${formatDuration(Date.now() - started)}`);
  console.log(dim(`  by provider: ${count((e) => e.provider)}`));
  console.log(dim(`  by segment:  ${count((e) => e.segment)}`));
  console.log(dim(`  roles:       ${entries.reduce((sum, e) => sum + e.rolesWhenConfirmed, 0)} open across them`));
  const guesses = entries.filter((e) => e.confirmedVia === "guess");
  if (guesses.length > 0) {
    console.log(yellow(`  ${guesses.length} came from a guess. Check each one really is that company, then add it to "boards" in the candidate list.`));
  }

  if (values.dry) {
    console.log("\n--dry: nothing written.");
  } else {
    writeJson(values.out, entries);
    console.log(`\nWrote ${values.out}`);
  }
  return 0;
});
