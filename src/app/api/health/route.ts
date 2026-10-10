import { health } from "../../../web/health.ts";

// Liveness plus "which build is this?". The post-deploy smoke test compares `commit` with the commit that was just pushed.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(health(process.env), { headers: { "cache-control": "no-store" } });
}
