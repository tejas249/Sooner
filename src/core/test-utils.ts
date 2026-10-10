import type { NormalizedJob } from "./types.ts";

/** Shared by the tests only. A fixed starting point so every test reads in minutes, not in dates. */
export const T0 = Date.parse("2026-10-08T12:00:00Z");

export const minutes = (n: number): Date => new Date(T0 + n * 60_000);

export const job = (id: string, over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  externalId: id,
  title: `Role ${id}`,
  location: "Remote",
  department: null,
  remote: true,
  url: `https://example.test/jobs/${id}`,
  postedAt: "2026-10-08T11:00:00.000Z",
  sourceUpdatedAt: null,
  ...over,
});

export const jobs = (...ids: string[]): NormalizedJob[] => ids.map((id) => job(id));

/** Ids "r1" ... "rN". */
export const many = (n: number, from = 1): NormalizedJob[] => Array.from({ length: n }, (_, i) => job(`r${from + i}`));

/** Freezes a value all the way down, so any attempt to change it throws instead of passing silently. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
