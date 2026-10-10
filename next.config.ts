import type { NextConfig } from "next";
import { securityHeaders } from "./src/web/security-headers";

const nextConfig: NextConfig = {
  // Don't announce which framework we run.
  poweredByHeader: false,
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: securityHeaders({ dev: process.env.NODE_ENV === "development" }) }]);
  },
};

export default nextConfig;
