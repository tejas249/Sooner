import { createFetcher, type Fetcher } from "../../src/worker/fetcher.ts";
import { HostGate } from "../../src/worker/gate.ts";
import { buildUserAgent } from "../../src/worker/user-agent.ts";

/** One politeness gate and one User-Agent for everything a script fetches. Throws when HR_CONTACT is not set. */
export function createRuntime(): { fetcher: Fetcher; userAgent: string } {
  const userAgent = buildUserAgent(process.env["HR_CONTACT"]);
  return { fetcher: createFetcher({ userAgent, gate: new HostGate() }), userAgent };
}

/** Runs a script's main function and turns any failure into one readable line and a non-zero exit code. */
export function run(main: () => Promise<number | void>): void {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error: unknown) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
