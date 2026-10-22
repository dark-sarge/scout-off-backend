-- Migration 030: admin_fee_config_log
-- Audit trail for on-chain platform fee configuration changes (#1314).
-- Each row represents one successful set_platform_fee_bps invocation.
CREATE TABLE IF NOT EXISTS admin_fee_config_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash     TEXT    NOT NULL UNIQUE,
  new_fee_bps INTEGER NOT NULL,
  admin_wallet TEXT   NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_fee_config_log_created_at ON admin_fee_config_log (created_at);
