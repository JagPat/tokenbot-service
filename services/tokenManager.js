const db = require('../config/database');
const tokenFetcher = require('./tokenFetcher');
const encryptor = require('./encryptor');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');
const dhanAuthProvider = require('./providers/dhan');
const { assertProductionSafeUserId, normalizeUserId } = require('../utils/userIdPolicy');
const distributedLock = require('./distributedLock');
const DhanTokenManager = require('./token-managers/DhanTokenManager');
const ZerodhaTokenManager = require('./token-managers/ZerodhaTokenManager');

class TokenManager {
  constructor() {
    this.inFlightRefreshes = new Map();
    this.refreshLockTtlMs = Math.max(5000, parseInt(process.env.TOKEN_REFRESH_LOCK_TTL_MS || '45000', 10));
    this.allowLegacyStoredTokenFallback = String(process.env.LEGACY_ALLOW_STORED_TOKENS || 'false').toLowerCase() === 'true';
    this.dhanManager = new DhanTokenManager();
    this.zerodhaManager = new ZerodhaTokenManager();

    if (this._isProduction()) {
      this._logLegacyStoredTokenRows().catch((error) => {
        logger.warn(`⚠️ Could not inspect legacy stored_tokens rows at startup: ${error.message}`);
      });
    }
  }

  _isProduction() {
    return process.env.NODE_ENV === 'production';
  }

  _normalizeBrokerType(brokerType) {
    const normalized = String(brokerType || 'ZERODHA').trim().toUpperCase();
    return normalized || 'ZERODHA';
  }

  _normalizeConnectionId(connectionId) {
    if (!connectionId || typeof connectionId !== 'string') return null;
    const normalized = connectionId.trim();
    if (!normalized || normalized.toLowerCase() === 'default') return null;
    return normalized;
  }

  _normalizeAccountId(accountId) {
    if (!accountId || typeof accountId !== 'string') return null;
    const normalized = accountId.trim();
    return normalized.length > 0 ? normalized : null;
  }

  _buildStoredTokenKey({ connectionId = null, userId = null, brokerType = 'ZERODHA', accountId = null }) {
    const normalizedConnectionId = this._normalizeConnectionId(connectionId);
    if (normalizedConnectionId) {
      return normalizedConnectionId;
    }

    const normalizedUserId = normalizeUserId(userId) || 'unknown-user';
    const normalizedBrokerType = this._normalizeBrokerType(brokerType);
    const normalizedAccountId = this._normalizeAccountId(accountId) || 'default';
    return `legacy:${normalizedUserId}:${normalizedBrokerType}:${normalizedAccountId}`;
  }

