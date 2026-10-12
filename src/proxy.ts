import { NextResponse, type NextRequest } from "next/server";
import { CHALLENGE, adminAccess } from "./web/admin-auth.ts";

/**
 * Guards the admin page. See web/admin-auth.ts for the rules; the page and its server actions check again themselves,
 * because a proxy is not a security boundary on its own.
 */
export function proxy(request: NextRequest): NextResponse {
  const access = adminAccess(process.env, request.headers.get("authorization"));

  if (access === "off") {
    // As if the page had never been built: Next's own 404, from a path that does not exist.
    return NextResponse.rewrite(new URL("/not-found-admin-is-off", request.url));
  }
  if (access === "denied") {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": CHALLENGE, "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  const response = NextResponse.next();
  // An admin page is never cached by a browser or a CDN, and never indexed.
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
