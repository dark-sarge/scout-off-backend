-- Migration 025: grace-period key rotation (PostgreSQL)
-- See db/025_api_key_rotation.sql for the full rationale.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoke_after INTEGER;
