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
 * A board only counts when the provider's API answers 200 with a shape its adapter understands. A guess can land on another
 * company's board, so a guessed board must also mention the company: its name or its website's address has to appear in
 * the board's own answer, or the guess is ignored. Every guess is shown with that evidence for you to check, and so is
 * every hint, since a hint can be a typo.
 *
 * Every request goes through the same politeness gate as polling (one per second per host).
 * The careers page is fetched from the list you wrote. Never point this at addresses other people can type.
 */
import { parseArgs } from "node:util";
import { mapPool } from "../src/worker/pool.ts";
import { BoardEntries, Candidates, slugify, type BoardEntry } from "./lib/boards-file.ts";
import { detect, spec } from "./lib/detect.ts";
import { bold, column, dim, formatDuration, green, red, yellow } from "./lib/format.ts";
import { readJson, writeJson } from "./lib/json-file.ts";
import { createRuntime, run } from "./lib/runtime.ts";

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
      const { name, domain } = detection.evidence;
      const proof = name + domain === 0 ? red("  nothing in it mentions the company: is it the right board?") : dim(`  name x${name}, address x${domain}`);
      const host = detection.sampleHost ? dim(`  jobs link to ${detection.sampleHost}`) : "";
      console.log(`${prefix} ${green(column(spec(detection.ref), 34))} ${String(detection.roles).padStart(4)} roles  ${dim(`(${detection.via})`)}${proof}${host}`);
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
      ...(candidate.priority ? { priority: true } : {}),
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
    console.log(yellow(`  ${guesses.length} came from a guess that the board's own text backs up. Add each to "boards" in the candidate list so the next run does not have to guess.`));
  }

  if (values.dry) {
    console.log("\n--dry: nothing written.");
  } else {
    writeJson(values.out, entries);
    console.log(`\nWrote ${values.out}`);
  }
  return 0;
});
