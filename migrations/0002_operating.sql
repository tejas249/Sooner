-- 0002_operating: what it takes to look after the worker once it runs on its own.
--
--   * board.priority: which boards are polled at the fast rhythm even though nobody follows them yet. With 300 boards, five
--     minutes for every one of them would be 86,000 requests a day, more than the politeness gate can serve on time.
--   * board.consecutive_not_found, deactivated_at, deactivated_reason: a board that keeps answering 404 has probably moved to
--     another provider. It is switched off, with the reason written down, instead of being asked about for ever. Nothing about
--     its roles changes.
--   * alert_state: the alerts that have been raised to the owner, so a problem is reported once, reminded now and then, and
--     reported as resolved, and a restart of the worker does not repeat all of them.

alter table board
  add column priority boolean not null default false,
  add column consecutive_not_found int not null default 0
    constraint board_not_found_not_negative check (consecutive_not_found >= 0),
  add column deactivated_at timestamptz,
  add column deactivated_reason text;

-- "Which boards are switched off, and why?" is an admin-page question, so it gets its own small index.
create index board_inactive_idx on board (deactivated_at) where not active;

create table alert_state (
  -- What the alert is about, for example 'queue-lag' or 'board:17:gone'. One row per kind of problem.
  key           text primary key,
  severity      text not null constraint alert_severity_known check (severity in ('warning', 'critical')),
  title         text not null,
  detail        text not null default '',
  opened_at     timestamptz not null,
  -- When the owner was last told, and how many times. Null until a notifier has delivered one.
  last_sent_at  timestamptz,
  send_count    int not null default 0 constraint alert_send_count_not_negative check (send_count >= 0),
  -- Set when the problem went away; the row stays as history until it is old.
  resolved_at   timestamptz
);
create index alert_state_open_idx on alert_state (opened_at) where resolved_at is null;
