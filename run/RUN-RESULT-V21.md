# RUN-RESULT-V21 (in progress)

Finalizer: extend this file with per-phase summaries and critic scores.
The risk register below was seeded by the builder in round 2 — KEEP these
entries and carry them into the PR body.

## Risk register

1. **Deploy-ordering window: /flights vs migration 20260811120000** —
   `src/pages/Flights.vue` selects `flight_log_summary.start_time_utc`,
   which exists only in unapplied migration
   `supabase/migrations/20260811120000_v21_summary_takeoff_start_incident.sql`.
   The frontend auto-deploys on merge to main; the migration is applied
   by Hex AFTER merge. **Action: apply the migration before or
   immediately at merge.** Mitigation shipped in r2: Flights.vue now
   catches the missing-column error and retries with `duration_s` only,
   so /flights still renders (durations correct, start column falls back
   to hand-entered `started_at`) during the window. FlightCard uses
   `flight_log_summary(*)` and is unaffected. The parser also only
   starts persisting `start_time_utc`/takeoff coords once the column
   exists (db.py drops unknown keys), so summaries written during the
   window lack log-derived start times until reparsed.
