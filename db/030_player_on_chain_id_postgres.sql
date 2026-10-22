-- Migration 030: map API player IDs to Soroban's sequential player IDs.

ALTER TABLE players ADD COLUMN on_chain_player_id TEXT;

-- Existing API-only profiles stay pending. Backfill only when a stored
-- registration event has a numeric chain ID and the wallet maps uniquely.
WITH numeric_events AS (
  SELECT
    payload::jsonb ->> 'wallet' AS wallet,
    COALESCE(
      payload::jsonb ->> 'on_chain_player_id',
      payload::jsonb ->> 'player_id'
    ) AS on_chain_player_id,
    ledger
  FROM events
  WHERE type = 'player_registered'
    AND COALESCE(
      payload::jsonb ->> 'on_chain_player_id',
      payload::jsonb ->> 'player_id'
    ) ~ '^[0-9]+$'
), registration_counts AS (
  SELECT wallet, COUNT(DISTINCT on_chain_player_id) AS distinct_ids
  FROM numeric_events
  GROUP BY wallet
), latest_registration AS (
  SELECT DISTINCT ON (wallet) wallet, on_chain_player_id
  FROM numeric_events
  ORDER BY wallet, ledger DESC
), registration_ids AS (
  SELECT l.wallet, l.on_chain_player_id, c.distinct_ids
  FROM latest_registration l
  JOIN registration_counts c USING (wallet)
)
UPDATE players p
SET on_chain_player_id = r.on_chain_player_id
FROM registration_ids r
WHERE r.wallet = p.wallet
  AND r.distinct_ids = 1
  AND (SELECT COUNT(*) FROM players p2 WHERE p2.wallet = p.wallet) = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_on_chain_player_id
  ON players (on_chain_player_id)
  WHERE on_chain_player_id IS NOT NULL;