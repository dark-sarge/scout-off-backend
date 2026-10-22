-- Migration 031: persist player token supply and holder balances.

CREATE TABLE IF NOT EXISTS player_token_supply (
  player_id TEXT PRIMARY KEY,
  total_supply BIGINT NOT NULL CHECK (total_supply >= 0)
);

CREATE TABLE IF NOT EXISTS player_token_balances (
  player_id TEXT NOT NULL,
  holder_wallet TEXT NOT NULL,
  token_balance BIGINT NOT NULL CHECK (token_balance >= 0),
  PRIMARY KEY (player_id, holder_wallet)
);

CREATE INDEX IF NOT EXISTS idx_player_token_balances_player
  ON player_token_balances (player_id);