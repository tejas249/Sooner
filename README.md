# Sooner

Watches the public job-board feeds of a few hundred companies and tells you when a role opens, how long it has really been
open, and whether the company tends to fill its roles at all.

This is the **week 1 ingestion core** from the build guide, on top of the week 0 prototype: a worker that polls 50 company
boards every five minutes, records what it sees in Postgres, and tells apart roles that are new, edited, closed, reopened and
reposted, plus a landing page deployed on Vercel. There is no web app on top of the data yet and there are no alerts: those
are weeks 3 and 4. (The week 0 laptop poller, `npm run poll`, still works with no database at all.)

Live: https://sooner-tejas-kambles-projects-b2a75374.vercel.app

## Try it

```bash
npm install
cp .env.example .env        # then put your email address or a URL in HR_CONTACT
npm run feeds:check         # do the three providers still look the way the guide says? (about 6 requests)
npm run poll                # poll the 50 boards, wait 5 minutes, poll again, print what changed
```

`HR_CONTACT` goes into the `User-Agent` of every request so a company that does not want to be polled can reach you. The
scripts refuse to fetch anything while it is empty. Use an address you actually read.

### With a database (week 1)

```bash
npm run db:dev        # terminal 1: a real Postgres on this machine, no Docker needed
npm run db:migrate    # terminal 2: create the tables
npm run db:seed       # add the 50 companies and boards
npm run worker        # poll them until Ctrl-C (or `npm run worker -- --once`)
```

The worker prints one JSON line per poll. [docs/worker.md](docs/worker.md) explains how it works, how to deploy it and how to
look after it; [docs/operating.sql](docs/operating.sql) has the queries for checking on it.

Requires Node 24 or newer (the scripts run as TypeScript directly, with no build step).

## What it does

