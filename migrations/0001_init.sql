-- 0001_init: what we watch and what we saw.
--
-- Five tables: company, board, posting, posting_event and poll_run. The tables for users, watches and alert delivery
-- arrive with the weeks that use them; until then nothing would write to them.
--
-- Rules the schema follows:
--   * Events are append-only and postings hold the current state. History comes from events, never from overwriting.
--   * Raw feed bodies and full descriptions are never stored. Only the fields we show: it is smaller, safer and kinder
--     to the employers.
--   * A role's identity is (board_id, external_id). Repost matching uses title_norm and location_norm.
--   * Every timestamp is timestamptz, so it is an instant in time and the session's time zone never changes its meaning.
--   * The database refuses states the code must never produce, so a bug fails one poll loudly instead of corrupting
--     history quietly. Look for the named constraints below.

create extension if not exists pg_trgm;

create table company (
  id          bigint generated always as identity primary key,
  slug        text not null unique constraint company_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name        text not null constraint company_name_not_empty check (name <> ''),
  -- Who the company was picked for: global tech, Indian companies or remote-first companies.
  segment     text constraint company_segment_known check (segment in ('global', 'india', 'remote-first')),
  website     text,
  -- Where it is headquartered, ISO 3166-1 alpha-2. Optional.
  country     text constraint company_country_format check (country ~ '^[A-Z]{2}$'),
  created_at  timestamptz not null default now()
);

-- One row per job board we poll. A company can have more than one.
create table board (
  id                    bigint generated always as identity primary key,
  company_id            bigint not null references company(id) on delete cascade,
  provider              text not null constraint board_provider_known check (provider in ('greenhouse', 'lever', 'ashby')),
  -- The provider's own name for the board. It ends up inside a URL, so it is limited to the characters providers use.
  token                 text not null constraint board_token_format check (token ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  active                boolean not null default true,

  -- The work queue: a board is due when next_poll_at has passed. Postgres is the queue, so there is no broker.
  next_poll_at          timestamptz not null default now(),
  -- The adaptive interval in seconds. The next poll time adds up to 10% of jitter on top of it.
  poll_interval_sec     int not null default 1800 constraint board_interval_positive check (poll_interval_sec > 0),
  -- The lease: a worker that claims a board sets both and clears both when it is done. claimed_until says when another
  -- worker may take the board over (the first one crashed); claim_token says who holds it right now, so a worker that
  -- lost its lease cannot write over the one that took it.
  claimed_until         timestamptz,
  claim_token           uuid,

  etag                  text,
  last_polled_at        timestamptz,    -- the last poll that got a good answer (200 or 304)
  last_changed_at       timestamptz,    -- the last poll that produced an event
  baselined_at          timestamptz,    -- null until the first poll that listed at least one role
  consecutive_failures  int not null default 0 constraint board_failures_not_negative check (consecutive_failures >= 0),
  last_error            text,

  unique (provider, token),
  constraint board_lease_complete check ((claimed_until is null) = (claim_token is null))
);
-- "Which boards are due?" is the hottest query in the system, so it has its own small index.
create index board_due_idx on board (next_poll_at) where active;
create index board_company_idx on board (company_id);

create table posting (
  id                 bigint generated always as identity primary key,
  board_id           bigint not null references board(id) on delete cascade,
  -- Copied from the board so queries by company do not need a join.
  company_id         bigint not null references company(id) on delete cascade,
  external_id        text not null,
  title              text not null,
  -- Lower-cased, accents and punctuation removed. This is what a repost is matched on.
  title_norm         text not null,
  location           text,
  location_norm      text,
  department         text,
  remote             boolean,
  url                text not null,
  posted_at          timestamptz,     -- the provider's date for when the role went live; null when the feed has none
  source_updated_at  timestamptz,     -- the provider's last-edit date (only Greenhouse sends one)

  first_seen_at      timestamptz not null,
  last_seen_at       timestamptz not null,
  -- Polls in a row that did not list this role, and when it first went missing. A role is closed only after enough
  -- misses spread over enough time (see src/core/changes.ts).
  missed_polls       int not null default 0,
  missed_since       timestamptz,
  status             text not null default 'open' constraint posting_status_known check (status in ('open', 'closed')),
  closed_at          timestamptz,
  reopen_count       int not null default 0 constraint posting_reopen_not_negative check (reopen_count >= 0),
  -- The closed role this one is a repost of, when it is.
  repost_of_id       bigint references posting(id) on delete set null,
  -- A fingerprint of the fields we show, so an edit is a different hash for the same ID.
  content_hash       text not null,
  -- Already open when we first looked at the board. Never alerts; its age comes from posted_at.
  baseline           boolean not null default false,
  search             tsvector generated always as (
                       to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(location, '') || ' ' || coalesce(department, ''))
                     ) stored,

  unique (board_id, external_id),
  -- A role is never both open and closed.
  constraint posting_closed_consistent check ((status = 'closed') = (closed_at is not null)),
  -- A role that is listed has no misses, and a role with misses says since when.
  constraint posting_misses_consistent check (missed_polls >= 0 and ((missed_polls = 0) = (missed_since is null)))
);
create index posting_open_company_idx on posting (company_id) where status = 'open';
create index posting_recent_idx on posting ((coalesce(posted_at, first_seen_at)) desc) where status = 'open';
-- Boards with a role on its first miss: a 304 has to confirm it, and this finds out whether there is anything to confirm.
create index posting_on_strike_idx on posting (board_id) where status = 'open' and missed_polls > 0;
-- Repost matching looks at one company's recently closed roles.
create index posting_closed_company_idx on posting (company_id, closed_at desc) where status = 'closed';
create index posting_search_idx on posting using gin (search);
create index posting_title_trgm_idx on posting using gin (title_norm gin_trgm_ops);
-- A closed role is the origin of at most one repost. This also settles a race between two boards of one company that
-- both see the same repost: one of them fails and retries, and then finds the link already taken.
create unique index posting_repost_of_uidx on posting (repost_of_id) where repost_of_id is not null;

-- Append-only: what happened to a posting, and the evidence for it.
create table posting_event (
  id             bigint generated always as identity primary key,
  posting_id     bigint not null references posting(id) on delete cascade,
  company_id     bigint not null references company(id) on delete cascade,
  type           text not null constraint posting_event_type_known check (type in ('appeared', 'updated', 'closed', 'reopened', 'reposted')),
  at             timestamptz not null default now(),
  -- The evidence for the decision: which fields changed, how many days a role was open, the repost link.
  detail         jsonb not null default '{}',
  alerted_at     timestamptz,     -- set once alerts for this event are handled
  claimed_until  timestamptz      -- lease for the alert worker
);
create index posting_event_company_idx on posting_event (company_id, at desc);
create index posting_event_posting_idx on posting_event (posting_id, at);
create index posting_event_unalerted_idx on posting_event (at)
  where alerted_at is null and type in ('appeared', 'reposted');

-- One row per poll attempt: the raw material for "is this board healthy?". Rows older than a week are deleted.
create table poll_run (
  id            bigint generated always as identity primary key,
  board_id      bigint not null references board(id) on delete cascade,
  started_at    timestamptz not null default now(),
  duration_ms   int,
  http_status   int,              -- 200, 304, 429, 5xx; null = the request got no answer
  bytes         int,
  jobs_seen     int,
  new_count     int not null default 0,
  closed_count  int not null default 0,
  error         text,
  -- Something worth a human's eye that was not an error, for example "40% of the roles vanished at once".
  note          text
);
create index poll_run_board_idx on poll_run (board_id, started_at desc);
create index poll_run_started_idx on poll_run (started_at);
