import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { adapters as realAdapters } from "../core/adapters/index.ts";
import { TOKEN_RE, type Adapter } from "../core/adapters/shared.ts";
import { PROVIDERS, type NormalizedJob, type Provider } from "../core/types.ts";

/**
 * A mock job-board server, for tests. It speaks the three providers' formats on three local servers (one per provider, so
 * each is its own host as far as the politeness gate is concerned), and it can be told to misbehave on purpose: answer
 * slowly, answer 429 with Retry-After, answer 5xx or 404 or a redirect, send invalid JSON, cut a body off halfway, or never
 * answer. It records every request with the time it arrived, so a test can assert that no host ever received more than one
 * request per second.
 *
 * Point the real worker at it by passing `adapters` (see fetchBoard): they are the real adapters, with the same parsing and
 * the same limits, whose URLs lead here.
 */

const ROUTES: Record<Provider, RegExp> = {
  greenhouse: /^\/v1\/boards\/([^/]+)\/jobs$/,
  lever: /^\/v0\/postings\/([^/]+)$/,
  ashby: /^\/posting-api\/job-board\/([^/]+)$/,
};

const PATHS: Record<Provider, (token: string) => string> = {
  greenhouse: (token) => `/v1/boards/${token}/jobs`,
  lever: (token) => `/v0/postings/${token}?mode=json`,
  ashby: (token) => `/posting-api/job-board/${token}`,
};

/** Roles that every provider can represent, so the same test can run against any of them. */
export function mockRoles(provider: Provider, count: number, prefix = "r"): NormalizedJob[] {
  return Array.from({ length: count }, (_, i) => {
    const id = provider === "greenhouse" ? String(1000 + i) : `${prefix}${i + 1}`;
    return {
      externalId: id,
      title: `Software Engineer ${prefix}${i + 1}`,
      location: "Remote",
      department: provider === "greenhouse" ? null : "Engineering",
      remote: true,
      url: `https://example.test/jobs/${id}`,
      postedAt: "2026-10-01T10:00:00.000Z",
      sourceUpdatedAt: null,
    };
  });
}

/** Whether a provider's format can carry this role exactly. A role it cannot carry would not survive a round trip. */
function assertRepresentable(provider: Provider, role: NormalizedJob): void {
  const problems: string[] = [];
  if (provider === "greenhouse") {
    if (!/^\d+$/.test(role.externalId)) problems.push("a Greenhouse ID is a number");
    if (role.department !== null) problems.push("a Greenhouse list carries no department");
    const remoteWord = role.location !== null && /\bremote\b/i.test(role.location);
    if (role.remote !== (remoteWord ? true : null)) problems.push('a Greenhouse list says remote only through the word "remote" in the place');
  } else if (role.sourceUpdatedAt !== null) {
    problems.push(`${provider} carries no last-edit date`);
  }
  if (problems.length > 0) throw new Error(`role ${role.externalId} cannot be served as ${provider}: ${problems.join("; ")}`);
}

/** What a provider answers with when its board lists these roles. The real adapter turns it back into the same roles. */
export function providerBody(provider: Provider, roles: readonly NormalizedJob[]): string {
  roles.forEach((role) => assertRepresentable(provider, role));
  switch (provider) {
    case "greenhouse":
      return JSON.stringify({
        jobs: roles.map((role) => ({
          id: Number(role.externalId),
          title: role.title,
          absolute_url: role.url,
          first_published: role.postedAt,
          updated_at: role.sourceUpdatedAt,
          location: role.location === null ? null : { name: role.location },
        })),
        meta: { total: roles.length },
      });
    case "lever":
      return JSON.stringify(
        roles.map((role) => ({
          id: role.externalId,
          text: role.title,
          hostedUrl: role.url,
          createdAt: role.postedAt === null ? null : Date.parse(role.postedAt),
          workplaceType: role.remote === true ? "remote" : role.remote === false ? "on-site" : null,
          categories: { location: role.location, department: role.department },
        })),
      );
    case "ashby":
      return JSON.stringify({
        apiVersion: "1",
        jobs: roles.map((role) => ({
          id: role.externalId,
          title: role.title,
          jobUrl: role.url,
          isListed: true,
          publishedAt: role.postedAt,
          location: role.location,
          department: role.department,
          workplaceType: role.remote === true ? "Remote" : role.remote === false ? "OnSite" : null,
        })),
      });
  }
}

