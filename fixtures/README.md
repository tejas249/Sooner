# Recorded provider responses

Real answers from the providers' public job-board endpoints, fetched on 2026-10-08 and trimmed so they stay small. The
adapter tests parse these, so a change in a provider's format shows up as a failing test once the fixture is re-recorded.

| File | Endpoint | Kept |
| --- | --- | --- |
| `greenhouse/stripe.json` | `GET https://boards-api.greenhouse.io/v1/boards/stripe/jobs` | 8 of 724 roles: several cities, "Remote from the US", remote hidden inside a longer place name, a trailing space in the title, the oldest role, the most recently edited role |
| `lever/spotify.json` | `GET https://api.lever.co/v0/postings/spotify?mode=json` | 6 of 76 postings: one each of remote, hybrid and onsite, the oldest, the two newest |
| `ashby/ramp.json` | `GET https://api.ashbyhq.com/posting-api/job-board/ramp` | 6 of 161 roles: a title with a leading space, a hybrid role that still has `isRemote: true`, a remote role, an on-site role, the oldest and the newest |

What was changed, and nothing else:

- Roles were dropped. Everything inside the roles that were kept is as the provider sent it.
- Greenhouse `meta.total` was set to the number of roles kept (8), because the adapter checks it against the list length.
- Lever and Ashby descriptions (`description`, `descriptionPlain`, `additional`, `lists` and similar) were replaced with
  `"[trimmed]"`. The adapters never read them, and the product never stores them.

To re-record, fetch the endpoint above and trim it the same way. Do it when `npm run feeds:check` reports a change, so the
tests follow the real format.
