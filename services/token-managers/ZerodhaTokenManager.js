// apps/tokenbot/services/token-managers/ZerodhaTokenManager.js
const TokenManager = require('./TokenManager');
const db = require('../../config/database');
const encryptor = require('../encryptor');
const tokenFetcher = require('../tokenFetcher');
const logger = require('../../utils/logger');
const { retryWithBackoff } = require('../../utils/retry');

class ZerodhaTokenManager extends TokenManager {
    get brokerType() {
        return 'ZERODHA';
    }

    get refreshInterval() {
        // 2 hours refresh interval
        return 2 * 60 * 60 * 1000;
    }

    getExpiryWarningThreshold() {
        return 60 * 60 * 1000; // 1 hr warning
    }

    /**
     * Refreshes the token for ZERODHA
     */
    async refresh(context) {
        const { userId, connectionId, accountId, currentToken, correlationId } = context;
        let attemptNumber = 0;
        const maxAttempts = 3;
        const startTime = Date.now();

        try {
            logger.info(`[ZerodhaTokenManager] 🔄 Starting token refresh for user ${userId}, connection ${connectionId}`);

            // 1. Get Credentials
            const credentials = await this._getCredentials(userId, connectionId);

            // Decrypt credentials
            const decryptedCreds = {
                kite_user_id: credentials.kite_user_id,
                password: encryptor.decrypt(credentials.encrypted_password),
                totp_secret: encryptor.decrypt(credentials.encrypted_totp_secret),
                api_key: encryptor.decrypt(credentials.encrypted_api_key),
                api_secret: encryptor.decrypt(credentials.encrypted_api_secret)
            };

            // 2. Run Token Fetcher
            const tokenData = await retryWithBackoff(
                async () => {
                    attemptNumber++;
                    logger.info(`[ZerodhaTokenManager] 📝 Token generation attempt ${attemptNumber}/${maxAttempts} for user ${userId}`);
                    return await tokenFetcher.fetchAccessToken(decryptedCreds);
                },
                maxAttempts,
                (error, attempt) => {
                    logger.warn(`[ZerodhaTokenManager] ⚠️ Attempt ${attempt} failed for user ${userId}: ${error.message}`);
                }
            );

            // 3. Fallback tracking to kite_tokens (legacy support)
            try {
                await this._storeLegacyToken(userId, tokenData);
            } catch (err) {
                logger.warn(`[ZerodhaTokenManager] Legacy kite_tokens sync failed: ${err.message}`);
            }

            const nextRefresh = new Date(Date.now() + this.refreshInterval);
            const executionTimeMs = Date.now() - startTime;

            // Log success
            await this._logTokenRefresh(connectionId, 'VALID', null, executionTimeMs, nextRefresh);

            return {
                success: true,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token || null,
                expires_at: nextRefresh,
                execution_time_ms: executionTimeMs,
                token_status: 'VALID'
            };

        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            await this._logTokenRefresh(connectionId, 'FAILED', error.message, executionTimeMs, null);
            logger.error(`[ZerodhaTokenManager] ❌ Token generation failed for user ${userId}: ${error.message}`);

            return {
                success: false,
                error: error.message,
                execution_time_ms: executionTimeMs,
                token_status: 'FAILED'
            };
        }
    }

    async _getCredentials(userId, connectionId) {
        // Check BrokerConnection for new dual broker architecture
        if (connectionId) {
            const connResult = await db.query(
                `SELECT "credentialsEncrypted" FROM "BrokerConnection" WHERE id = $1`,
                [connectionId]
            );
            if (connResult.rows.length > 0 && connResult.rows[0].credentialsEncrypted) {
                let creds = connResult.rows[0].credentialsEncrypted;
                if (typeof creds === 'string') {
                    creds = JSON.parse(creds);
                }
                if (creds.encrypted_password && creds.kite_user_id) {
                    return creds;
                }
            }
        }

        // Fallback to legacy kite_user_credentials
        let credsResult = await db.query(
            `SELECT * FROM kite_user_credentials WHERE user_id = $1 AND is_active = true`,
            [userId]
        );

        if (credsResult.rows.length === 0) {
            const inactiveResult = await db.query(
                `SELECT * FROM kite_user_credentials WHERE user_id = $1 AND is_active = false`,
                [userId]
            );
            if (inactiveResult.rows.length > 0) {
                throw new Error(`Zerodha credentials for user ${userId} exist but are marked inactive.`);
            }
            throw new Error(`No active Zerodha credentials found for user ${userId}.`);
        }

        const creds = credsResult.rows[0];
        if (creds.kite_user_id === 'pending' || creds.kite_user_id === 'pending_setup') {
            throw new Error(`Credentials for user ${userId} are incomplete.`);
        }

        return creds;
    }

    async _storeLegacyToken(userId, tokenData) {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await client.query(`UPDATE kite_tokens SET is_valid = false WHERE user_id = $1`, [userId]);
            await client.query(`
         INSERT INTO kite_tokens (user_id, access_token, public_token, login_time, expires_at, generation_method, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'automated', NOW())
       `, [userId, tokenData.access_token, tokenData.public_token, tokenData.login_time, tokenData.expires_at]);
            await client.query(`UPDATE kite_user_credentials SET last_used = NOW() WHERE user_id = $1`, [userId]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async _logTokenRefresh(connectionId, status, error, durationMs, nextRefresh) {
        if (!connectionId) return;
        try {
            const client = await db.getClient();
            try {
                await client.query(`
          INSERT INTO "TokenRefreshHistory" 
            ("id", "brokerConnectionId", "brokerType", "refreshTimestamp", "tokenStatus", "errorMessage", "durationMs", "nextRefreshScheduled", "createdAt")
          VALUES 
            (gen_random_uuid(), $1, $2, NOW(), $3, $4, $5, $6, NOW())
        `, [
                    connectionId,
                    this.brokerType,
                    status,
                    error ? String(error).substring(0, 1000) : null,
                    durationMs,
                    nextRefresh
                ]);
            } finally {
                client.release();
            }
        } catch (dbError) {
            logger.warn(`[ZerodhaTokenManager] Failed to log refresh history: ${dbError.message}`);
        }
    }
}

module.exports = ZerodhaTokenManager;
