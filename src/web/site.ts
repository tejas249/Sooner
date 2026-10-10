/** Where the code lives. */
export const REPO_URL = "https://github.com/tejas249/Sooner";

/**
 * The public address of this deployment, for absolute links in page metadata. Set NEXT_PUBLIC_SITE_URL once the site has
 * its own domain; until then the Vercel project's production address is used.
 */
export function siteUrl(env: Record<string, string | undefined>): URL {
  const explicit = env["NEXT_PUBLIC_SITE_URL"];
  if (explicit) return new URL(explicit);
  const vercel = env["VERCEL_PROJECT_PRODUCTION_URL"];
  if (vercel) return new URL(`https://${vercel}`);
  return new URL("http://localhost:3000");
}
