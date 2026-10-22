-- Migration 013: add missing composite indexes for high-frequency query patterns
-- (PostgreSQL).

CREATE INDEX IF NOT EXISTS idx_players_region_position_tier
    ON players (region, position, progress_level);

CREATE INDEX IF NOT EXISTS idx_subscriptions_wallet_active_expires
    ON subscriptions (scout_wallet, cancelled_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_contact_unlocks_scout_player
    ON contact_unlocks (scout_wallet, player_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_created_at
    ON audit_log (action, created_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key_expires
    ON idempotency_keys (key, expires_at);
