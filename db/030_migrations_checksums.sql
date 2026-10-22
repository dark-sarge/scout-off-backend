-- Add checksum column to migrations table for detecting edited migrations (#1318)
ALTER TABLE migrations ADD COLUMN checksum TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_migrations_checksum ON migrations(checksum);
