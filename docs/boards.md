# The board list

Which companies Sooner watches, how each one was confirmed, and what growing the list from 50 to 422 showed.

## Where it lives

| File | What it is |
| --- | --- |
| [data/candidates.json](../data/candidates.json) | The companies, picked by hand: name, audience (`global`, `india` or `remote-first`), country, website, and the board each is known to use (`"boards": ["greenhouse:stripe"]`). Only the first 50 carry `"priority": true`, which puts them on the five-minute rhythm; the rest adapt between half an hour and six hours |
| [data/boards.json](../data/boards.json) | The confirmed boards, written by `npm run detect` and never by hand. 422 boards: 219 on Greenhouse, 157 on Ashby and 46 on Lever; 374 global, 31 remote-first and 17 Indian; 40,988 open roles when they were confirmed. A schema ([src/core/boards.ts](../src/core/boards.ts)) checks it when the site is built, so a mistake fails the build and not production |

The poller, the seed script and the landing page all read `boards.json`.

## How a board is confirmed

`npm run detect` ([scripts/detect-ats.ts](../scripts/detect-ats.ts), decisions in [scripts/lib/detect.ts](../scripts/lib/detect.ts)) tries, for each company, the
boards you listed, then its careers page (if you gave one), then guesses from its name and website (`stripe`, `urban-company`,
the first label of the address). Every request goes through the same politeness gate as polling: one a second to each provider.

- **The provider has to say yes.** The board's own API answers 200 with a shape its adapter understands.
- **A guess has to mention the company.** The company's name or its website's address must appear in the board's own answer, or
  the guess is ignored. A guess can land on another company with the same name.
- **A guess for a company in India must have a role in India.** A company based in India that lists no role there is someone else.
- **A guess must not be empty.** A quiet board is plausible for a hint; for a guess it is more likely the wrong company.
- **A hint is believed**, but it is printed with the same evidence, so a typo shows.

Every line it prints ends with the board's evidence and its commonest places, for example
`name x413, address x0 ... places: Remote US (88), Remote Canada (68)`.

## What growing the list showed

Three sweeps tried 817 names (532, then 253, then 32 that had been prepared with hints). The detector accepted 365 boards on its
own rules; after reading them, 25 were left out, and 340 plus the 32 prepared plus the original 50 make 422.

**The automatic checks are not enough.** Of the 25 boards left out, 4 had passed on the company's name alone and were someone else:

| Board | Why it is not the company that was meant |
| --- | --- |
| BlueStone | Care-coordination roles in Minnesota, none of its 32 roles in India (the company meant is an Indian jeweller) |
| Lightspeed | Robotics roles in Illinois (the company meant sells commerce software) |
| Pylon | Mortgage processing and underwriting roles (the company meant makes support software) |
| Lovable | Italian-language retail roles (the company meant builds apps with AI) |

The other 21 were on the review list (an ordinary-word name, or no match for the website's address), and reading their roles
showed another company or not enough to be sure. Navi (four roles in San Francisco) and Slice (support roles in Pristina and
Skopje, with its own careers site) had already been met when the first list was built. So each board was read before it was
kept: its commonest places and a few job titles, not only whether its answer contained the company's name.

**The guide's split was not reachable.** It asked for 150 global, 100 Indian and 50 remote-first companies. Global and
remote-first are well covered (374 and 31). Of about 185 Indian companies tried, 17 publish on Greenhouse, Lever or Ashby: the 15
of the first list, then Druva (Pune) and Zenoti (Hyderabad). Reading the careers pages of the 159 that were still missing
added nothing: of their `/careers` pages, 104 had no job-board link in their static HTML, 33 were not found and 8 refused the
request, and the one link that did point to a board pointed at an empty one; `careers.<domain>` found none. Most large Indian
companies use other applicant-tracking systems or their own sites; reaching more of them would take more adapters, which is
outside the guide.

## Adding a company

1. Add it to `data/candidates.json` with at least `name`, `segment`, `country` and `website`.
2. `npm run detect -- --dry` and read what it prints. Look at the places and the evidence for every guess.
3. Put the board you accept in the company's `"boards"` so the next run does not have to guess, then run `npm run detect -- --no-guess`
   to write `data/boards.json`.
4. `npm run db:seed` adds the new boards to a database. First polls are spread over about two seconds each, so a few hundred new
   boards do not look like a backlog.

To stop polling a company, take it out of both files and switch its board off in the database
(`update board set active = false where ...`): a seed never switches a board back on, which is how an opt-out is honoured.
