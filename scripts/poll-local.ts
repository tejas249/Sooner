/**
 * The Week 0 prototype: poll the boards in data/boards.json, wait, poll again, and print what changed.
 *
 *   npm run poll                                two rounds, five minutes apart (the guide's first-weekend test)
 *   npm run poll -- --rounds 12 --every 5m      watch for an hour
 *   npm run poll -- --only stripe,ramp          just these companies (slugs from data/boards.json)
 *   npm run poll -- --fresh                     forget what was saved and baseline again
 *
 * The first time a board is polled it is a baseline: its open roles are recorded and nothing is announced. From then on
 * the same rules as the real system apply (src/core/changes.ts): a role must be missing on two checks in a row before it
 * counts as closed, and a board that suddenly loses 40% of its roles is held back instead of believed.
 *
 * What is saved in .state/ (ETags and every role seen) lets a later run pick up where this one stopped, so running it
 * tomorrow morning shows what changed overnight.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { adapters } from "../src/core/adapters/index.ts";
import type { JobEvent } from "../src/core/changes.ts";
import { mapPool } from "../src/worker/pool.ts";
import { BoardEntries, type BoardEntry } from "./lib/boards-file.ts";
import { bold, dim, formatCount, formatDuration, green, parseInterval, red, safe } from "./lib/format.ts";
import { readJson } from "./lib/json-file.ts";
import { pollBoard } from "./lib/poll.ts";
import { renderChanges, renderDelays, renderSummaryLine, summarizeRound } from "./lib/report.ts";
import { createRuntime, run } from "./lib/runtime.ts";
import { emptyPollState, loadPollState, savePollState, type PollState } from "./lib/state-file.ts";

const keyOf = (board: BoardEntry): string => `${board.provider}:${board.token}`;
const clock = (ms: number): string => new Date(ms).toLocaleTimeString("en-GB");

run(async () => {
  const { values } = parseArgs({
    options: {
      rounds: { type: "string", default: "2" },
      every: { type: "string", default: "5m" },
      boards: { type: "string", default: "data/boards.json" },
      state: { type: "string", default: ".state/poll-local.json" },
      only: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "8" },
      fresh: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
  });

  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a whole number of at least 1");
  const everyMs = parseInterval(values.every);

  let boards = readJson(values.boards, BoardEntries, "the boards list");
  if (values.only) {
    const wanted = new Set(values.only.split(",").map((s) => s.trim()).filter(Boolean));
    boards = boards.filter((b) => wanted.has(b.slug));
    const missing = [...wanted].filter((slug) => !boards.some((b) => b.slug === slug));
    if (missing.length > 0) throw new Error(`no such company in ${values.boards}: ${missing.join(", ")}`);
  }
  if (values.limit) boards = boards.slice(0, Math.max(1, Number(values.limit) || 1));
  if (boards.length === 0) throw new Error("there are no boards to poll");

  // Ashby caches its feed for a minute, so asking more often than that only wastes both sides' time.
  const floorMs = Math.max(...boards.map((b) => adapters[b.provider].minIntervalSec)) * 1000;
  if (rounds > 1 && everyMs < floorMs) {
    throw new Error(`--every ${values.every} is too fast for these boards: Ashby caches for 60 seconds. Use at least ${floorMs / 1000}s.`);
  }

  const { fetcher, userAgent } = createRuntime();
  const concurrency = Math.max(1, Number(values.concurrency) || 8);
  const saved: PollState = values.fresh ? emptyPollState() : loadPollState(values.state);
  const resumed = !values.fresh && boards.some((b) => saved.boards[keyOf(b)]?.state.baselinedAt);

  console.log(bold("Sooner: local poll"));
  console.log(dim(`  ${boards.length} boards · ${rounds} round${rounds === 1 ? "" : "s"}${rounds > 1 ? `, one every ${values.every}` : ""} · at most one request per second to each provider`));
  console.log(dim(`  User-Agent: ${userAgent}`));
  console.log(dim(`  State: ${values.state}${resumed ? " (resuming from a previous run)" : " (starting fresh)"}`));

  let stopping = false;
  const wake = new AbortController();
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    wake.abort();
    console.log(dim("\nStopping after this round. Press Ctrl-C again to quit now. Progress is saved after every round."));
  });

  const allEvents: JobEvent[] = [];
  const failedEver = new Map<string, string>();
  let totalPolls = 0;
  let total304 = 0;
  let totalBytes = 0;
  let anySuccess = false;

  for (let round = 1; round <= rounds && !stopping; round++) {
    const startedAt = Date.now();
    console.log(`\n${bold(`Round ${round} of ${rounds}`)} · ${clock(startedAt)}`);

    let done = 0;
    const outcomes = await mapPool(boards, concurrency, async (board) => {
      const outcome = await pollBoard(fetcher, board, saved.boards[keyOf(board)]);
      done++;
      if (process.stdout.isTTY) process.stdout.write(`\r  polled ${done}/${boards.length} boards`);
      return outcome;
    });
    if (process.stdout.isTTY) process.stdout.write("\r\u001b[K");

    for (const { result, next } of outcomes) {
      if (next) saved.boards[keyOf(result.board)] = next;
    }
    savePollState(values.state, saved);

    const results = outcomes.map((o) => o.result);
    const summary = summarizeRound(results);
    totalPolls += summary.boards;
    total304 += summary.unchanged;
    totalBytes += summary.bytes;
    if (summary.failed < summary.boards) anySuccess = true;
    console.log(renderSummaryLine(summary, Date.now() - startedAt));

    if (summary.baseline === summary.boards) {
      console.log(green(`  Baseline recorded: ${formatCount(summary.openRoles)} open roles. Nothing is announced for roles that were already open.`));
    } else if (round === 1 && resumed) {
      console.log(dim("  Changes below are measured against the state saved by the previous run."));
    }

    if (values.verbose) {
      for (const r of results) {
        const what = r.kind === "failed" ? red(`failed: ${safe(r.reason ?? "")}`) : r.kind;
        console.log(dim(`    ${r.board.slug.padEnd(22)} ${keyOf(r.board).padEnd(36)} ${what} · HTTP ${r.status ?? "-"} · ${formatDuration(r.ms)}`));
      }
    }

    const changeLines = renderChanges(results, new Date());
    if (changeLines.length > 0) console.log(changeLines.join("\n"));
    else if (summary.baseline !== summary.boards) console.log(dim("  No changes since the last check."));

    const problems = results.filter((r) => r.kind === "failed");
    if (problems.length > 0) {
      console.log(`\n${bold(`Problems (${problems.length})`)}`);
      for (const p of problems) {
        failedEver.set(p.board.slug, safe(p.reason ?? "unknown"));
        console.log(`  ${red("!")} ${p.board.name} (${keyOf(p.board)}): ${safe(p.reason ?? "unknown")}. Nothing was changed for it; it will be tried again next round.`);
      }
    }

    for (const r of results) if (r.applied) allEvents.push(...r.applied.events);

    if (round < rounds && !stopping) {
      const nextAt = startedAt + everyMs;
      const wait = Math.max(0, nextAt - Date.now());
      console.log(dim(`\nNext round at ${clock(nextAt)} (in ${formatDuration(wait)}). Ctrl-C stops early; progress is saved.`));
      await sleep(wait, undefined, { signal: wake.signal }).catch(() => undefined);
    }
  }

  console.log(`\n${bold("Run summary")}`);
  console.log(`  ${totalPolls} polls · ${totalPolls === 0 ? 0 : Math.round((total304 / totalPolls) * 100)}% answered 304 · ${(totalBytes / 1_000_000).toFixed(1)} MB read in total`);
  for (const line of renderDelays(allEvents)) console.log(`  ${line}`);
  if (failedEver.size > 0) console.log(`  ${red(`${failedEver.size} board(s) had a problem at some point:`)} ${[...failedEver.keys()].join(", ")}`);
  console.log(dim(`  Saved to ${values.state}. Run the same command later to see what changed in between.`));

  return anySuccess ? 0 : 1;
});
