// The security headers sent with every response (wired up in next.config.ts). Pure, so the policy is unit-tested.
//
// Content-Security-Policy, and a trade-off worth knowing: the strictest form (a fresh nonce on every script) forces every
// page to be rendered per request, which would turn the static pages dynamic. So scripts allow 'unsafe-inline' (Next's own
// inline bootstrap scripts need it) and everything else is locked down: nothing can frame the site, no plugins, no <base>
// or form hijacking, and images, fonts and network calls may only go to the site itself.
//
// When the site starts using an outside service (analytics, an error reporter), add its address here.

export interface Header {
  key: string;
  value: string;
}

export function contentSecurityPolicy({ dev = false }: { dev?: boolean } = {}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'unsafe-eval' only in development: React uses it for readable error stacks there. Not needed in production.
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(dev ? ["ws://localhost:*", "ws://127.0.0.1:*"] : [])],
    "frame-src": ["'none'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests"); // would break plain-http localhost
  return parts.join("; ");
}

export function securityHeaders({ dev = false }: { dev?: boolean } = {}): Header[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ dev }) },
    // Browsers only honour this over https, so it is harmless on localhost. A year, subdomains included.
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" }, // older browsers; the CSP's frame-ancestors covers the rest
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Nothing here needs the camera, microphone, location, payments or sensors.
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=(), browsing-topics=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ];
}
