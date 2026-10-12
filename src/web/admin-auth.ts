import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who may open the admin page. There are no user accounts until week 4, so the page is protected by one password, which
 * lives in the ADMIN_PASSWORD environment variable and is sent as HTTP Basic authentication (the browser asks for it, once).
 *
 *  - With no password set, or one too short to be safe, the admin page does not exist: it answers 404 as if it were never
 *    built. A weak password never switches it on.
 *  - The username is ignored. Only the password matters.
 *  - The check runs in the proxy (so the browser is asked for the password) and again inside the page and every server action
 *    (so a request that skips the proxy still gets nothing). Both call the function below.
 *
 * Pure, so every case is unit-tested. Use a long random password, for example `openssl rand -base64 24`.
 */

/** A password shorter than this does not switch the admin page on. */
export const MIN_PASSWORD_LENGTH = 16;

export type AdminAccess =
  /** No usable password is set: the page does not exist. */
  | "off"
  /** There is one, and this request did not present it. */
  | "denied"
  | "allowed";

/** The configured password, or null when the admin page is switched off. */
export function adminPassword(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env["ADMIN_PASSWORD"];
  if (value === undefined) return null;
  return value.length >= MIN_PASSWORD_LENGTH ? value : null;
}

/** Why the page is off, for a log line or the setup message. Never contains the password. */
export function adminOffReason(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env["ADMIN_PASSWORD"];
  if (value === undefined || value === "") return "ADMIN_PASSWORD is not set";
  if (value.length < MIN_PASSWORD_LENGTH) return `ADMIN_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** Compares two strings in time that does not depend on how many leading characters match. */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The password in an `Authorization: Basic ...` header, or null if the header is missing or malformed. */
export function passwordFromBasicAuth(header: string | null): string | null {
  const match = /^Basic +(\S+)$/i.exec(header?.trim() ?? "");
  const encoded = match?.[1];
  if (encoded === undefined || !BASE64.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

export function adminAccess(env: Readonly<Record<string, string | undefined>>, authorization: string | null): AdminAccess {
  const expected = adminPassword(env);
  if (expected === null) return "off";
  const given = passwordFromBasicAuth(authorization);
  return given !== null && constantTimeEqual(given, expected) ? "allowed" : "denied";
}

/** The header that makes a browser ask for the password. */
export const CHALLENGE = 'Basic realm="Sooner admin", charset="UTF-8"';
