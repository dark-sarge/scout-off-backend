-- Migration 030: add locked_until lease column to idempotency_keys (PostgreSQL).
--
-- A pending record with locked_until < now() can be re-claimed atomically by a
-- new request after the owning process crashed or timed out, ending the
-- previous 24-hour stuck-pending window.
--
-- Existing rows (already 'complete') are unaffected; NULLs sort before any
-- real timestamp so an un-leased legacy pending row is treated as immediately
-- expired and can be re-claimed straight away.

ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS locked_until BIGINT;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_locked_until
  ON idempotency_keys (locked_until);
