/**
 * "Check it yourself", as a script: does each provider's public feed still look the way the guide says?
 *
 *   npm run feeds:check                                    one board per provider
 *   npm run feeds:check -- --board lever:plaid             pick boards yourself (repeatable)
 *
 * For each board it fetches the whole list, runs it through the adapter, then repeats the request with the ETag to see
 * whether the provider answers 304. About six requests in all. Exits 1 when something has changed, which is also how the
 * weekly canary in CI learns that a provider changed its format before any user does.
 */
import { parseArgs } from "node:util";
import { isProvider } from "../src/core/types.ts";
import { fetchBoard, type BoardRef } from "../src/worker/fetch-board.ts";
import type { Fetcher } from "../src/worker/fetcher.ts";
import { bold, dim, formatAgo, formatBytes, formatDuration, green, median, red } from "./lib/format.ts";
import { createRuntime, run } from "./lib/runtime.ts";

const DEFAULT_BOARDS = ["greenhouse:stripe", "lever:spotify", "ashby:ramp"];
const DAY_MS = 86_400_000;

function parseBoard(spec: string): BoardRef {
  const [provider, token] = spec.split(":");
  if (!isProvider(provider) || !token) throw new Error(`"${spec}" is not a board. Use provider:token, for example greenhouse:stripe.`);
  return { provider, token };
}

/** Prints the result of one board and returns how many of its checks failed. */
async function checkBoard(fetcher: Fetcher, ref: BoardRef): Promise<number> {
  const label = `${ref.provider}:${ref.token}`;
  const first = await fetchBoard(fetcher, ref);
  if (first.kind !== "ok") {
    const why = first.kind === "unchanged" ? "unexpected 304" : first.reason;
    console.log(`${red("FAIL")} ${bold(label)}  ${first.kind}: ${why}`);
    return 1;
  }

  const now = Date.now();
  const total = first.jobs.length;
  const ages = first.jobs.flatMap((j) => (j.postedAt ? [(now - Date.parse(j.postedAt)) / DAY_MS] : []));
  const dated = ages.length;

  const checks: Array<{ ok: boolean; text: string }> = [
    { ok: total > 0, text: `${total} open roles` },
    { ok: total > 0 && dated / total >= 0.99, text: `${dated} of ${total} carry a posting date` },
    { ok: first.etag !== null, text: first.etag ? `sends an ETag (${first.etag.startsWith("W/") ? "weak" : "strong"})` : "sends no ETag" },
  ];
  if (first.etag) {
    const again = await fetchBoard(fetcher, { ...ref, etag: first.etag });
    checks.push({
      ok: again.kind === "unchanged",
      text: again.kind === "unchanged" ? `answers a repeat request with 304 in ${formatDuration(again.ms)}` : `did not answer 304 (got ${again.kind})`,
    });
  }

  const failures = checks.filter((c) => !c.ok).length;
  console.log(`${failures === 0 ? green("ok  ") : red("FAIL")} ${bold(label)}`);
  for (const c of checks) console.log(`       ${c.ok ? green("✓") : red("✗")} ${c.text}`);

  const facts = [
    ages.length > 0 ? `median age ${Math.round(median(ages) ?? 0)} d` : null,
    ages.length > 0 ? `newest ${formatAgo(Math.min(...ages) * DAY_MS)} ago` : null,
    `${formatBytes(first.bytes)}${first.contentEncoding ? ` decoded (${first.contentEncoding} on the wire)` : ", not compressed"}`,
    `${formatDuration(first.ms)}`,
    first.cacheControl ? `cache-control: ${first.cacheControl}` : "no cache-control",
  ].filter(Boolean);
  console.log(dim(`       ${facts.join(" · ")}`));
  return failures;
}

run(async () => {
  const { values } = parseArgs({ options: { board: { type: "string", multiple: true } } });
  const refs = (values.board && values.board.length > 0 ? values.board : DEFAULT_BOARDS).map(parseBoard);
  const { fetcher, userAgent } = createRuntime();

  console.log(dim(`User-Agent: ${userAgent}\n`));
  let failures = 0;
  for (const ref of refs) failures += await checkBoard(fetcher, ref);

  console.log(failures === 0 ? green("\nAll feeds look the way the guide says.") : red(`\n${failures} check(s) failed.`));
  return failures === 0 ? 0 : 1;
});
