# The worker

The worker is a plain Node 24 program that asks Postgres "which boards are due?", polls them politely, works out what
changed and writes it back, all in one transaction per board. Postgres is the queue, so there is no Redis and no broker.

- [How it works](#how-it-works)
- [Run it on your laptop](#run-it-on-your-laptop)
- [Deploy it](#deploy-it)
- [Look after it](#look-after-it)
- [What it does not do yet](#what-it-does-not-do-yet)

## How it works

### One poll

| Step | What happens | Where |
| --- | --- | --- |
| Claim | Takes the due boards of a provider (`next_poll_at` has passed, no live lease) with `FOR UPDATE SKIP LOCKED`, and leases them | [claim.ts](../src/worker/claim.ts) |
| Wait your turn | The politeness gate lets one request per second start to each host, and at most two run at once | [gate.ts](../src/worker/gate.ts) |
| Ask | A conditional `GET` with the board's last `ETag`. A 304 means nothing changed | [fetcher.ts](../src/worker/fetcher.ts) |
| Parse | The answer is validated against its provider's schema and turned into the one internal shape. An answer that does not fit is a *format change*: the poll fails and changes nothing | [fetch-board.ts](../src/worker/fetch-board.ts), [adapters](../src/core/adapters) |
| Apply | In **one transaction**: lock the board's row (only if this worker still holds the lease), load its roles, run the pure change detection ([changes.ts](../src/core/changes.ts)), write the new and changed rows and the events, store the new ETag, schedule the next poll, release the lease | [settle.ts](../src/worker/settle.ts), [postings.ts](../src/worker/postings.ts) |
| Reschedule | The next visit depends on whether the board changed, whether anyone follows it, and the provider's own minimum | [schedule.ts](../src/core/schedule.ts) |

A crash at any point leaves either everything applied or nothing. Applying the same answer twice changes nothing the
second time, which is what makes it safe for a poll to be repeated after a crash.

### Leases, and why the lease has a token

Claiming a board sets `claimed_until` (when another worker may take the board over) and `claim_token` (who holds it now).
If a worker dies mid-poll, its lease runs out and another worker picks the board up. If a worker merely *stalls* past its
lease and wakes up to find the board taken over, every write it makes is conditional on its token, so it finds no row and
writes nothing.

A lease is as long as the longest the board's provider can take (its timeout, for every turn the lane can queue at the
gate), plus a minute: 2 minutes for Greenhouse and Ashby, 5 for Lever.

### Lanes

The worker takes boards **per provider**, up to a limit for each (Greenhouse 4, Ashby 4, Lever 3). One shared limit would
let a few slow Lever boards (6 to 50 seconds each) occupy every slot and starve the fast providers. It also keeps a
claimed board from waiting long in the gate while its lease runs down.

The loop does not poll the database on a timer. After each pass it sleeps until the next board it could take falls due, or
until a poll finishes and frees a lane, or until it is told to stop.

### How often each board is polled

| Board | Interval |
| --- | --- |
| Followed by someone, or marked `priority` in [data/boards.json](../data/boards.json) | Every 5 minutes, always |
| Not followed, busy | Halves each time it changes, never below 30 minutes |
| Not followed, quiet | Grows by half each quiet poll, never above 6 hours |
| Waiting for a confirmation (a role missing once) | 2 minutes later, or 10 when so many roles vanished at once that three checks over 20 minutes are needed |
| Any board | At least the provider's own minimum (Ashby caches for 60 seconds), plus up to 10% of jitter either way |

Until users can follow companies (week 4), nobody does, so the boards that matter most are marked `priority` in the list
(the original 50) and are polled every five minutes: they build history at a rhythm worth having and give the shortest
detection delay. Every other board speeds up when it changes and slows down when it is quiet, which keeps the whole list at
roughly 22,000 requests a day (about a quarter of a request per second) however long it gets. Treating all boards as priority
would be 86,000 a day for 300 boards, more than the politeness gate can serve on time, so `ALL_BOARDS_FOLLOWED` is off by
default; it exists for a small list. A 304 costs a few hundred bytes.

### When things go wrong

| Situation | What the worker does |
| --- | --- |
| 429, 5xx, a timeout or a dead connection | Counts a failure and waits at least the board's normal interval, or 60 seconds doubled for every failure in a row if that is longer (up to 6 hours). Honours `Retry-After` when it asks for more. A failing board is never asked more often than a healthy one |
| 8 failures in a row | The board is *degraded* and is tried once every 6 hours until it recovers |
| An answer that is not JSON, or not the shape its adapter knows | Changes nothing, logs at `error` level, and counts as a failure. It is never read as "every role closed" |
| A 404 | Counts as a failure like any other (see [what it does not do yet](#what-it-does-not-do-yet)). Roles are not closed |
| The first answer for a board lists no roles | The board is *not* baselined: an empty first answer is more likely a glitch than a company with no jobs, and baselining it would make every real role look new next time. It is baselined by the first answer that lists something |
| So many roles vanish at once (40% of at least 5, or all of them) | Nothing closes for three checks over 20 minutes, and the poll logs a warning |
| The database write fails | The transaction rolls back, nothing is applied, the failure is recorded and the board backs off |
| The database is unreachable | The loop logs the error and tries again in 5 seconds; polls in flight keep going |
| Another worker took the board over | Nothing is written; the poll is logged as `lease lost` |
| SIGTERM or Ctrl-C | Stops claiming, lets the polls in flight finish (up to `SHUTDOWN_GRACE_SEC`, default 25), cancels the rest and gives their leases back so the boards are due at once for whoever runs next. A second interrupt stops immediately |

### The kill switch

`POLLING_ENABLED=false` keeps the process running but stops all polling. To stop one board, switch it off:
`update board set active = false where id = ...`. A board that is switched off stays off, even if `npm run db:seed` runs
again, so this is also how an opt-out request is honoured.

## Run it on your laptop

No Docker and no installed Postgres are needed. `npm run db:dev` starts a real Postgres 17 from the `embedded-postgres`
package, installed on demand into `tools/dev-db` (about 130 MB, one time) and kept out of the app's dependencies.

```bash
npm run db:dev                  # terminal 1: Postgres on 127.0.0.1:54329, data in .state/postgres
```

```bash
cp .env.example .env            # then put an address you read in HR_CONTACT; DATABASE_URL is already right
npm run db:migrate              # create the tables
npm run db:seed                 # add the 50 companies and boards from data/boards.json
npm run worker                  # poll until Ctrl-C; or `npm run worker -- --once` to poll what is due and stop
```

The worker prints one JSON line per poll (board, provider, HTTP status, milliseconds, bytes, what changed and when it will
look again). Ctrl-C stops it cleanly.

Tests:

```bash
npm test                        # unit tests, no database; this is what Vercel's build runs
npm run test:db                 # the tests that need Postgres; starts a throwaway one for you
```

In CI the database tests run against a `postgres:17` service container instead (`TEST_DATABASE_URL`).

## Deploy it

> The database, the worker and a real contact address are things only you can create. Nothing below has been run against
> a hosted provider, and the platform commands are from memory of their documentation: check each against the platform's
> current docs before relying on it. What *is* tested is the part you cannot see from outside: the image builds in CI, the
> bundled program starts from an empty folder, migrates a database and shuts down cleanly on SIGTERM.

You need three things: a Postgres database, somewhere to run the container around the clock, and an address a company can
reach you at (it goes into the `User-Agent` of every request).

### 1. The database

Any Postgres 14 or newer works; the tests and CI use 17. On Neon:

1. Create a project and note the **direct** connection string: the host *without* `-pooler`. The worker keeps a few
   long-lived connections and the migration runner holds a session lock, and neither works well through a transaction
   pooler. (The pooled string is for the website's serverless functions, later.)
2. Create the tables and the starting data from your laptop:

   ```bash
   DATABASE_URL='postgres://...direct...' npm run db:migrate
   DATABASE_URL='postgres://...direct...' npm run db:seed
   ```

3. Know the cost. A hosted database that scales to zero when idle will never idle: the worker queries it every few
   seconds, around the clock. Check your plan's compute allowance before choosing the free tier. The 50 starter boards take
   about 20 MB, including Postgres's own catalogs.

Neon's connection strings end in `?sslmode=require`; the `pg` library accepts that and will print a one-time note about it.

### 2. The worker

The [Dockerfile](../Dockerfile) builds the worker and the migration runner into two files (`dist/worker.mjs`,
`dist/migrate.mjs`) and ships only those, with Node. Set these as secrets or variables on the host:

| Variable | Required | |
| --- | --- | --- |
| `DATABASE_URL` | yes | The direct connection string |
| `HR_CONTACT` | yes | An email address or a URL a company can reach you at. No parentheses |
| `POLLING_ENABLED`, `ALL_BOARDS_FOLLOWED`, `DB_POOL_MAX`, `SHUTDOWN_GRACE_SEC`, `WORKER_ID` | no | See [.env.example](../.env.example) |

Run **one** instance. More would work (claiming is built for it) but fifty boards do not need it, and each instance has its
own politeness gate, so two would double the request rate to each provider.

Run migrations as their own step before a new version starts, never on worker start:

```bash
node dist/migrate.mjs           # inside the image; or `npm run db:migrate` from a checkout
```

On **Fly.io**, a `fly.toml` along these lines runs the migration as the release command and gives the worker time to shut
down cleanly (check the keys against Fly's documentation):

```toml
app = "your-app-name"
primary_region = "your-region"   # near the database
kill_timeout = 40                # seconds; at least SHUTDOWN_GRACE_SEC plus ten

[build]

[deploy]
  release_command = "node dist/migrate.mjs"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

```bash
fly apps create your-app-name
fly secrets set DATABASE_URL='postgres://...direct...' HR_CONTACT='you@example.com'
fly deploy --ha=false
fly logs                        # one JSON line per poll
```

On **Railway** or any host that builds a Dockerfile, add the repository, set the same two variables, and make sure the
platform waits at least `SHUTDOWN_GRACE_SEC` plus ten seconds after SIGTERM before it kills the process.

### 3. Check that it is working

Within a minute of starting you should see `worker started`, then one `poll` line per board with `"baseline":true`, then
`"status":304` lines five minutes later. Then run [docs/operating.sql](operating.sql): queue lag should be about zero and
poll success should be near 100%.

## Look after it

[docs/operating.sql](operating.sql) has ten read-only queries: queue lag, poll success, failing boards, feeds that changed
shape, held-back mass disappearances, detection delay by provider, false closes, current leases, what changed today, and
how much has been written.

| Healthy | Alarm | Query |
| --- | --- | --- |
| Queue lag under a minute | Over five minutes: the worker is down or overloaded | 1 |
| Poll success over 98% | Under 90% | 2 |
| No degraded boards | Over 5% of boards | 3 |
| No format changes | Any: fix the adapter | 4 |
| Median detection delay under ten minutes | Over twenty | 6 |
| False closes under 1% | Over 3% | 7 |

Rows in `poll_run` are deleted after a week, by the worker itself. Everything else is kept.

## What it does not do yet

These are week 2. Until then the worker is safe (a failing board backs off, nothing closes on a failed poll) but quiet.

- No heartbeat to an outside monitor, and no message to you when something needs a human (queue lag, a held-back mass
  disappearance, a format change). Read the logs, or run the queries above.
- A board that returns 404 is retried with backoff for ever instead of being switched off after three.
- No admin page: "poll now" and "pause" are SQL for now.
- No mock job-board server for proving politeness and back-off end to end (the gate and the fetcher have their own tests).
- Alerts to users, the web app's use of the database, and follows are weeks 3 and 4.
