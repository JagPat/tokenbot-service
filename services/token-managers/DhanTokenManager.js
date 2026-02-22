// apps/tokenbot/services/token-managers/DhanTokenManager.js
const TokenManager = require('./TokenManager');
const dhanAuthProvider = require('../providers/dhan');
const dhanTokenFetcher = require('../dhanTokenFetcher');
const logger = require('../../utils/logger');
const db = require('../../config/database');
const encryptor = require('../encryptor');

class DhanTokenManager extends TokenManager {
    get brokerType() {
        return 'DHAN';
    }

    get refreshInterval() {
        // Refresh Dhan every 10 minutes (in ms) to ensure the token remains valid and active
        return 10 * 60 * 1000;
    }

    getExpiryWarningThreshold() {
        // Warn 1 hour before expiry
        return 60 * 60 * 1000;
    }

    /**
     * Get Dhan credentials from dhan_user_credentials table.
     * Falls back to BrokerConnection.credentialsEncrypted.
     */
    async _getCredentials(userId, connectionId) {
        // 1. Check BrokerConnection.credentialsEncrypted first (preferred)
        if (connectionId) {
            const connResult = await db.query(
                `SELECT "credentialsEncrypted" FROM "BrokerConnection" WHERE id = $1`,
                [connectionId]
            );
            if (connResult.rows.length > 0 && connResult.rows[0].credentialsEncrypted) {
                let creds = connResult.rows[0].credentialsEncrypted;
                if (typeof creds === 'string') creds = JSON.parse(creds);
                if (creds.client_id && (creds.encrypted_password || creds.access_token)) {
                    return creds;
                }
            }
        }

        // 2. Check dhan_user_credentials (centralised table like kite_user_credentials)
        const result = await db.query(
            `SELECT * FROM dhan_user_credentials WHERE user_id = $1 AND is_active = true LIMIT 1`,
            [userId]
        );

        if (result.rows.length > 0) return result.rows[0];

        throw new Error(`No active Dhan credentials found for user ${userId}. Push credentials first via POST /api/credentials/dhan`);
    }

    /**
     * Refreshes the Dhan token.
     *
     * Strategy:
     *   1. If currentToken.access_token exists → try RenewToken (quick, in-process)
     *   2. If no current token OR RenewToken fails → Puppeteer full login
     *      (requires stored credentials: client_id, password, totp_secret, api_key)
     */
    async refresh(context) {
        const { userId, connectionId, accountId, currentToken, correlationId } = context;
        const startTime = Date.now();

        // Path A: Token renewal (fast path — no browser needed)
        if (currentToken?.access_token) {
            try {
                logger.info(`[DhanTokenManager] ⚡ Fast path: renewing existing Dhan token for ${userId}`);
                const renewed = await dhanAuthProvider.renewToken(
                    currentToken.access_token,
                    accountId || currentToken.account_id || null
                );

                const nextRefresh = renewed.expires_at
                    ? new Date(renewed.expires_at)
                    : new Date(Date.now() + this.refreshInterval);

                await this._logTokenRefresh(connectionId, 'VALID', null, Date.now() - startTime, nextRefresh);
                logger.info(`[DhanTokenManager] ✅ Token renewed via RenewToken. Next check: ${nextRefresh.toISOString()}`);

                return {
                    success: true,
                    access_token: renewed.access_token,
                    refresh_token: renewed.refresh_token || currentToken.refresh_token || null,
                    next_refresh_at: nextRefresh,
                    execution_time_ms: Date.now() - startTime,
                    token_status: 'VALID'
                };
            } catch (renewError) {
                logger.warn(`[DhanTokenManager] ⚠️ RenewToken failed (${renewError.message}), falling back to Puppeteer login`);
            }
        }

        // Path B: Full Puppeteer login (slow path — browser automation)
        try {
            logger.info(`[DhanTokenManager] 🤖 Puppeteer path: full browser login for Dhan user ${userId}`);
            const credentials = await this._getCredentials(userId, connectionId);

            const decryptedCreds = {
                client_id: credentials.client_id || credentials.dhan_client_id,
                dhan_user_id: credentials.dhan_user_id || credentials.client_id,
                password: credentials.encrypted_password
                    ? encryptor.decrypt(credentials.encrypted_password)
                    : credentials.password,
                totp_secret: credentials.encrypted_totp_secret
                    ? encryptor.decrypt(credentials.encrypted_totp_secret)
                    : (credentials.totp_secret || null),
                api_key: credentials.encrypted_api_key
                    ? encryptor.decrypt(credentials.encrypted_api_key)
                    : credentials.api_key,
                api_secret: credentials.encrypted_api_secret
                    ? encryptor.decrypt(credentials.encrypted_api_secret)
                    : (credentials.api_secret || null),
                redirect_uri: credentials.redirect_uri || null,
            };

            if (!decryptedCreds.client_id || !decryptedCreds.password || !decryptedCreds.api_key) {
                throw new Error('Dhan Puppeteer login requires: client_id, password, and api_key');
            }

            const tokenData = await dhanTokenFetcher.fetchAccessToken(decryptedCreds);

            const nextRefresh = tokenData.expires_at
                ? new Date(tokenData.expires_at)
                : new Date(Date.now() + this.refreshInterval);

            await this._logTokenRefresh(connectionId, 'VALID', null, Date.now() - startTime, nextRefresh);
            logger.info(`[DhanTokenManager] ✅ Dhan Puppeteer login succeeded for ${userId}`);

            return {
                success: true,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token || null,
                next_refresh_at: nextRefresh,
                execution_time_ms: Date.now() - startTime,
                token_status: 'VALID'
            };

        } catch (error) {
            logger.error(`[DhanTokenManager] ❌ Token refresh failed: ${error.message}`);
            const executionTime = Date.now() - startTime;
            await this._logTokenRefresh(connectionId, 'FAILED', error.message, executionTime, null);

            return {
                success: false,
                error: error.message,
                execution_time_ms: executionTime,
                token_status: 'FAILED'
            };
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
            logger.warn(`[DhanTokenManager] Failed to log refresh history: ${dbError.message}`);
        }
    }
}

module.exports = DhanTokenManager;
