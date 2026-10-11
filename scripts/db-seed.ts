/**
 * Puts the companies and boards of data/boards.json into the database named by DATABASE_URL.
 *
 *   npm run db:seed                            add what is missing; change nothing that is already there
 *   npm run db:seed -- --spread 5m             start the new boards' first polls spread over this long (default 1m)
 *   npm run db:seed -- --deactivate-missing    also switch off boards that are in the database but not in the file
 *   npm run db:seed -- --boards other.json
 *
 * Safe to run again at any time: a board that exists keeps its schedule, its ETag and its failure count, and a board that
 * was switched off stays off. That last part is how an opt-out is honoured: switch the board off in the database
 * (`update board set active = false where ...`) and no seed will bring it back.
 */
import { parseArgs } from "node:util";
import { BoardEntries } from "../src/core/boards.ts";
import { createPool } from "../src/db/pool.ts";
import { seedBoards } from "../src/db/seed.ts";
import { databaseUrlFrom, describeDatabase } from "../src/db/url.ts";
import { bold, dim, green, parseInterval, yellow } from "./lib/format.ts";
import { readJson } from "./lib/json-file.ts";
import { run } from "./lib/runtime.ts";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

run(async () => {
  const { values } = parseArgs({
    options: {
      boards: { type: "string", default: "data/boards.json" },
      spread: { type: "string", default: "1m" },
      "deactivate-missing": { type: "boolean", default: false },
    },
  });
  const entries = readJson(values.boards, BoardEntries, "the boards list");
  const spreadSec = Math.round(parseInterval(values.spread) / 1000);
  const url = databaseUrlFrom(process.env);
  const pool = createPool(url, { max: 2, applicationName: "sooner-seed" });

  try {
    console.log(`${bold("Sooner: seed")} ${dim(`${plural(entries.length, "board")} from ${values.boards} into ${describeDatabase(url)}`)}`);
    const report = await seedBoards(pool, entries, {
      now: new Date(),
      spreadSec,
      deactivateMissing: values["deactivate-missing"],
    });
    console.log(`  companies: ${report.companiesAdded} added, ${report.companiesUpdated} updated`);
    console.log(`  boards:    ${report.boardsAdded} added${report.boardsAdded > 0 ? ` (first polls spread over ${values.spread})` : ""}, ${report.boardsAlreadyThere} already there`);
    if (report.boardsSwitchedOff.length > 0) {
      console.log(yellow(`  ${plural(report.boardsSwitchedOff.length, "board")} in the list ${report.boardsSwitchedOff.length === 1 ? "is" : "are"} switched off in the database and stay off: ${report.boardsSwitchedOff.join(", ")}`));
    }
    if (report.boardsDeactivated.length > 0) {
      console.log(yellow(`  switched off ${plural(report.boardsDeactivated.length, "board")} that ${report.boardsDeactivated.length === 1 ? "is" : "are"} no longer in the list: ${report.boardsDeactivated.join(", ")}`));
    } else if (report.boardsNotInList.length > 0) {
      console.log(
        yellow(`  ${plural(report.boardsNotInList.length, "board")} in the database ${report.boardsNotInList.length === 1 ? "is" : "are"} not in the list and still polled: ${report.boardsNotInList.join(", ")}. Use --deactivate-missing to stop polling them.`),
      );
    }
    console.log(green("  Done."));
  } finally {
    await pool.end();
  }
});
