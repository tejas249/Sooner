import type { MetadataRoute } from "next";
import { siteUrl } from "../web/site.ts";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: siteUrl(process.env).href }];
}
