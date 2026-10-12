# The admin page

`/admin` on the website. One page for the person running Sooner, not for visitors: the worker's health, its alerts, and every
board, with three buttons per board. It reads the same Postgres the worker writes to.

## Turn it on

Two settings, where the website runs:

| Setting | What it is |
| --- | --- |
| `ADMIN_PASSWORD` | At least 16 characters. Make one with `openssl rand -base64 24`. The browser asks for it once; the user name is ignored |
| `DATABASE_URL` | The database to read. For a hosted database use its **pooled** connection string here (the website opens up to three connections per running instance and lets idle ones go after ten seconds). The worker and the migrations keep using the direct one |

Without a usable `ADMIN_PASSWORD` the page does not exist: `/admin` answers 404, with the same page and the same caching as any
address that was never built. A missing or short password can never switch it on. Without `DATABASE_URL` the page says there is
no database to show.

Locally, put both in `.env.local` (it is git-ignored), run `npm run db:dev` in one terminal and `npm run dev` in another, and
open <http://localhost:3000/admin>.

On Vercel the two go under the project's environment variables. The platform steps are from memory of its documentation, so check
them against its current docs.

## What it shows

- **Tiles.** *Worker*: how long since a poll last finished. *Queue lag*: how overdue the most overdue board is; healthy is under a
  minute. *Polls, last hour*: how many, how many failed; healthy is over 98% successful. *Boards*: how many are on, off and in
  need of attention. *Roles*: open roles, and how many changes in the last day. *Alerts*: open and recently resolved.
- **Open alerts**, and the ones resolved lately: the same ones the worker sends to your webhook ([docs/worker.md](worker.md#alerts-to-yourself)).
- **Every board**, the ones that need attention first: its state, open roles, when it was last polled and when it is next due,
  how often it is polled, and the reason when something is wrong. A state is always written as text (OK, Waiting, Failing,
  Degraded, Format changed, Gone, Off), never as a colour alone. *Needs attention* filters to the boards that are failing,
  have changed shape, have vanished, or have a mass disappearance held back.

The tiles are worked out from the database on every load, so *Worker* and *Queue lag* show trouble when the worker is not
running even if no alert has been sent. The alerts themselves come from the worker's monitor and the outside heartbeat: this
page does not watch anything.

## What the buttons do

| Button | Effect |
| --- | --- |
| **Poll now** | Makes the board due. The worker takes it within about 15 seconds and keeps to the politeness rules while it does (one request a second to each host). A board that is already overdue keeps its place in the queue |
| **Pause** | Switches the board off and writes why. Its roles are left alone. A paused board raises no alert |
| **Resume** | Switches it back on and makes it due. For a board that was switched off after three 404s, it also starts that count again from zero |

Each one is a single statement with its conditions in the `WHERE` clause, so a page that is out of date cannot do the wrong thing
to a board that has changed since: the page says "nothing changed" instead.

## How it is protected

- **A password, checked three times.** The proxy ([src/proxy.ts](../src/proxy.ts)) asks the browser for it. The page and every
  server action check it again themselves, because a server action is just a POST to the page's address and a proxy is not a
  security boundary on its own. The comparison takes the same time however many characters match.
- **Other sites cannot press the buttons.** Browsers send a page's saved password along with a form posted from any other site.
  Next.js refuses a server action whose `Origin` header differs from the site's own host; this was checked against a production
  build, with the right password supplied.
- **Board ids are numbers.** Anything else (`abc`, `1; drop table board`, a number too long to be an id) is turned away before it reaches
  a query, and every query takes its values as parameters.
- **Never cached, never indexed.** `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` on every response, `Disallow:
  /admin` in `robots.txt`, framing refused, and the site's content security policy applies.
- **No reasons leaked.** When the database cannot be read, the page says so and nothing more. The reason, which can name the
  database's host, goes to the server's log.

What it is not: there are no user accounts until week 4, and nothing locks you out after wrong guesses, so the password has to be
long and random. Basic authentication sends the password with every request, so use the site only over HTTPS (Vercel provides it).
