import { createHash } from "node:crypto";
import type { NormalizedJob } from "./types.ts";

/**
 * Zero-width space, word joiner and the byte-order mark. Joiners and non-joiners (U+200C, U+200D) are left alone
 * because Indic and Persian scripts need them to shape words correctly.
 */
const INVISIBLE = new RegExp(["\\u200B", "\\u2060", "\\uFEFF"].join("|"), "g");

/**
 * Display text: collapse runs of whitespace into one space and trim. Zero-width characters are removed first because
 * they are invisible yet make two identical-looking titles compare as different. Control characters become spaces:
 * they have no place in a title, and the database cannot store a NUL at all.
 */
export const clean = (s?: string | null): string =>
  (s ?? "").replace(INVISIBLE, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();

/** Control characters: NUL, the bell, escape codes and the rest of the C0 and C1 ranges (\p{Cc}). */
export const hasControlCharacter = (s: string): boolean => /\p{Cc}/u.test(s);

/**
 * Comparison text: lower-case, accents removed from Latin letters, every run of punctuation or symbols becomes one
 * space.
 *   'Senior Software Engineer (Remote) - US'  ->  'senior software engineer remote us'
 *   'Zürich'                                  ->  'zurich'
 * Two traps this avoids. Turning the combining mark of 'ü' (u + mark) into a space would give 'zu rich'. And stripping
 * every combining mark would damage other scripts: it turns the katakana 'ジ' into 'シ' and deletes the vowel signs of
 * Devanagari. So marks are removed only after Latin letters, the rest is recomposed, and marks never count as
 * punctuation.
 */
export const norm = (s?: string | null): string =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();

export const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** A fingerprint of the fields we show and alert on. A different hash for the same ID means the role was edited. */
export const contentHash = (j: Pick<NormalizedJob, "title" | "location" | "department" | "remote" | "url">): string =>
  sha1([clean(j.title), clean(j.location), clean(j.department), j.remote ?? "", j.url].join("\u0001"));
