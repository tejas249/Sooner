# Sooner

Watches the public job-board feeds of a few hundred companies and tells you when a role opens, how long it has really been
open, and whether the company tends to fill its roles at all.

This is the **week 0 prototype** from the build guide: a laptop-only poller that reads 50 company boards, remembers what it
saw, polls again and prints what changed. No database, no web app, no alerts yet. Those start in week 1.

## Try it

```bash
npm install
cp .env.example .env        # then put your email address or a URL in HR_CONTACT
npm run feeds:check         # do the three providers still look the way the guide says? (about 6 requests)
npm run poll                # poll the 50 boards, wait 5 minutes, poll again, print what changed
```

`HR_CONTACT` goes into the `User-Agent` of every request so a company that does not want to be polled can reach you. The
scripts refuse to fetch anything while it is empty. Use an address you actually read.

Requires Node 24 or newer (the scripts run as TypeScript directly, with no build step).

## What it does

| Guide, "The first 48 hours" | Where it lives |
| --- | --- |
| Confirm the three feeds still look the way the guide says | `npm run feeds:check` ([scripts/check-feeds.ts](scripts/check-feeds.ts)). Also the weekly canary in CI |
| Greenhouse adapter, one recorded fixture and a test | [src/core/adapters/greenhouse.ts](src/core/adapters/greenhouse.ts), [fixtures/](fixtures/README.md). Lever and Ashby are done too, since the 50 boards use all three |
| Hand-pick 50 companies, write `detect-ats`, seed the boards | [data/candidates.json](data/candidates.json) goes through `npm run detect` ([scripts/detect-ats.ts](scripts/detect-ats.ts)) and becomes [data/boards.json](data/boards.json) |
| Poll them, poll again five minutes later, print what changed | `npm run poll` ([scripts/poll-local.ts](scripts/poll-local.ts)) |
| Push with CI green | [.github/workflows/ci.yml](.github/workflows/ci.yml) is ready. Typecheck, lint and tests pass locally from a clean checkout |

The 50 boards: 27 global, 15 Indian, 8 remote-first; 26 on Greenhouse, 16 on Ashby, 8 on Lever.

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
src/core/      pure TypeScript: adapters (parse only), text normalising, change detection, schedule maths
src/worker/    everything that touches the network: the politeness gate, the fetcher, fetchBoard
scripts/       the four commands above, and their helpers
fixtures/      recorded provider responses the adapter tests parse
data/          the hand-picked companies and the confirmed boards
```

- **`src/core` is pure.** Data in, data out, and the clock is passed in as `now`. ESLint forbids it from importing the worker,
  the scripts, a database or anything that does input or output. Change detection is therefore one function,
  `applySnapshot(previousState, snapshot, now)`, that is tested with 300-run property tests (the same snapshot twice announces
  nothing, order never matters, a role listed in the last poll is never closed by the next one, an empty list never closes
  anything within 20 minutes). Week 1 loads a board's rows from Postgres, calls it, and writes the result back in one transaction.
- **A bad answer never closes anything.** A response that is not JSON, or does not match its adapter, fails the whole poll and
  changes nothing. A partial Greenhouse list (shorter than its own `meta.total`) is refused. Provider text is never trusted:
  titles are cleaned, links must be http(s) and are stored as https, and anything printed has control characters removed.
- **Polite by construction.** One request per second per host and at most two in flight per host, a descriptive
  `User-Agent` with your contact, `If-None-Match` on every repeat request (a 304 costs a few hundred bytes), a size cap, and
  a timeout per provider.

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

## What the first live runs showed

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

## Not here yet

Postgres and the schema, the worker loop (claiming due boards, adaptive intervals, back-off), alerts, the web app, sign-in,
deployment, Vercel configuration and design tokens. Week 1 starts with the schema and the worker loop; the pieces they plug
into already exist and are tested.

## Commands

```bash
npm run verify        # typecheck + lint + tests, what CI runs
npm run feeds:check   # the live canary
npm run detect        # confirm data/candidates.json against the providers and rewrite data/boards.json
npm run poll          # the prototype
```

`detect` fetches the careers pages you list. It is a local script for a list you wrote yourself: never point it at addresses
other people can type.
