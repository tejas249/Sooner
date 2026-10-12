-- Queries for looking after the worker. Run them with psql against the same database the worker uses, for example
--   psql "$DATABASE_URL" -f docs/operating.sql
-- or paste one at a time. Every one is read-only.

-- 1. Queue lag: how overdue is the most overdue board that nobody is working on? Healthy: under a minute. Over five
--    minutes means the worker is down, stuck or overloaded.
select coalesce(max(extract(epoch from (now() - next_poll_at))), 0)::int as worst_lag_sec
  from board
 where active
   and next_poll_at <= now()
   and (claimed_until is null or claimed_until < now());

-- 2. Poll success over the last hour: the share of polls that got a usable answer (200 or 304). Healthy: over 98%.
select count(*) as polls,
       round(100.0 * count(*) filter (where error is null) / nullif(count(*), 0), 1) as success_pct
  from poll_run
 where started_at > now() - interval '1 hour';

-- 3. Boards that keep failing. Eight failures in a row means the board is degraded and tried only every six hours.
select c.slug, b.provider, b.token, b.consecutive_failures, b.last_error, b.next_poll_at
  from board b
  join company c on c.id = b.company_id
 where b.active and b.consecutive_failures > 0
 order by b.consecutive_failures desc, c.slug;

-- 4. Feeds that stopped looking like themselves (the format changed). Each one needs a human: fix the adapter.
select started_at, board_id, error
  from poll_run
 where error like 'the feed changed shape:%'
 order by started_at desc
 limit 20;

-- 5. Sudden mass disappearances that were held back, newest first. Open the feed by hand and compare.
select r.started_at, c.slug, r.note
  from poll_run r
  join board b on b.id = r.board_id
  join company c on c.id = b.company_id
 where r.note is not null
 order by r.started_at desc
 limit 20;

-- 6. Detection delay by provider over the last seven days: how long after a role went live did we notice it?
--    Healthy median: under ten minutes. Lever's date can be earlier than the day the role went public, so treat its
--    number as indicative. Greenhouse and Ashby give publish dates.
select b.provider,
       count(*) as roles,
       round((percentile_cont(0.5)  within group (order by extract(epoch from p.first_seen_at - p.posted_at)) / 60)::numeric, 1) as median_min,
       round((percentile_cont(0.95) within group (order by extract(epoch from p.first_seen_at - p.posted_at)) / 60)::numeric, 1) as p95_min
  from posting p
  join board b on b.id = p.board_id
 where not p.baseline
   and p.posted_at is not null
   and p.first_seen_at >= p.posted_at
   and p.first_seen_at > now() - interval '7 days'
 group by b.provider;

-- 7. False closes: roles that came back within 24 hours of being closed, as a share of all closes in the last seven
--    days. Healthy: under 1%. Over 3% means closing is too eager.
select count(*) as closes,
       count(*) filter (where back.at is not null and back.at - closed.at < interval '24 hours') as came_back_within_a_day
  from posting_event closed
  left join lateral (
         select e.at
           from posting_event e
          where e.posting_id = closed.posting_id and e.type = 'reopened' and e.at > closed.at
          order by e.at
          limit 1
       ) back on true
 where closed.type = 'closed'
   and closed.at > now() - interval '7 days';

-- 8. Boards that are leased right now, and for how much longer. A lease that stays past its end means a worker died.
select c.slug, b.provider, b.claimed_until - now() as lease_left
  from board b
  join company c on c.id = b.company_id
 where b.claim_token is not null
 order by b.claimed_until;

-- 9. What changed in the last day, newest first.
select e.at, c.slug, e.type, p.title, p.location
  from posting_event e
  join posting p on p.id = e.posting_id
  join company c on c.id = e.company_id
 where e.at > now() - interval '1 day'
 order by e.at desc
 limit 100;

-- 10. The alerts that are open right now, and who has been told. A critical one has probably been waiting a while.
select key, severity, title, opened_at, last_sent_at, send_count
  from alert_state
 where resolved_at is null
 order by severity, opened_at;

-- 11. Alerts that were resolved lately.
select key, title, opened_at, resolved_at
  from alert_state
 where resolved_at is not null
 order by resolved_at desc
 limit 20;

-- 12. Boards that were switched off, and why (a 404, or someone paused them).
select c.slug, b.provider, b.token, b.deactivated_at, b.deactivated_reason
  from board b
  join company c on c.id = b.company_id
 where not b.active
 order by b.deactivated_at desc nulls last;

-- 13. How much has the poller written? (poll_run keeps a week; everything else is kept for good.)
select (select count(*) from company) as companies,
       (select count(*) from board where active) as active_boards,
       (select count(*) from posting where status = 'open') as open_roles,
       (select count(*) from posting where status = 'closed') as closed_roles,
       (select count(*) from posting_event) as events,
       (select count(*) from poll_run) as poll_runs,
       pg_size_pretty(pg_database_size(current_database())) as database_size;
