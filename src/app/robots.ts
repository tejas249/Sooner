import type { MetadataRoute } from "next";
import { siteUrl } from "../web/site.ts";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/admin"] }],
    sitemap: new URL("/sitemap.xml", siteUrl(process.env)).href,
  };
}
