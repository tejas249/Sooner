import { boardEvidence, findBoardRefs, guessTokens, type Evidence } from "../../src/core/detect.ts";
import { PROVIDERS, isProvider } from "../../src/core/types.ts";
import { fetchBoard, type BoardRef } from "../../src/worker/fetch-board.ts";
import type { Fetcher } from "../../src/worker/fetcher.ts";
import { type BoardEntry, type Candidate } from "./boards-file.ts";

/** How a board was found: a hint from the list, a link on the careers page, or a guess from the company's name. */
export type Via = BoardEntry["confirmedVia"];

export type Detection =
  | { kind: "found"; ref: BoardRef; roles: number; via: Via; sampleHost: string | null; evidence: Evidence }
  | { kind: "missing"; tried: string[]; notes: string[] }
  | { kind: "unreachable"; tried: string[]; reason: string };

type Probe =
  | { kind: "found"; roles: number; sampleHost: string | null; evidence: Evidence }
  | { kind: "missing" }
  | { kind: "unreachable"; reason: string };

export const spec = (ref: BoardRef): string => `${ref.provider}:${ref.token}`;

async function probe(fetcher: Fetcher, ref: BoardRef, candidate: Candidate): Promise<Probe> {
  const out = await fetchBoard(fetcher, ref, { keepText: true });
  switch (out.kind) {
    case "ok": {
      const first = out.jobs[0];
      return {
        kind: "found",
        roles: out.jobs.length,
        sampleHost: first ? new URL(first.url).host : null,
        evidence: boardEvidence(out.text ?? "", candidate.name, candidate.website),
      };
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

/**
 * Works out which board a company uses, trying in order the boards the list names, the links on its careers page and (when
 * `guessing`) guesses from its name and website. A board only counts when the provider's own API answers with a shape its
 * adapter understands. A guess must also mention the company, and must not be empty: either way it is more likely someone
 * else's board. A hint is believed, but the evidence is returned for it too, so a typo shows.
 */
export async function detect(fetcher: Fetcher, candidate: Candidate, guessing: boolean): Promise<Detection> {
  const tried: string[] = [];
  const notes: string[] = [];
  let unreachable: string | null = null;

  const attempt = async (ref: BoardRef, via: Via): Promise<Detection | null> => {
    if (tried.includes(spec(ref))) return null;
    tried.push(spec(ref));
    const result = await probe(fetcher, ref, candidate);
    if (result.kind === "unreachable") unreachable = `${spec(ref)}: ${result.reason}`;
    if (result.kind !== "found") return null;
    if (via === "guess") {
      // An empty board is plausible for a hint, but a guess that finds nothing is more likely the wrong company.
      if (result.roles === 0) return null;
      // A board that never mentions the company belongs to someone else with the same name.
      if (result.evidence.name + result.evidence.domain === 0) {
        notes.push(`${spec(ref)} exists but never mentions ${candidate.name}, so it was ignored`);
        return null;
      }
    }
    return { kind: "found", ref, roles: result.roles, via, sampleHost: result.sampleHost, evidence: result.evidence };
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
