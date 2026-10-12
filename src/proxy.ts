import { NextResponse, type NextRequest } from "next/server";
import { CHALLENGE, adminAccess } from "./web/admin-auth.ts";

/**
 * Guards the admin page. See web/admin-auth.ts for the rules; the page and its server actions check again themselves,
 * because a proxy is not a security boundary on its own.
 */
export function proxy(request: NextRequest): NextResponse {
  const access = adminAccess(process.env, request.headers.get("authorization"));

  if (access === "off") {
    // As if the page had never been built: the site's own 404, from an address that does not exist, so the answer, its caching
    // and its body are exactly what any unknown address gets. (Next adds a header saying the request was rewritten, which
    // is why the target's name says nothing about the admin page.)
    return NextResponse.rewrite(new URL("/page-not-found", request.url));
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
