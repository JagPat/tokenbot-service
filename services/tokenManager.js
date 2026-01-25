const db = require('../config/database');
const tokenFetcher = require('./tokenFetcher');
const encryptor = require('./encryptor');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');

class TokenManager {
  async refreshTokenForUser(userId) {
    let attemptNumber = 0;
    const maxAttempts = 3;

    try {
      logger.info(`🔄 Starting token refresh for user: ${userId}`);

      // Get encrypted credentials
      const credsResult = await db.query(
        `SELECT * FROM kite_user_credentials WHERE user_id = $1 AND is_active = true`,
        [userId]
      );

      if (credsResult.rows.length === 0) {
        throw new Error(`No active credentials found for user ${userId}. Please configure full credentials via POST /api/credentials`);
      }

      const creds = credsResult.rows[0];
      
      // Check if credentials are just placeholders (not fully set up)
      if (creds.kite_user_id === 'pending' || creds.kite_user_id === 'pending_setup') {
        throw new Error(`Credentials for user ${userId} are incomplete. API key is set, but full credentials (kite_user_id, password, totp_secret) are required for token generation. Please create full credentials via POST /api/credentials with all required fields.`);
      }
      
      // Also check if password/totp are placeholders
      try {
        const decryptedPassword = encryptor.decrypt(creds.encrypted_password);
        if (decryptedPassword === 'pending' || decryptedPassword === 'pending_setup') {
          throw new Error(`Credentials for user ${userId} are incomplete. Full credentials (kite_user_id, password, totp_secret) are required. Please use POST /api/credentials to set them up.`);
        }
      } catch (decryptError) {
        // If decryption fails, credentials might be corrupted - treat as incomplete
        throw new Error(`Credentials for user ${userId} appear to be incomplete or corrupted. Please recreate full credentials via POST /api/credentials`);
      }
      
      logger.info(`✅ Credentials found for user: ${userId}`);

      // Decrypt credentials
      const decryptedCreds = {
        kite_user_id: creds.kite_user_id,
        password: encryptor.decrypt(creds.encrypted_password),
        totp_secret: encryptor.decrypt(creds.encrypted_totp_secret),
        api_key: encryptor.decrypt(creds.encrypted_api_key),
        api_secret: encryptor.decrypt(creds.encrypted_api_secret)
      };

      logger.info(`🔓 Credentials decrypted successfully`);

      // Retry logic with exponential backoff
      const tokenData = await retryWithBackoff(
        async () => {
          attemptNumber++;
          logger.info(`📝 Token generation attempt ${attemptNumber}/${maxAttempts} for user ${userId}`);
          return await tokenFetcher.fetchAccessToken(decryptedCreds);
        },
        maxAttempts,
        (error, attempt) => {
          logger.warn(`⚠️ Attempt ${attempt} failed for user ${userId}: ${error.message}`);
        }
      );

      // Store token in kite_tokens table
      await this.storeToken(userId, tokenData);

      // Sync token to stored_tokens table so getCurrentToken() can find it
      try {
        await this.storeTokenData({
          user_id: userId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || '',
          expires_at: tokenData.expires_at,
          mode: 'automated',
          refresh_status: 'success',
          error_reason: null
        });
        logger.info(`✅ Token synced to stored_tokens for user: ${userId}`);
      } catch (syncError) {
        // If table is missing, this is critical - fail the refresh
        if (syncError.message.includes('stored_tokens table missing') || 
            syncError.message.includes('relation "stored_tokens" does not exist')) {
          logger.error(`❌ CRITICAL: Cannot store token - schema incomplete. Failing refresh.`);
          throw syncError;
        }
        // Log but don't fail - kite_tokens storage succeeded
        logger.error(`❌ Failed to sync token to stored_tokens for user ${userId}: ${syncError.message}`);
      }

      // Log success
      await this.logAttempt(userId, attemptNumber, 'success', null, tokenData.execution_time_ms);

      logger.info(`✅ Token generated successfully for user ${userId}`);
      return tokenData;

    } catch (error) {
      // Log failure
      await this.logAttempt(userId, attemptNumber || maxAttempts, 'failed', error.message, null);

      // Update stored_tokens with failure status if it exists
      try {
        await db.query(`
          UPDATE stored_tokens 
          SET refresh_status = 'failed', 
              error_reason = $1,
              updated_at = NOW()
          WHERE user_id = $2
        `, [error.message.substring(0, 500), userId]);
      } catch (updateError) {
        // Ignore if table doesn't exist - will be caught by migration check
        if (!updateError.message.includes('relation "stored_tokens" does not exist')) {
          logger.warn(`⚠️ Could not update refresh status: ${updateError.message}`);
        }
      }

      logger.error(`❌ Token generation failed for user ${userId}: ${error.message}`);
      throw error;
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
    const { user_id, access_token, refresh_token, expires_at, mode, refresh_status, error_reason } = tokenData;

    logger.info(`💾 Storing token data for user: ${user_id}`);

    try {
      // Insert or update token data with refresh tracking
      const result = await db.query(`
        INSERT INTO stored_tokens (
          user_id, access_token, refresh_token, expires_at, mode, 
          last_refresh_at, refresh_status, error_reason, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, NOW(), NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET 
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
        access_token, 
        refresh_token || '', 
        expires_at, 
        mode || 'automated',
        refresh_status || 'success',
        error_reason || null
      ]);

      logger.info(`✅ Token data stored successfully for user: ${user_id} (status: ${refresh_status || 'success'})`);
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
   * @returns {Object|null} Current token data or null if not found
   */
  async getCurrentToken(userId) {
    logger.info(`🔍 Getting current token for user: ${userId}`);

    try {
      const result = await db.query(`
        SELECT 
          user_id,
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
}

module.exports = new TokenManager();
