import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { adminAccess } from "../../web/admin-auth.ts";

/**
 * Answers 404 unless this request presents the admin password. The proxy already asked the browser for it, but a proxy is
 * not a security boundary on its own (a server action is just a POST to this route), so the page and every server action call
 * this too, and the answer is the same 404 an unknown address gets.
 */
export async function requireAdmin(): Promise<void> {
  const access = adminAccess(process.env, (await headers()).get("authorization"));
  if (access !== "allowed") notFound();
}
