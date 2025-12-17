const db = require('../config/database');
const encryptor = require('./encryptor');
const logger = require('../utils/logger');

class EnvironmentCredentialSync {
    /**
     * Syncs credentials from environment variables to the database if they exist.
     * This allows "Infrastructure as Code" management of credentials via Railway variables.
     */
    async sync() {
        try {
            // 1. Check if Env Vars are present
            const userId = process.env.ZERODHA_USER_ID;
            const password = process.env.ZERODHA_PASSWORD;
            const totpSecret = process.env.ZERODHA_TOTP_SECRET;
            const apiKey = process.env.ZERODHA_API_KEY;
            const apiSecret = process.env.ZERODHA_API_SECRET;

            if (!userId || !password || !totpSecret || !apiKey || !apiSecret) {
                logger.info('ℹ️ [EnvSync] Credentials not found in environment variables. Skipping auto-sync.');
                return;
            }

            logger.info('🔄 [EnvSync] Detected credentials in environment variables. Syncing to database...');

            // 2. Encrypt credentials
            const encrypted = {
                password: encryptor.encrypt(password),
                totp_secret: encryptor.encrypt(totpSecret),
                api_key: encryptor.encrypt(apiKey),
                api_secret: encryptor.encrypt(apiSecret)
            };

            // 3. Upsert into database
            // We use 'default' as the user_id for the primary bot user
            const botUserId = 'default';

            await db.query(`
        INSERT INTO kite_user_credentials (
          user_id, kite_user_id, encrypted_password, encrypted_totp_secret,
          encrypted_api_key, encrypted_api_secret, auto_refresh_enabled, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          kite_user_id = EXCLUDED.kite_user_id,
          encrypted_password = EXCLUDED.encrypted_password,
          encrypted_totp_secret = EXCLUDED.encrypted_totp_secret,
          encrypted_api_key = EXCLUDED.encrypted_api_key,
          encrypted_api_secret = EXCLUDED.encrypted_api_secret,
          auto_refresh_enabled = true,
          updated_at = NOW()
      `, [
                botUserId,
                userId,
                encrypted.password,
                encrypted.totp_secret,
                encrypted.api_key,
                encrypted.api_secret
            ]);

            // 4. INVALIDATE EXISTING TOKEN
            // This is crucial: We just changed credentials (potentially), so the old token 
            // is likely invalid or mismatched. We must delete it so the Scheduler
            // sees "No Token" and forces a fresh login immediately.
            await db.query(`DELETE FROM stored_tokens WHERE user_id = $1`, [botUserId]);
            logger.info(`🗑️ [EnvSync] Invalidated/Deleted old access token for user: ${botUserId} to force refresh.`);

            logger.info(`✅ [EnvSync] Credentials successfully synced/updated from environment variables for user: ${botUserId}`);

        } catch (error) {
            logger.error(`❌ [EnvSync] Failed to sync credentials from environment: ${error.message}`);
            // We don't throw here to avoid crashing the server on startup, just log the error
        }
    }
}

module.exports = new EnvironmentCredentialSync();
