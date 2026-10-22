-- Migration 030: admin_fee_config_log (PostgreSQL)
-- Audit trail for on-chain platform fee configuration changes (#1314).
CREATE TABLE IF NOT EXISTS admin_fee_config_log (
  id           BIGSERIAL   PRIMARY KEY,
  tx_hash      TEXT        NOT NULL UNIQUE,
  new_fee_bps  INTEGER     NOT NULL,
  admin_wallet TEXT        NOT NULL,
  created_at   BIGINT      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_fee_config_log_created_at ON admin_fee_config_log (created_at);