| Guide, "The first 48 hours" | Where it lives |
| --- | --- |
| Confirm the three feeds still look the way the guide says | `npm run feeds:check` ([scripts/check-feeds.ts](scripts/check-feeds.ts)). Also the weekly canary in CI |
| Greenhouse adapter, one recorded fixture and a test | [src/core/adapters/greenhouse.ts](src/core/adapters/greenhouse.ts), [fixtures/](fixtures/README.md). Lever and Ashby are done too, since the 50 boards use all three |
| Hand-pick 50 companies, write `detect-ats`, seed the boards | [data/candidates.json](data/candidates.json) goes through `npm run detect` ([scripts/detect-ats.ts](scripts/detect-ats.ts)) and becomes [data/boards.json](data/boards.json) |
| Poll them, poll again five minutes later, print what changed | `npm run poll` ([scripts/poll-local.ts](scripts/poll-local.ts)) |
| Push with CI green | [.github/workflows/ci.yml](.github/workflows/ci.yml) runs typecheck, lint, tests and the site build on every push and pull request (and, since week 1, the database tests and a build of the worker's image) |
| The `vercel.json` build gate, security headers and design tokens | [vercel.json](vercel.json), [src/web/security-headers.ts](src/web/security-headers.ts) and [src/app/globals.css](src/app/globals.css). See [Deployment](#deployment) |

The 50 boards: 27 global, 15 Indian, 8 remote-first; 26 on Greenhouse, 16 on Ashby, 8 on Lever.

| Guide, "Week 1: the ingestion core" | Where it lives |
| --- | --- |
| Lever and Ashby adapters with fixtures | Done in week 0, since the 50 boards use all three |
| The schema, the migrations and the extra SQL | [migrations/0001_init.sql](migrations/0001_init.sql): five tables, the partial and search indexes, and constraints that make the database refuse impossible states. Plain SQL files applied by a small runner with checksums and a lock ([src/db/migrate.ts](src/db/migrate.ts)). The tables for users, watches and alert delivery arrive with the weeks that use them |
| `applySnapshot` and `strikeMissing`, with the property tests | Done in week 0 as a pure function ([src/core/changes.ts](src/core/changes.ts)). Week 1 adds what turns its answer into rows: [planWrites](src/core/persist.ts), the transaction in [src/worker/settle.ts](src/worker/settle.ts), repost detection, and a property test that the database ends up with exactly the rows the pure reducer says |
| The worker loop: claiming, the host gate, conditional requests, the interval maths | [claim.ts](src/worker/claim.ts), [loop.ts](src/worker/loop.ts), [poll-task.ts](src/worker/poll-task.ts), [schedule.ts](src/core/schedule.ts) |
| Deploy the worker and the database | The image and everything a deploy needs are built and tested ([Dockerfile](Dockerfile), [docs/worker.md](docs/worker.md)). **Creating the hosted database and the worker host is yours to do**: it needs accounts and a real contact address |

### `npm run poll`

```bash
npm run poll                              # two rounds, five minutes apart
npm run poll -- --rounds 12 --every 5m    # watch for an hour
npm run poll -- --only stripe,ramp        # just these companies (slugs from data/boards.json)
npm run poll -- --fresh                   # forget what was saved and baseline again
npm run poll -- --verbose                 # one line per board per round
```

The first poll of a board is a **baseline**: its open roles are recorded and nothing is announced for them. After that:

- `+` a new role appeared, with how long ago its employer posted it,
- `~` an existing role was edited (title, place, department, remote flag or link),
- `-` a role closed, after it was missing on **two checks in a row**,
- `?` a role is missing once and waiting for its second check,
- `!` a board lost 40% or more of its roles at once. That is held back (three checks over 20 minutes) instead of believed.

Everything is saved to `.state/` after each round, so running it again tomorrow shows what changed overnight. At the end it
prints the detection delay for new roles that carry a provider date.

### `npm run detect`

Reads `data/candidates.json`, and for each company tries the boards you listed, then its careers page, then guesses from its
name. A board counts only when the provider's own API answers with a shape its adapter understands. Guesses are flagged
because they can land on a different company with the same name (two did while building this list: a San Francisco
startup called Navi and a pizza marketplace called Slice).

`data/candidates.more.json` holds 32 more companies whose boards were verified the same way, ready to move into
`candidates.json` when you grow toward 300.

## How it is built

```
src/core/      pure TypeScript: adapters (parse only), text normalising, change detection, schedule maths, write planning
src/db/        the database layer: connection pool, migration runner, seeding, and the test harness (src/db/testing)
src/worker/    the worker: politeness gate, fetcher, claiming, the transaction that applies a poll, the loop, the entry point
src/web/       small pure helpers for the website: security headers, the health report, the page's numbers
src/app/       the Next.js site: the landing page, /api/health, robots and sitemap
migrations/    the schema as numbered SQL files, never edited once applied
scripts/       the commands above (poll, detect, db:migrate, db:seed, build:worker), their helpers and the smoke test
tools/dev-db/  a Postgres for machines without Docker, installed on demand and not part of the app's dependencies
docs/          how the worker works and is deployed, and the queries for operating it
fixtures/      recorded provider responses the adapter tests parse
data/          the hand-picked companies and the confirmed boards
```

- **`src/core` is pure.** Data in, data out, and the clock is passed in as `now`. ESLint forbids it from importing the worker,
  the scripts, a database or anything that does input or output. Change detection is therefore one function,
  `applySnapshot(previousState, snapshot, now)`, that is tested with 300-run property tests (the same snapshot twice announces
  nothing, order never matters, a role listed in the last poll is never closed by the next one, an empty list never closes
  anything within 20 minutes). The worker loads a board's rows from Postgres, calls it, and writes the result back in one transaction.
- **A bad answer never closes anything.** A response that is not JSON, or does not match its adapter, fails the whole poll and
  changes nothing. A partial Greenhouse list (shorter than its own `meta.total`) is refused. Provider text is never trusted:
  titles are cleaned, links must be http(s) and are stored as https, and anything printed has control characters removed.
- **Polite by construction.** One request per second per host and at most two in flight per host, a descriptive
  `User-Agent` with your contact, `If-None-Match` on every repeat request (a 304 costs a few hundred bytes), a size cap, and
  a timeout per provider.
- **Atomic and repeatable.** A poll's diff, its new ETag, its next poll time and the release of its lease commit together or
  not at all, and a worker that lost its lease cannot write. Polling the same answer twice changes nothing the second time.
- **The database refuses impossible states.** A role is never both open and closed, a role with misses says since when, a
  closed role is the origin of at most one repost, a board's lease is held whole or not at all. A bug fails one poll loudly
  instead of corrupting history quietly.

## Deployment

The site is a Next.js app in [src/app](src/app): a landing page built from [data/boards.json](data/boards.json), a
`/api/health` endpoint, and the security headers from [src/web/security-headers.ts](src/web/security-headers.ts). It deploys
to Vercel from `main`.

| Step | What happens |
| --- | --- |
| Push or pull request | GitHub Actions runs typecheck, lint and the unit tests, the site build, the database tests against a Postgres service container, and a build of the worker's Docker image ([ci.yml](.github/workflows/ci.yml)) |
| Vercel build | The build command in [vercel.json](vercel.json) runs `npm run verify` (typecheck, lint and the unit tests, which need no database) before `npm run build`, so a commit that fails any check never goes live |
| Pull request | Vercel builds a preview deployment of the branch |
| Merge to `main` | Vercel deploys to production |
| After a production deploy | [post-deploy.yml](.github/workflows/post-deploy.yml) runs [scripts/smoke-test.sh](scripts/smoke-test.sh). It checks that `/api/health` reports the commit that was just pushed, that the page renders, that an unknown URL gives a 404 and that the security headers are present |

A red smoke test means the live site is wrong. Roll back in Vercel (Deployments, pick the last good one, Promote to Production),
then fix forward.

Settings you may need:

- Repository variable `HR_CONTACT` (Settings, Secrets and variables, Actions, Variables): your email address or a URL. The
  weekly feed canary refuses to run without it.
- Repository variable `SMOKE_HOST`: the public address the smoke test checks. It defaults to the project's Vercel address,
  `sooner-tejas-kambles-projects-b2a75374.vercel.app`. Set it when the site gets its own domain.
- Vercel environment variable `NEXT_PUBLIC_SITE_URL`: the site's own address once it has a domain, used for absolute links
  in page metadata.

## What the live runs found

Everything in the build guide came from my own requests on 2026-10-08, but building against the real feeds turned up things
the guide got wrong or missed. Each is fixed in the code and covered by a test.

| The guide said | What actually happens | What the code does |
| --- | --- | --- |
| Every provider answers a conditional request with 304 | True with curl. Node's `fetch` adds `Cache-Control: no-cache` whenever you send `If-None-Match`, and **Lever treats that as "skip your cache"**: it ignores the ETag and rebuilds the whole 737 KB answer (6 to 10 seconds) every time | Sends `cache: "no-cache"`, which is the standard `max-age=0`. Lever now answers 304 in about a second. See [src/worker/fetcher.ts](src/worker/fetcher.ts) |
| Time out after 20 seconds | Lever builds big answers slowly: Palantir's board is 6 MB and took 52 seconds, so a 20 s limit would never let it finish its first download | Timeout per provider: Lever 120 s, the others 30 s |
| One request per second per host | That limits the rate, not the load. Lever requests last 6 to 50 seconds, so many could run at once | At most 2 requests in flight per host, in the gate |
| `norm()` is NFKD, lower-case, then non-letters become spaces | "Zürich" becomes "zu rich", and the katakana "ジ" is split into "シ" plus a mark that is then deleted | Accent marks are removed only after Latin letters, then the text is recomposed, so Japanese and Hindi survive |
| A mass disappearance is `missing / open >= 40%`, with `open` counted after new roles are inserted | New roles in the same snapshot dilute the ratio, so 4 of 10 vanishing while 10 arrive looks like 4 of 20. And a board of 1 to 4 roles that goes empty was not caught | The ratio uses the roles open *before* the snapshot, and "all of them vanished" counts at any size |
| Keep Ashby roles where `isListed` is true; `remote` from `isRemote` | On Ramp's board 97 hybrid roles with no remote location carry `isRemote: true` | `workplaceType` decides; the flag is only a fallback |
| Job links are https | Squarespace's entire Greenhouse board publishes `http://` links, which a strict check rejected | `http` is upgraded to `https`; any other scheme still fails the response |
| `Retry-After` is seconds or a date | `Date.parse("-5")` is a day in May 2001 | Only digits or a real HTTP date are accepted |
| Indian companies are one third of the list | Of 82 Indian names tried, only 15 could be found on Greenhouse, Lever or Ashby, by the boards I knew, by their careers pages, or by guessing the name. Swiggy, PhonePe, Zepto, Postman, Unacademy and most other big consumer names were not among them | Noted. Adding Workable, SmartRecruiters or Recruitee later (as the guide already suggests) would widen it |
| Followed boards are polled every 5 minutes; boards nobody follows slow down on their own | The guide's `nextIntervalSec` slows *every* board by half again after each quiet poll, followed or not, so a followed company that happened to be quiet would drift from five minutes to one check every six hours | Followed boards stay at five minutes. Only unfollowed boards speed up and slow down |
| Claim with `where id in (select ... for update skip locked limit n)` | The planner may run that subquery again for each row, which can claim more than `limit` boards | A materialised CTE, then the update. A test has eight workers claim 100 boards: none twice, none over the limit |
| `CONCURRENCY = 8` boards in flight, shared by every provider | Lever answers in 6 to 50 seconds, Greenhouse in under one. Eight slow Lever boards would sit on every slot and no Greenhouse board could be polled until they finished | Separate lanes per provider (4, 4 and 3). A test holds two Lever polls open and checks that every Ashby board still gets polled |
| A lease of two minutes | Lever's request timeout is two minutes, and a board can queue in the gate before it starts, so its lease could run out before the poll began | A lease per provider: the timeout for every turn the lane can queue for, plus a minute. A worker that loses its lease anyway cannot write, because every finishing write checks a lease token |
| The first poll of a board is a baseline | If that first answer is an empty list (a provider glitch), the board is baselined with nothing, and every real role looks new on the next poll | An empty first answer does not baseline the board; the first answer that lists something does |
| Store the provider's text as it is | Postgres cannot store a NUL character. One in a title would fail the transaction on every attempt, and a single board could not be polled again | Text has control characters turned into spaces; an ID or a link that has one fails the response like any other format change |
| About 60,000 roles and 200,000 events a year come to "well under 100 MB" | Measured with the 50 boards loaded: 1.4 KB per role including indexes. The trigram index is the biggest single object (4.8 MB against 4.3 MB for the table) and nothing uses it until week 3's search. 60,000 roles is about 85 MB before any events | Noted, not changed. Comfortable on a free database, but not "well under" |

## What the live runs showed

### Week 0: the prototype

Run on 2026-10-08 against the real feeds, from a laptop:

| Run | Result |
| --- | --- |
| Baseline of the 50 boards | 31.5 s, 8,751 open roles, 49.9 MB of decoded JSON (mostly descriptions that Lever and Ashby send and this project throws away) |
| Second round, five minutes later | 49 of 50 boards answered 304 and only one was downloaded (2.0 MB). It caught a real edit: an ElevenLabs role went from "Account Manager - LATAM" to "Account Manager - Brazil" |
| Third round, resumed from the saved state | 50 of 50 answered 304, 0 bytes read, 25.5 s |

A repeat round cannot go faster than about 26 seconds here, because 26 of the boards are on Greenhouse and the gate allows
one request per second to each host. That is the politeness rule working, and the number to remember when sizing the
300-board version: about 150 Greenhouse boards means a sweep of two and a half minutes if every board were due at once.
Adaptive intervals will spread them out.

### Week 1: the worker and Postgres

Run on 2026-10-11 against the real feeds, from a laptop, with the worker polling the 50 boards every five minutes into a local
Postgres 17:

| Run | Result |
| --- | --- |
| Baseline of the 50 boards, written to Postgres | 50.6 s, 8,772 open roles, 50.1 MB of decoded JSON read. The database was 20 MB afterwards, of which the roles and their indexes are 12.6 MB: 1.4 KB per role |
| The next 16 minutes, every five minutes | 150 more polls, every one of them a 304: no body, no download, nothing written but a timestamp. No errors. Polls of one board were 270 to 328 seconds apart, which is five minutes with the jitter |
| What a 304 costs, per provider | Greenhouse 382 ms on average (95th percentile 541), Ashby 418 ms (515), Lever 1.7 s (5.1 s). A Lever 304 can still take several seconds on its biggest boards, so Lever stays in its own lane |
| Changes staged on one real board (Airbnb, 161 roles) | Two roles forgotten and one title edited in the database, then one real answer from Airbnb's feed: two `appeared` events and one `updated` with the exact field that changed. A role the feed does not list went on its first strike and was checked again exactly two minutes later by a **304**, which closed it with the evidence `{strikes: 2, openDays: 3}`. No download for the confirmation |
| Stopping with SIGTERM | The process logged the request and exited 0: 200 polls claimed, 200 applied, 0 failed, 0 cancelled, and no lease left on any board |

The only changes the feeds themselves made in that time were none: it was a quiet Sunday evening. The staged changes above are the
proof that the whole path works on real data; days of polling are what will show how it behaves on real change.

## Not here yet

- **The hosted database and the worker's host.** Everything a deploy needs is built and tested ([docs/worker.md](docs/worker.md)),
  but creating them takes accounts and a real contact address, so that step is yours. Until then nothing polls around the clock.
- **Week 2:** a heartbeat and a message to you when something needs a human, switching off a board that keeps returning 404,
  an admin page, and a mock job-board server that proves politeness and back-off end to end.
- **Week 3:** the website using the data: the live feed, search, company and role pages, and the stale-role signal.
- **Week 4:** sign-in, watches and alerts. Their tables arrive with them.

## Commands

```bash
npm run verify        # typecheck + lint + unit tests, what Vercel's build gate runs
npm run test:db       # the tests that need Postgres (starts a throwaway one for you)
npm run dev           # the website on http://localhost:3000
npm run build         # build the website, as Vercel does

npm run db:dev        # a real Postgres on this machine, no Docker needed (Ctrl-C stops it)
npm run db:migrate    # apply the SQL migrations (--status shows what is pending)
npm run db:seed       # add the companies and boards from data/boards.json
npm run worker        # poll what is due until Ctrl-C (--once polls what is due now and stops)
npm run build:worker  # bundle the worker and the migration runner into dist/ (what the Docker image does)

npm run feeds:check   # the live canary
npm run detect        # confirm data/candidates.json against the providers and rewrite data/boards.json
npm run poll          # the week 0 prototype, with no database
```

`detect` fetches the careers pages you list. It is a local script for a list you wrote yourself: never point it at addresses
other people can type.
