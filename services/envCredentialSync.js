const db = require('../config/database');
const encryptor = require('./encryptor');
const logger = require('../utils/logger');

function resolveTokenBotUserId() {
    const candidate =
        process.env.TOKENBOT_SERVICE_USER_ID ||
        process.env.SERVICE_USER_ID ||
        process.env.SYSTEM_USER_ID ||
        process.env.JOB_USER_ID ||
        (process.env.NODE_ENV !== 'production' ? process.env.USER_ID : null);

    if (candidate && String(candidate).trim()) {
        return String(candidate).trim();
    }

    if (process.env.NODE_ENV !== 'production') {
        return 'local-dev-user';
    }

    return null;
}

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

            const botUserId = resolveTokenBotUserId();
            if (!botUserId) {
                logger.warn('⚠️ [EnvSync] Missing service user id in production. Skipping credential auto-sync.');
                return;
            }

            // 3. CHECK if sync is needed (Prevent Crash Loops)
            // Fetch existing credentials
            const existing = await db.query(
                `SELECT * FROM kite_user_credentials WHERE user_id = $1`,
                [botUserId]
            );

            let needsUpdate = true;

            if (existing.rows.length > 0) {
                const creds = existing.rows[0];
                try {
                    // Decrypt stored API Key to compare
                    const storedApiKey = encryptor.decrypt(creds.encrypted_api_key);
                    const storedUserId = creds.kite_user_id;

                    // If critical identity fields match, we assume it's synced.
                    // Comparing everything is safer but more expensive.
                    // We compare UserID and API Key as primary indicators.
                    if (storedUserId === userId && storedApiKey === apiKey) {
                        needsUpdate = false;
                        logger.info('✅ [EnvSync] Credentials already match environment. Skipping update & token invalidation.');
                    }
                } catch (e) {
                    logger.warn('⚠️ [EnvSync] Failed to compare existing credentials (decryption error?), forcing update.');
                    needsUpdate = true;
                }
            }

            if (!needsUpdate) {
                return;
            }

            logger.info('🔄 [EnvSync] Difference detected or new setup. Syncing credentials & invalidating token...');

            // 4. Upsert into database
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