/** What one request is told to do instead of the normal answer. */
export interface Behavior {
  /** Answer with this status (and `body`, `headers`) instead of the board. */
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
  /** Send the first half of the answer, then drop the connection. */
  truncate?: boolean;
  /** Never answer; the connection stays open until the client gives up. */
  hang?: boolean;
}

export interface RequestRecord {
  provider: Provider;
  token: string;
  /** performance.now() when the request arrived. */
  at: number;
  ifNoneMatch: string | null;
  cacheControl: string | null;
  userAgent: string | null;
  acceptEncoding: string | null;
  /** How many requests to this provider's server were open when this one arrived, itself included. */
  concurrent: number;
  /** What was sent back; 0 until the answer starts. */
  status: number;
  /** True when the client went away before the answer was finished. */
  closedEarly: boolean;
}

export class MockBoard {
  roles: NormalizedJob[] = [];
  readonly #queue: Behavior[] = [];
  #always: Behavior | null = null;

  /** What the board lists from now on. */
  set(roles: readonly NormalizedJob[]): this {
    this.roles = [...roles];
    return this;
  }

  /** The next `times` requests (one by default) get this behaviour instead of the normal answer. */
  next(behavior: Behavior, times = 1): this {
    for (let i = 0; i < times; i++) this.#queue.push(behavior);
    return this;
  }

  /** Every request gets this behaviour until `normal()`. */
  always(behavior: Behavior): this {
    this.#always = behavior;
    return this;
  }

  normal(): this {
    this.#always = null;
    this.#queue.length = 0;
    return this;
  }

  /** @internal */
  take(): Behavior | null {
    return this.#queue.shift() ?? this.#always;
  }
}

export interface MockOptions {
  /** Compress answers when the client accepts gzip. */
  gzip?: boolean;
  /** Overrides the real adapters' request timeout, so a test of a timeout does not wait for the real one. */
  timeoutMs?: number;
  /**
   * Mimic Lever, which treats `Cache-Control: no-cache` as "skip your cache" and then ignores If-None-Match, so it never
   * answers 304 to a client that sends it. (Node's fetch sends it by itself whenever it sends If-None-Match; see fetcher.ts.)
   */
  leverIgnoresEtagOnNoCache?: boolean;
}

