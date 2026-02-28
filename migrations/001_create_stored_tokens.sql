-- Create stored_tokens table for TokenBot service
-- This table stores token data received from the backend

CREATE TABLE IF NOT EXISTS stored_tokens (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    broker_connection_id VARCHAR(255) NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMP,
    mode VARCHAR(50) DEFAULT 'manual',
    last_refresh_at TIMESTAMP,
    refresh_status VARCHAR(50) DEFAULT 'pending',
    error_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_stored_tokens_user_id ON stored_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_stored_tokens_broker_connection_id ON stored_tokens(broker_connection_id);
CREATE INDEX IF NOT EXISTS idx_stored_tokens_updated_at ON stored_tokens(updated_at);

-- Add comment
COMMENT ON TABLE stored_tokens IS 'Stores token data received from backend services';
COMMENT ON COLUMN stored_tokens.user_id IS 'User identifier';
COMMENT ON COLUMN stored_tokens.broker_connection_id IS 'BrokerConnection identifier or legacy token key';
COMMENT ON COLUMN stored_tokens.access_token IS 'Kite access token';
COMMENT ON COLUMN stored_tokens.refresh_token IS 'Kite refresh token';
COMMENT ON COLUMN stored_tokens.expires_at IS 'Token expiration timestamp';
COMMENT ON COLUMN stored_tokens.mode IS 'Token source mode (manual, autonomous, etc.)';
