-- Migration 029: recreate the composite (type, ledger) index on events.
-- Migration 028 used ALTER TABLE on PostgreSQL, so this index normally
-- already exists there; IF NOT EXISTS also repairs databases where it does not.
CREATE INDEX IF NOT EXISTS idx_events_type_ledger ON events (type, ledger);