export interface MockProviders {
  /** The real adapters, with URLs that lead to the mock servers. */
  adapters: Record<Provider, Adapter>;
  board(provider: Provider, token: string): MockBoard;
  /** Every request, in the order they arrived. */
  readonly requests: readonly RequestRecord[];
  requestsFor(provider: Provider): RequestRecord[];
  /** The most requests to one provider's server that were open at the same moment. */
  maxConcurrent(provider: Provider): number;
  /** The shortest time between two requests arriving at one provider's server, in milliseconds (Infinity if fewer than two). */
  minGapMs(provider: Provider): number;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMockProviders(options: MockOptions = {}): Promise<MockProviders> {
  const boards = new Map<string, MockBoard>();
  const requests: RequestRecord[] = [];
  const open: Record<Provider, number> = { greenhouse: 0, lever: 0, ashby: 0 };
  const ignoresEtag = options.leverIgnoresEtagOnNoCache ?? true;
  const servers = new Map<Provider, http.Server>();
  const ports = new Map<Provider, number>();

  const boardKey = (provider: Provider, token: string): string => `${provider}:${token}`;
  const board = (provider: Provider, token: string): MockBoard => {
    const key = boardKey(provider, token);
    let found = boards.get(key);
    if (!found) boards.set(key, (found = new MockBoard()));
    return found;
  };

  function handler(provider: Provider): http.RequestListener {
    return (req, res) => {
      const url = new URL(req.url ?? "/", "http://mock.test");
      const token = ROUTES[provider].exec(url.pathname)?.[1];
      const header = (name: string): string | null => {
        const value = req.headers[name];
        return typeof value === "string" ? value : null;
      };
      open[provider]++;
      const record: RequestRecord = {
        provider,
        token: token ?? "",
        at: performance.now(),
        ifNoneMatch: header("if-none-match"),
        cacheControl: header("cache-control"),
        userAgent: header("user-agent"),
        acceptEncoding: header("accept-encoding"),
        concurrent: open[provider],
        status: 0,
        closedEarly: false,
      };
      requests.push(record);
      res.on("close", () => {
        open[provider]--;
        record.closedEarly = !res.writableFinished;
      });

      void (async () => {
        const mock = token !== undefined && boards.has(boardKey(provider, token)) ? board(provider, token) : null;
        if (!mock) {
          record.status = 404;
          res.writeHead(404, { "content-type": "application/json" }).end("{}");
          return;
        }
        const behavior = mock.take();
        if (behavior?.hang) return;
        if (behavior?.delayMs) await sleep(behavior.delayMs);
        if (res.destroyed) return;

        if (behavior?.status !== undefined && behavior.status !== 200) {
          record.status = behavior.status;
          res.writeHead(behavior.status, { "content-type": "application/json", ...behavior.headers }).end(behavior.body ?? "{}");
          return;
        }

        const body = behavior?.body ?? providerBody(provider, mock.roles);
        const etag = `W/"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
        const skipCache = provider === "lever" && ignoresEtag && /no-cache/i.test(record.cacheControl ?? "");
        if (!behavior && !skipCache && record.ifNoneMatch === etag) {
          record.status = 304;
          res.writeHead(304, { etag }).end();
          return;
        }

        const gzip = options.gzip === true && /\bgzip\b/.test(record.acceptEncoding ?? "");
        const payload = gzip ? gzipSync(body) : Buffer.from(body);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "cache-control": "public, max-age=60",
          ...(behavior ? {} : { etag }),
          ...(gzip ? { "content-encoding": "gzip" } : {}),
          ...behavior?.headers,
        };
        record.status = 200;
        if (behavior?.truncate) {
          res.writeHead(200, headers);
          res.write(payload.subarray(0, Math.floor(payload.length / 2)));
          setTimeout(() => req.socket.destroy(), 20);
          return;
        }
        res.writeHead(200, headers).end(payload);
      })();
    };
  }

  await Promise.all(
    PROVIDERS.map(
      (provider) =>
        new Promise<void>((resolve) => {
          const server = http.createServer(handler(provider));
          server.listen(0, "127.0.0.1", () => {
            servers.set(provider, server);
            ports.set(provider, (server.address() as AddressInfo).port);
            resolve();
          });
        }),
    ),
  );

  const adapters = Object.fromEntries(
    PROVIDERS.map((provider) => {
      const real = realAdapters[provider];
      const origin = `http://127.0.0.1:${ports.get(provider)}`;
      const adapter: Adapter = {
        ...real,
        host: `127.0.0.1:${ports.get(provider)}`,
        timeoutMs: options.timeoutMs ?? real.timeoutMs,
        url(token) {
          if (!TOKEN_RE.test(token)) throw new RangeError(`not a valid board token: ${JSON.stringify(token)}`);
          return `${origin}${PATHS[provider](token)}`;
        },
      };
      return [provider, adapter];
    }),
  ) as Record<Provider, Adapter>;

  return {
    adapters,
    board,
    requests,
    requestsFor: (provider) => requests.filter((r) => r.provider === provider),
    maxConcurrent: (provider) => Math.max(0, ...requests.filter((r) => r.provider === provider).map((r) => r.concurrent)),
    minGapMs(provider) {
      const times = requests.filter((r) => r.provider === provider).map((r) => r.at).sort((a, b) => a - b);
      let min = Infinity;
      for (let i = 1; i < times.length; i++) min = Math.min(min, (times[i] as number) - (times[i - 1] as number));
      return min;
    },
    async stop() {
      await Promise.all(
        [...servers.values()].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
