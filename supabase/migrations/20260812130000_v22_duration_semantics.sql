-- v2.2 feedback run — P1: duration_s semantics fix (flight time, not log span).
-- Work item run/RUN-CONTEXT-V22.md P1. Additive only; existing RLS policies on
-- flight_log_summary cover the new columns (no new tables).
--
-- duration_s (existing column, DDL unchanged) now stores ARMED FLIGHT TIME:
-- the parser sums all armed spans, using the same arm/disarm detection the
-- battery stats window already consumes (summary.py _assemble_armed_intervals,
-- fed by EV 10/11 + ARM.ArmState). When a log carries no arm events the
-- parser falls back to the full log span — the pre-v2.2 behavior. Which of
-- the two applied is recorded in duration_source (the battery.stats_window
-- pattern). Evidence for the fix: prod log 387be26687b7_00000027.BIN (flight
-- bd0ee3e6) had duration_s=3745.21 (total log span) vs ~570 s actually armed.
--
-- log_duration_s preserves the total log span (first..last message) so no
-- information is lost. Existing rows keep stale duration_s values until the
-- post-merge full reparse (Hex reruns it; RUN-CONTEXT-V22 verified facts).
alter table public.flight_log_summary
  add column log_duration_s numeric
    check (log_duration_s is null or log_duration_s >= 0),
  add column duration_source text
    check (duration_source is null or duration_source in ('armed', 'full_log'));

comment on column public.flight_log_summary.duration_s is
  'Flight duration: summed armed spans (duration_source=armed); falls back '
  'to total log span when the log has no arm events '
  '(duration_source=full_log).';
comment on column public.flight_log_summary.log_duration_s is
  'Total log span in seconds (first..last message) — the pre-v2.2 '
  'duration_s value, kept so nothing is lost.';
comment on column public.flight_log_summary.duration_source is
  'Which window duration_s used: armed | full_log '
  '(mirrors battery.stats_window).';
