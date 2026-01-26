const db = require('../config/database');
const encryptor = require('./encryptor');
const logger = require('../utils/logger');

class CredentialLoader {
    /**
     * Sync credentials from environment variables to database
     * This allows the service to work immediately when deployed with Env Vars
     */
    async syncFromEnv() {
        try {
            // 1. Check if Env Vars are present
            const userId = process.env.ZERODHA_USER_ID;
            const password = process.env.ZERODHA_PASSWORD;
            const totpSecret = process.env.ZERODHA_TOTP_SECRET;
            const apiKey = process.env.ZERODHA_API_KEY;
            const apiSecret = process.env.ZERODHA_API_SECRET;

            if (!userId || !password || !totpSecret || !apiKey || !apiSecret) {
                logger.info('ℹ️ Skipping Env Var sync: Missing one or more ZERODHA_* variables');
                return;
            }

            logger.info('🔄 Checking for existing credentials...');

            // 2. Check if credentials already exist for 'default' user
            const existing = await db.query(
                `SELECT kite_user_id FROM kite_user_credentials WHERE user_id = 'default'`
            );

            // 3. If missing or placeholder, Sync
            if (existing.rows.length === 0 || existing.rows[0].kite_user_id === 'pending') {
                logger.info('🔄 Syncing credentials from Environment Variables...');

                const encrypted = {
                    password: encryptor.encrypt(password),
                    totp_secret: encryptor.encrypt(totpSecret),
                    api_key: encryptor.encrypt(apiKey),
                    api_secret: encryptor.encrypt(apiSecret)
                };

                await db.query(`
          INSERT INTO kite_user_credentials (
            user_id, kite_user_id, encrypted_password, encrypted_totp_secret,
            encrypted_api_key, encrypted_api_secret, auto_refresh_enabled, is_active, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, true, true, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            kite_user_id = $2,
            encrypted_password = $3,
            encrypted_totp_secret = $4,
            encrypted_api_key = $5,
            encrypted_api_secret = $6,
            auto_refresh_enabled = true,
            is_active = true,
            updated_at = NOW()
        `, [
                    'default',
                    userId,
                    encrypted.password,
                    encrypted.totp_secret,
                    encrypted.api_key,
                    encrypted.api_secret
                ]);

                logger.info('✅ Initialized default user credentials from environment variables');
            } else {
                logger.info('ℹ️ Credentials already configured in DB, skipping Env Var sync');
            }

        } catch (error) {
            logger.error('❌ Failed to sync credentials from Env:', error.message);
        }
    }
}

module.exports = new CredentialLoader();