  _buildError(message, statusCode = 500, code = 'TOKENBOT_ERROR') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
  }

  async _logLegacyStoredTokenRows() {
    const result = await db.query(`
      SELECT COUNT(*)::int AS total
      FROM stored_tokens
      WHERE broker_connection_id LIKE 'legacy:%'
    `);
    const total = Number(result.rows[0]?.total || 0);
    if (total > 0) {
      logger.warn(`⚠️ Detected ${total} legacy stored_tokens row(s) with broker_connection_id starting 'legacy:'. Use manual relink script before disabling fallback permanently.`);
    }
  }

  _normalizeTokenRequest(userIdOrContext, brokerType, accountId, connectionId) {
    if (userIdOrContext && typeof userIdOrContext === 'object' && !Array.isArray(userIdOrContext)) {
      return {
        userId: userIdOrContext.userId || userIdOrContext.user_id || null,
        brokerType: userIdOrContext.brokerType || userIdOrContext.broker_type || brokerType || 'ZERODHA',
        accountId: userIdOrContext.accountId || userIdOrContext.account_id || accountId || null,
        connectionId:
          userIdOrContext.brokerConnectionId ||
          userIdOrContext.broker_connection_id ||
          userIdOrContext.connectionId ||
          userIdOrContext.connection_id ||
          connectionId ||
          null,
        correlationId: userIdOrContext.correlationId || null
      };
    }

    return {
      userId: userIdOrContext || null,
      brokerType: brokerType || 'ZERODHA',
      accountId: accountId || null,
      connectionId: connectionId || null,
      correlationId: null
    };
  }

  async _resolveConnectionContext({
    userId = null,
    brokerType = 'ZERODHA',
    accountId = null,
    connectionId = null,
    operation = 'lookup'
  }) {
    const normalizedBrokerType = this._normalizeBrokerType(brokerType);
    const normalizedConnectionId = this._normalizeConnectionId(connectionId);
    const normalizedAccountId = this._normalizeAccountId(accountId);
    const normalizedUserId = normalizedConnectionId
      ? (userId ? assertProductionSafeUserId(userId, operation) : null)
      : assertProductionSafeUserId(userId, operation);

    if (normalizedConnectionId) {
      const result = await db.query(`
        SELECT
          id,
          "userId" AS user_id,
          "brokerType" AS broker_type,
          "accountId" AS account_id,
          "isActive" AS is_active
        FROM "BrokerConnection"
        WHERE id = $1
        LIMIT 1
      `, [normalizedConnectionId]);

      if (result.rows.length === 0) {
        throw this._buildError(`Broker connection ${normalizedConnectionId} not found`, 404, 'BROKER_CONNECTION_NOT_FOUND');
      }

      const row = result.rows[0];
      const safeUserId = assertProductionSafeUserId(row.user_id, operation);

      if (normalizedUserId && normalizedUserId !== safeUserId) {
        throw this._buildError('brokerConnectionId does not belong to requested user', 403, 'BROKER_CONNECTION_USER_MISMATCH');
      }

      if (normalizedBrokerType && row.broker_type !== normalizedBrokerType) {
        throw this._buildError(
          `brokerConnectionId ${normalizedConnectionId} is ${row.broker_type}, not ${normalizedBrokerType}`,
          400,
          'BROKER_CONNECTION_BROKER_MISMATCH'
        );
      }

      if (!row.is_active && this._isProduction()) {
        throw this._buildError(`Broker connection ${normalizedConnectionId} is inactive`, 409, 'BROKER_CONNECTION_INACTIVE');
      }

      return {
        userId: safeUserId,
        brokerType: row.broker_type,
        accountId: row.account_id || normalizedAccountId || null,
        connectionId: row.id
      };
    }

    const safeUserId = assertProductionSafeUserId(normalizedUserId, operation);

    const params = [safeUserId, normalizedBrokerType];
    let query = `
      SELECT
        id,
        "userId" AS user_id,
        "brokerType" AS broker_type,
        "accountId" AS account_id
      FROM "BrokerConnection"
      WHERE "userId" = $1
        AND "brokerType" = $2
        AND "isActive" = true
    `;

    if (normalizedAccountId) {
      query += ` AND "accountId" = $3`;
      params.push(normalizedAccountId);
    }

    query += `
      ORDER BY
        "lastSyncAt" DESC NULLS LAST,
        "updatedAt" DESC
      LIMIT 2
    `;

    const fallbackResult = await db.query(query, params);

    if (fallbackResult.rows.length === 0) {
      throw this._buildError(
        `No active ${normalizedBrokerType} broker connection found for user ${safeUserId}`,
        404,
        'BROKER_CONNECTION_NOT_FOUND'
      );
    }

    if (fallbackResult.rows.length > 1 && this._isProduction()) {
      throw this._buildError(
        `brokerConnectionId is required for ${operation}; multiple ${normalizedBrokerType} connections exist for user ${safeUserId}`,
        409,
        'BROKER_CONNECTION_AMBIGUOUS'
      );
    }

    const resolved = fallbackResult.rows[0];
    return {
      userId: safeUserId,
      brokerType: resolved.broker_type,
      accountId: resolved.account_id || normalizedAccountId || null,
      connectionId: resolved.id
    };
  }

  _isAuthErrorMessage(message) {
    const normalized = String(message || '').toLowerCase();
    return (
      normalized.includes('unauthorized') ||
      normalized.includes('invalid') ||
      normalized.includes('expired') ||
      normalized.includes('token') ||
      normalized.includes('auth')
    );
  }

  async refreshTokenForUser(userIdOrContext, brokerType = 'ZERODHA', accountId = null, connectionId = null) {
    const request = this._normalizeTokenRequest(userIdOrContext, brokerType, accountId, connectionId);
    const resolvedContext = await this._resolveConnectionContext({
      userId: request.userId,
      brokerType: request.brokerType,
      accountId: request.accountId,
      connectionId: request.connectionId,
      operation: 'refresh'
    });
    resolvedContext.correlationId = request.correlationId || null;
    const refreshKey = [
      resolvedContext.brokerType,
      resolvedContext.connectionId,
      resolvedContext.userId
    ].join(':');

    const inFlight = this.inFlightRefreshes.get(refreshKey);
    if (inFlight) {
      logger.warn(`Refresh already in progress for ${refreshKey}; joining existing request`);
      return inFlight;
    }

    const refreshPromise = (async () => {
      let lock = null;
      try {
        lock = await distributedLock.acquire(refreshKey, this.refreshLockTtlMs);
      } catch (lockError) {
        if (lockError?.statusCode === 503) {
          throw lockError;
        }
        const normalizedError = new Error(`Unable to acquire refresh lock: ${lockError.message}`);
        normalizedError.statusCode = 503;
        normalizedError.retryAfterMs = 5000;
        throw normalizedError;
      }

      try {
        return await this._refreshTokenForUserInternal({
          userId: resolvedContext.userId,
          brokerType: resolvedContext.brokerType,
          accountId: resolvedContext.accountId,
          connectionId: resolvedContext.connectionId,
          correlationId: resolvedContext.correlationId
        });
      } finally {
        await distributedLock.release(lock);
      }
    })()
      .finally(() => {
        this.inFlightRefreshes.delete(refreshKey);
      });

    this.inFlightRefreshes.set(refreshKey, refreshPromise);
    return refreshPromise;
  }


  async _refreshTokenForUserInternal(context) {
    const { userId, brokerType = 'ZERODHA', accountId = null, connectionId = null, correlationId = null } = context;

    let manager;
    if (brokerType === 'ZERODHA') {
      manager = this.zerodhaManager;
    } else if (brokerType === 'DHAN') {
      manager = this.dhanManager;
    } else {
      throw new Error(`Auto-refresh for ${brokerType} is not implemented`);
    }

    // Fetch the current token context to pass to the manager
    let currentToken = null;
    try {
      currentToken = await this._getBrokerConnectionToken(userId, brokerType, accountId, connectionId);
    } catch (e) {
      logger.warn(`⚠️ Unable to load existing ${brokerType} token for refresh (connection: ${connectionId || 'n/a'}): ${e.code || 'TOKEN_LOOKUP_FAILED'} ${e.message}`);
    }

    const result = await manager.refresh({ ...context, currentToken });

    if (result.success) {
      // Sync token to stored_tokens table so getCurrentToken() can find it
      try {
        await this.storeTokenData({
          user_id: userId,
          brokerType,
          accountId,
          connectionId,
          access_token: result.access_token,
          refresh_token: result.refresh_token || '',
          expires_at: result.expires_at || result.next_refresh_at,
          mode: 'automated',
          refresh_status: 'success',
          error_reason: null
        });
      } catch (syncError) {
        logger.error(`❌ Failed to sync token to stored_tokens for user ${userId}: ${syncError.message}`);
      }
    } else {
      // Log failure to stored tokens if it exists
      try {
        const storedTokenKey = this._buildStoredTokenKey({ connectionId, userId, brokerType, accountId });
        await db.query(`
            UPDATE stored_tokens 
            SET refresh_status = 'failed', 
                error_reason = $1,
                updated_at = NOW()
            WHERE broker_connection_id = $2
          `, [String(result.error || 'Token refresh failed').substring(0, 500), storedTokenKey]);
      } catch (e) { }

      const failureMessage = String(result.error || 'Token refresh failed');
      const failureCode = String(result.error_code || 'TOKEN_REFRESH_FAILED');
      const failureStatusCode = Number(result.statusCode || 0) || (failureCode === 'DHAN_CREDENTIALS_MISSING' ? 422 : 500);

      await this._markBrokerConnectionError(connectionId, userId, failureMessage, correlationId);

      const refreshError = this._buildError(failureMessage, failureStatusCode, failureCode);
      if (result.guidance) {
        refreshError.guidance = result.guidance;
      }
      throw refreshError;
    }

    return result;
  }

  async _markBrokerConnectionError(connectionId, userId, message, correlationId = null) {
    if (!connectionId) {
      return;
    }

    const safeMessage = String(message || 'Unknown token refresh error').substring(0, 500);
    const correlationSuffix = correlationId ? ` [ref: ${correlationId}]` : '';
    const persistedMessage = `${safeMessage}${correlationSuffix}`.substring(0, 500);
    const nextStatus = this._isAuthErrorMessage(message) ? 'REAUTH_REQUIRED' : 'ERROR';

    try {
      await db.query(`
        UPDATE "BrokerConnection"
        SET "lastError" = $1,
            "status" = $2,
            "updatedAt" = NOW()
        WHERE id = $3
          AND "userId" = $4
      `, [persistedMessage, nextStatus, connectionId, userId]);
    } catch (updateError) {
      logger.warn(`⚠️ Failed to persist BrokerConnection refresh error for ${connectionId}: ${updateError.message}`);
    }
  }

  async storeToken(userId, tokenData) {
    logger.info(`💾 Storing token for user: ${userId}`);

    let client;
    try {
      client = await db.getClient();
      await client.query('BEGIN');

      // Invalidate old tokens
      await client.query(
        `UPDATE kite_tokens SET is_valid = false WHERE user_id = $1`,
        [userId]
      );

      // Insert new token
      await client.query(`
        INSERT INTO kite_tokens (user_id, access_token, public_token, login_time, expires_at, generation_method, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'automated', NOW())
      `, [
        userId,
        tokenData.access_token,
        tokenData.public_token,
        tokenData.login_time,
        tokenData.expires_at
      ]);

      // Update last_used timestamp
      await client.query(
        `UPDATE kite_user_credentials SET last_used = NOW() WHERE user_id = $1`,
        [userId]
      );

      await client.query('COMMIT');
      logger.info(`✅ Token stored successfully for user: ${userId}`);
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error(`❌ Error rolling back transaction: ${rollbackError.message}`);
        }
      }
      logger.error(`❌ Error storing token for user ${userId}: ${error.message}`);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async logAttempt(userId, attemptNumber, status, errorMessage, executionTime) {
    try {
      await db.query(`
        INSERT INTO token_generation_logs (user_id, attempt_number, status, error_message, execution_time_ms)
        VALUES ($1, $2, $3, $4, $5)
      `, [userId, attemptNumber, status, errorMessage, executionTime]);
    } catch (error) {
      logger.error(`Failed to log attempt: ${error.message}`);
    }
  }

  async getValidToken(userId) {
    const result = await db.query(`
      SELECT * FROM kite_tokens 
      WHERE user_id = $1 
        AND is_valid = true 
        AND expires_at > NOW()
      ORDER BY created_at DESC 
      LIMIT 1
    `, [userId]);

    return result.rows[0] || null;
  }

  async getCredentialStatus(userId) {
    const result = await db.query(`
      SELECT 
        kite_user_id,
        is_active,
        auto_refresh_enabled,
        last_used,
        created_at,
        updated_at
      FROM kite_user_credentials
      WHERE user_id = $1
    `, [userId]);

    return result.rows[0] || null;
  }

  async getTokenLogs(userId, limit = 10) {
    const result = await db.query(`
      SELECT 
        attempt_number,
        status,
        error_message,
        execution_time_ms,
        created_at
      FROM token_generation_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);

    return result.rows;
  }

  /**
   * Store token data for a user
   * @param {Object} tokenData - Token data to store
   * @returns {Object} Stored token data
   */
  async storeTokenData(tokenData) {
    const {
      user_id,
      brokerType,
      accountId,
      connectionId,
      brokerConnectionId,
      access_token,
      refresh_token,
      expires_at,
      mode,
      refresh_status,
      error_reason
    } = tokenData;
    const normalizedBrokerType = this._normalizeBrokerType(brokerType || 'ZERODHA');
    const normalizedConnectionId = this._normalizeConnectionId(connectionId || brokerConnectionId);
    const storedTokenKey = this._buildStoredTokenKey({
      connectionId: normalizedConnectionId,
      userId: user_id,
      brokerType: normalizedBrokerType,
      accountId
    });

    // Source of truth for live broker sessions is BrokerConnection.
    const shouldPersistBrokerConnection = Boolean(
      normalizedConnectionId || accountId || (normalizedBrokerType && normalizedBrokerType !== 'ZERODHA')
    );

    if (this._isProduction() && !normalizedConnectionId) {
      throw this._buildError(
        `brokerConnectionId is required to store ${normalizedBrokerType} token data in production`,
        400,
        'BROKER_CONNECTION_REQUIRED'
      );
    }

    if (shouldPersistBrokerConnection) {
      const brokerResult = await this.storeBrokerConnectionToken({
        ...tokenData,
        brokerType: normalizedBrokerType,
        connectionId: normalizedConnectionId
      });
      if (normalizedBrokerType !== 'ZERODHA') {
        return brokerResult;
      }
    }

    logger.info(`💾 Storing token data for user: ${user_id}`);

    try {
      // Insert or update token data with refresh tracking
      const result = await db.query(`
        INSERT INTO stored_tokens (
          user_id, broker_connection_id, access_token, refresh_token, expires_at, mode, 
          last_refresh_at, refresh_status, error_reason, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, NOW(), NOW())
        ON CONFLICT (broker_connection_id) 
        DO UPDATE SET 
          user_id = EXCLUDED.user_id,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          mode = EXCLUDED.mode,
          last_refresh_at = NOW(),
          refresh_status = COALESCE(EXCLUDED.refresh_status, 'success'),
          error_reason = NULL,
          updated_at = NOW()
        RETURNING *
      `, [
        user_id,
        storedTokenKey,
        access_token,
        refresh_token || '',
        expires_at,
        mode || 'automated',
        refresh_status || 'success',
        error_reason || null
      ]);

      logger.info(`✅ Token data stored successfully for user: ${user_id} (key: ${storedTokenKey}, status: ${refresh_status || 'success'})`);
      return result.rows[0];

    } catch (error) {
      // Check if error is due to missing table
      if (error.message.includes('relation "stored_tokens" does not exist')) {
        logger.error(`❌ CRITICAL: stored_tokens table does not exist! This indicates migration failure.`);
        throw new Error('Database schema incomplete: stored_tokens table missing. Service must restart to run migrations.');
      }
      logger.error(`❌ Error storing token data for user ${user_id}:`, error);
      throw error;
    }
  }


  /**
   * Get current token for a user
   * @param {string} userId - User ID
   * @param {string} brokerType - Broker Type (ZERODHA, DHAN)
   * @param {string} accountId - Optional specific account ID
   * @returns {Object|null} Current token data or null if not found
   */
  async getCurrentToken(userIdOrContext, brokerType = 'ZERODHA', accountId = null, connectionId = null) {
    const request = this._normalizeTokenRequest(userIdOrContext, brokerType, accountId, connectionId);
    const resolvedContext = await this._resolveConnectionContext({
      userId: request.userId,
      brokerType: request.brokerType,
      accountId: request.accountId,
      connectionId: request.connectionId,
      operation: 'lookup'
    });
    const brokerToken = await this._getBrokerConnectionToken(
      resolvedContext.userId,
      resolvedContext.brokerType,
      resolvedContext.accountId,
      resolvedContext.connectionId
    );

    if (brokerToken?.access_token) {
      return brokerToken;
    }

    const allowLegacyFallback =
      this.allowLegacyStoredTokenFallback &&
      resolvedContext.brokerType === 'ZERODHA' &&
      !request.connectionId;

    if (allowLegacyFallback) {
      logger.warn(`⚠️ LEGACY stored_tokens fallback enabled for user ${resolvedContext.userId}. This path should be disabled in production.`);
      return this._getLegacyZerodhaToken(resolvedContext.userId);
    }

    if (!this.allowLegacyStoredTokenFallback && resolvedContext.brokerType === 'ZERODHA' && !request.connectionId) {
      logger.warn(`⚠️ Legacy stored_tokens fallback is disabled. Token lookup requires BrokerConnection data (user: ${resolvedContext.userId}).`);
    }

    return null;
  }

  async _getLegacyZerodhaToken(userId) {
    if (!this.allowLegacyStoredTokenFallback) {
      logger.warn(`⚠️ Legacy stored_tokens lookup requested while LEGACY_ALLOW_STORED_TOKENS=false (user: ${userId})`);
      return null;
    }

    logger.info(`🔍 Getting current token for user: ${userId} (Legacy Zerodha)`);

    try {
      const result = await db.query(`
        SELECT 
          user_id,
          broker_connection_id,
          access_token,
          refresh_token,
          expires_at,
          mode,
          last_refresh_at,
          refresh_status,
          error_reason,
          created_at,
          updated_at
        FROM stored_tokens
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `, [userId]);

      if (result.rows.length === 0) {
        logger.info(`ℹ️ No token found in stored_tokens for user: ${userId}, checking kite_tokens as fallback`);

        // FALLBACK: Check if token exists in kite_tokens and sync it to stored_tokens
        const kiteTokensResult = await db.query(`
          SELECT access_token, expires_at, is_valid, created_at
          FROM kite_tokens
          WHERE user_id = $1 AND is_valid = true AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId]);

        // If found in kite_tokens, sync to stored_tokens and return it
        if (kiteTokensResult.rows.length > 0 && kiteTokensResult.rows[0].is_valid) {
          const kiteToken = kiteTokensResult.rows[0];
          try {
            await this.storeTokenData({
              user_id: userId,
              access_token: kiteToken.access_token,
              refresh_token: '',
              expires_at: kiteToken.expires_at,
              mode: 'migrated',
              refresh_status: 'success'
            });
            logger.info(`✅ Migrated token from kite_tokens to stored_tokens for user: ${userId}`);

            // Return the migrated token
            return {
              user_id: userId,
              access_token: kiteToken.access_token,
              refresh_token: '',
              expires_at: kiteToken.expires_at,
              mode: 'migrated',
              created_at: kiteToken.created_at,
              updated_at: new Date()
            };
          } catch (migrateError) {
            logger.error(`❌ Failed to migrate token from kite_tokens: ${migrateError.message}`);
          }
        }

        return null;
      }

      const token = result.rows[0];
      if (String(token.broker_connection_id || '').startsWith('legacy:')) {
        logger.warn(`⚠️ Encountered legacy stored_tokens key for user ${userId}: ${token.broker_connection_id}`);
      }

      // Check if token is expired or expiring soon
      const expiresAt = new Date(token.expires_at);
      const now = new Date();
      const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

      if (hoursUntilExpiry < 0) {
        logger.warn(`⚠️ Token for user ${userId} is expired (${hoursUntilExpiry.toFixed(1)} hours ago)`);
      } else if (hoursUntilExpiry < 2) {
        logger.warn(`⚠️ Token for user ${userId} expires soon (${hoursUntilExpiry.toFixed(1)} hours)`);
      }

      logger.info(`✅ Current token found for user: ${userId} (expires in ${hoursUntilExpiry.toFixed(1)} hours)`);
      return token;

    } catch (error) {
      // Check if error is due to missing table
      if (error.message.includes('relation "stored_tokens" does not exist')) {
        logger.error(`❌ CRITICAL: stored_tokens table does not exist! This indicates migration failure.`);
        throw new Error('Database schema incomplete: stored_tokens table missing. Service must restart to run migrations.');
      }
      logger.error(`❌ Error getting current token for user ${userId}:`, error);
      throw error;
    }
  }

  async _getBrokerConnectionToken(userId, brokerType, accountId = null, connectionId = null) {
    logger.info(`🔍 Getting current token for user: ${userId} (${brokerType})`);

    try {
      const normalizedConnectionId = this._normalizeConnectionId(connectionId);
      let query = `
        SELECT
          id,
          "accountId" as account_id,
          "accessTokenEncrypted",
          "refreshToken",
          "expiresAt" as expires_at,
          "lastAuthAt" as last_auth_at,
          "lastError" as last_error,
          "status",
          "updatedAt" as updated_at
        FROM "BrokerConnection"
      `;
      let params = [];

      if (normalizedConnectionId) {
        query += ` WHERE id = $1 AND "userId" = $2`;
        params = [normalizedConnectionId, userId];
      } else {
        if (this._isProduction()) {
          throw this._buildError(
            `brokerConnectionId is required for ${brokerType} token lookup in production`,
            400,
            'BROKER_CONNECTION_REQUIRED'
          );
        }

        query += ` WHERE "userId" = $1 AND "brokerType" = $2 AND "isActive" = true`;
        params = [userId, brokerType];

        if (accountId) {
          query += ` AND "accountId" = $3`;
          params.push(accountId);
        }
      }

      query += ` ORDER BY "updatedAt" DESC LIMIT 1`;

      const result = await db.query(query, params);

      if (result.rows.length === 0) {
        logger.warn(`ℹ️ No active ${brokerType} connection found for user: ${userId}`);
        return null;
      }

      const row = result.rows[0];

      // Decrypt access token
      let accessToken = null;
      if (row.accessTokenEncrypted) {
        try {
          accessToken = encryptor.decrypt(row.accessTokenEncrypted);
        } catch (decErr) {
          const decryptError = this._buildError(
            `TOKEN_DECRYPT_FAILED_FORMAT for brokerConnectionId ${row.id}: ${decErr.message}`,
            500,
            'TOKEN_DECRYPT_FAILED_FORMAT'
          );
          decryptError.brokerConnectionId = row.id;
          throw decryptError;
        }

        if (!accessToken) {
          const decryptError = this._buildError(
            `TOKEN_DECRYPT_FAILED_FORMAT for brokerConnectionId ${row.id}: decrypted token is empty`,
            500,
            'TOKEN_DECRYPT_FAILED_FORMAT'
          );
          decryptError.brokerConnectionId = row.id;
          throw decryptError;
        }
      }

      return {
        broker_connection_id: row.id,
        account_id: row.account_id,
        access_token: accessToken,
        refresh_token: row.refreshToken,
        expires_at: row.expires_at,
        status: row.status,
        last_error: row.last_error,
        last_auth_at: row.last_auth_at,
        updated_at: row.updated_at
      };

    } catch (error) {
      if (error.code === 'TOKEN_DECRYPT_FAILED_FORMAT') {
        const corruptedConnectionId = this._normalizeConnectionId(error.brokerConnectionId || connectionId);
        if (corruptedConnectionId) {
          try {
            await db.query(`
              UPDATE "BrokerConnection"
              SET
                "accessTokenEncrypted" = NULL,
                "lastError" = $2,
                "updatedAt" = NOW()
              WHERE id = $1
            `, [
              corruptedConnectionId,
              String(error.message || 'Encrypted token could not be decrypted').substring(0, 450)
            ]);
          } catch (updateError) {
            logger.warn(`⚠️ Failed to clear corrupted token payload for ${corruptedConnectionId}: ${updateError.message}`);
          }
        }

        logger.warn(`⚠️ ${brokerType} token decrypt failed for connection ${corruptedConnectionId || connectionId || 'unknown'}; proceeding with fresh refresh flow`);
        return null;
      }

      logger.error(`❌ Error getting ${brokerType} token:`, error);
      // Fallback: If BrokerConnection table missing (not migrated yet?), fail gracefully
      if (error.message.includes('does not exist')) {
        logger.error(`❌ BrokerConnection table not found. Migration pending?`);
        return null;
      }
      throw error;
    }
  }

  async storeBrokerConnectionToken(tokenData) {
    const { user_id, brokerType = 'ZERODHA', accountId, connectionId, access_token, refresh_token, expires_at } = tokenData;
    const normalizedConnectionId = this._normalizeConnectionId(connectionId);

    logger.info(`💾 Storing ${brokerType} token for user: ${user_id}${normalizedConnectionId ? ` (connection ${normalizedConnectionId})` : ''}`);

    if (this._isProduction() && !normalizedConnectionId) {
      throw this._buildError(
        `brokerConnectionId is required to persist ${brokerType} tokens in production`,
        400,
        'BROKER_CONNECTION_REQUIRED'
      );
    }

    try {
      // Encrypt access token using canonical GCM format (compatible with Core/Web).
      const accessTokenEncrypted = encryptor.encrypt(access_token);

      let query = `
        UPDATE "BrokerConnection"
        SET 
          "accessTokenEncrypted" = $1,
          "refreshToken" = $2,
          "expiresAt" = $3,
          "lastAuthAt" = NOW(),
          "updatedAt" = NOW(),
          "status" = 'CONNECTED',
          "lastError" = NULL,
          "isActive" = true
      `;
      let params = [accessTokenEncrypted, refresh_token || null, expires_at || null];

      if (normalizedConnectionId) {
        query += ` WHERE id = $4 AND "userId" = $5`;
        params.push(normalizedConnectionId, user_id);
      } else {
        query += ` WHERE "userId" = $4 AND "brokerType" = $5`;
        params.push(user_id, brokerType);

        if (accountId) {
          query += ` AND "accountId" = $6`;
          params.push(accountId);
        }
      }

      query += ` RETURNING *`;

      const result = await db.query(query, params);

      if (result.rows.length === 0) {
        // Option: Insert if missing? 
        // For Generic provider, we might want to auto-create?
        // But for now, let's just log warning and return generic obj
        logger.warn(`⚠️ No BrokerConnection found to update for ${brokerType}:${user_id}`);
        return { status: 'failed', reason: 'Connection not found' };
      }

      logger.info(`✅ ${brokerType} token stored successfully`);
      return result.rows[0];

    } catch (error) {
      logger.error(`❌ Error storing ${brokerType} token:`, error);
      throw error;
    }
  }
}

module.exports = new TokenManager();
