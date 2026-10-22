-- Migration 030: map API player IDs to Soroban's sequential player IDs.

ALTER TABLE players ADD COLUMN on_chain_player_id TEXT;

-- Existing API-only profiles stay pending. Backfill only when a stored
-- registration event has a numeric chain ID and the wallet maps uniquely.
UPDATE players
SET on_chain_player_id = (
  SELECT CAST(COALESCE(
    json_extract(e.payload, '$.on_chain_player_id'),
    json_extract(e.payload, '$.player_id')
  ) AS TEXT)
  FROM events e
  WHERE e.type = 'player_registered'
    AND json_extract(e.payload, '$.wallet') = players.wallet
    AND COALESCE(
      json_extract(e.payload, '$.on_chain_player_id'),
      json_extract(e.payload, '$.player_id')
    ) GLOB '[0-9]*'
    AND COALESCE(
      json_extract(e.payload, '$.on_chain_player_id'),
      json_extract(e.payload, '$.player_id')
    ) NOT GLOB '*[^0-9]*'
  ORDER BY e.ledger DESC
  LIMIT 1
)
WHERE (SELECT COUNT(*) FROM players p WHERE p.wallet = players.wallet) = 1
    AND (
      SELECT COUNT(DISTINCT COALESCE(
        json_extract(e.payload, '$.on_chain_player_id'),
        json_extract(e.payload, '$.player_id')
      ))
      FROM events e
      WHERE e.type = 'player_registered'
        AND json_extract(e.payload, '$.wallet') = players.wallet
        AND COALESCE(
          json_extract(e.payload, '$.on_chain_player_id'),
          json_extract(e.payload, '$.player_id')
        ) GLOB '[0-9]*'
        AND COALESCE(
          json_extract(e.payload, '$.on_chain_player_id'),
          json_extract(e.payload, '$.player_id')
        ) NOT GLOB '*[^0-9]*'
    ) = 1
  AND EXISTS (
    SELECT 1 FROM events e
    WHERE e.type = 'player_registered'
      AND json_extract(e.payload, '$.wallet') = players.wallet
      AND COALESCE(
        json_extract(e.payload, '$.on_chain_player_id'),
        json_extract(e.payload, '$.player_id')
      ) GLOB '[0-9]*'
      AND COALESCE(
        json_extract(e.payload, '$.on_chain_player_id'),
        json_extract(e.payload, '$.player_id')
      ) NOT GLOB '*[^0-9]*'
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_on_chain_player_id
  ON players (on_chain_player_id)
  WHERE on_chain_player_id IS NOT NULL;