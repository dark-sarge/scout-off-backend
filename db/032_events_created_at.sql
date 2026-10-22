-- Migration 032: events.created_at parity (SQLite no-op)
--
-- The SQLite events table has carried created_at since 001_initial.sql (and
-- 028_event_ordering.sql preserves it), so there is nothing to do here. This
-- file exists so the Postgres counterpart is paired per the parity check.
SELECT 1;
