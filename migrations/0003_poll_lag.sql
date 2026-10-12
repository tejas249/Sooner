-- 0003_poll_lag: how late each poll started.
--
--   * poll_run.queue_lag_ms: how long after its due time the poll began. The queue's promise is that a board is polled within
--     about a minute of falling due. Keeping the number for every poll lets that be shown over days (the middle, the 95th
--     percentile, the worst case) instead of only watched live. It is null for polls recorded before this column existed.
--     A bigint, not an int: a worker that was switched off for a month and then started again polls boards that are 2.6 billion
--     milliseconds late, which does not fit in 32 bits, and a poll must never fail to be recorded because it was very late.

alter table poll_run
  add column queue_lag_ms bigint
    constraint poll_run_lag_not_negative check (queue_lag_ms is null or queue_lag_ms >= 0);
