import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export function readJson<S extends z.ZodType>(path: string, schema: S, what: string): z.output<S> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${what} at ${path}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${what} at ${path} is not valid JSON`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${what} at ${path} is not in the expected format:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Writes the file whole or not at all, so an interrupted run never leaves half a file behind. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}
