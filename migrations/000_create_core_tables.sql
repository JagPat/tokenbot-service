-- Core tables for TokenBot service
-- This migration creates all required tables for the service to function

-- ============================================
-- 1. kite_user_credentials table
-- Stores encrypted user credentials for Kite API
-- ============================================
CREATE TABLE IF NOT EXISTS kite_user_credentials (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    kite_user_id VARCHAR(100) NOT NULL,
    encrypted_password TEXT NOT NULL,
    encrypted_totp_secret TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    encrypted_api_secret TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    auto_refresh_enabled BOOLEAN DEFAULT true,
    last_used TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kite_user_credentials_user_id ON kite_user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_kite_user_credentials_is_active ON kite_user_credentials(is_active);

COMMENT ON TABLE kite_user_credentials IS 'Stores encrypted Kite API credentials for users';

-- ============================================
-- 2. kite_tokens table
-- Stores generated access tokens
-- ============================================
CREATE TABLE IF NOT EXISTS kite_tokens (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    access_token TEXT NOT NULL,
    public_token TEXT,
    login_time TIMESTAMP,
    expires_at TIMESTAMP,
    generation_method VARCHAR(50) DEFAULT 'manual',
    is_valid BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kite_tokens_user_id ON kite_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_kite_tokens_is_valid ON kite_tokens(is_valid);
CREATE INDEX IF NOT EXISTS idx_kite_tokens_expires_at ON kite_tokens(expires_at);

COMMENT ON TABLE kite_tokens IS 'Stores generated Kite access tokens';

-- ============================================
-- 3. token_generation_logs table
-- Logs token generation attempts for debugging
-- ============================================
CREATE TABLE IF NOT EXISTS token_generation_logs (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    attempt_number INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_message TEXT,
    execution_time_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_generation_logs_user_id ON token_generation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_token_generation_logs_created_at ON token_generation_logs(created_at);

COMMENT ON TABLE token_generation_logs IS 'Logs token generation attempts for audit and debugging';

-- ============================================
-- 4. Update trigger function (if not exists)
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_kite_user_credentials_updated_at ON kite_user_credentials;
CREATE TRIGGER update_kite_user_credentials_updated_at 
    BEFORE UPDATE ON kite_user_credentials 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_kite_tokens_updated_at ON kite_tokens;
CREATE TRIGGER update_kite_tokens_updated_at 
    BEFORE UPDATE ON kite_tokens 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();
