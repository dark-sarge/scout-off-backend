-- Migration 032 (Postgres): add events.created_at
--
-- 001_initial_postgres.sql omitted the created_at column that the SQLite
-- schema has always had, so every indexer INSERT (indexer.ts,
-- eventBatchProcessor.ts, reindexService.ts) failed on Postgres with
-- `column "created_at" of relation "events" does not exist`.
-- BIGINT: values are epoch timestamps that can exceed 32-bit INTEGER.

ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at BIGINT;
