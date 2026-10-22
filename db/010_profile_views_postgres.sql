-- Migration 010: profile_views table (PostgreSQL)
-- Persistent record of scout profile views with deduplication window tracking.

CREATE TABLE IF NOT EXISTS profile_views (
  id           BIGSERIAL PRIMARY KEY,
  scout_wallet TEXT   NOT NULL,
  player_id    TEXT   NOT NULL,
  viewed_at    BIGINT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_views_dedup
  ON profile_views (player_id, scout_wallet, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_profile_views_player
  ON profile_views (player_id);
