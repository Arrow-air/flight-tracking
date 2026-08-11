-- Flight Tracking v2 — enum types
-- Source of truth: docs/RUN-CONTEXT.md "Schema" + docs/V2-PLAN.md "Data model sketch (v2)".

create type public.user_role as enum ('admin', 'manufacturer', 'operator');

create type public.aircraft_class as enum ('multirotor', 'fixed_wing');

create type public.aircraft_status as enum ('active', 'maintenance', 'retired');

create type public.site_visibility as enum ('public', 'private');

create type public.component_event_kind as enum ('installed', 'removed');

create type public.airframe_event_kind as enum ('maintenance', 'incident', 'field_action');

-- ASSUMPTION: severity/status value sets are not specified in the plan.
-- Plan says '"squawk" = issue with severity=low', so 'low' must exist.
create type public.issue_severity as enum ('low', 'medium', 'high', 'critical');
create type public.issue_status as enum ('open', 'in_progress', 'resolved', 'closed');

create type public.fixable as enum ('yes', 'no', 'unknown');

-- Carried over from v1 (project-flight-tracking declarative schema) to ease the M5 import.
create type public.flight_note_type as enum ('pilot', 'admin', 'engineer', 'witness', 'other');

create type public.flight_log_status as enum ('uploaded', 'parsing', 'parsed', 'error');

create type public.media_kind as enum ('photo', 'report', 'doc');

create type public.export_visibility as enum ('private', 'shared');

create type public.audit_action as enum ('INSERT', 'UPDATE', 'DELETE');
