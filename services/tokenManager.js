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
        throw new Error(`No active credentials found for user ${userId}`);
      }
      
      const creds = credsResult.rows[0];
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
      
      // Store token
      await this.storeToken(userId, tokenData);
      
      // Log success
      await this.logAttempt(userId, attemptNumber, 'success', null, tokenData.execution_time_ms);
      
      logger.info(`✅ Token generated successfully for user ${userId}`);
      return tokenData;
      
    } catch (error) {
      // Log failure
      await this.logAttempt(userId, attemptNumber || maxAttempts, 'failed', error.message, null);
      
      logger.error(`❌ Token generation failed for user ${userId}: ${error.message}`);
      throw error;
    }
  }
  
  async storeToken(userId, tokenData) {
    logger.info(`💾 Storing token for user: ${userId}`);
    
    // Invalidate old tokens
    await db.query(
      `UPDATE kite_tokens SET is_valid = false WHERE user_id = $1`,
      [userId]
    );
    
    // Insert new token
    await db.query(`
      INSERT INTO kite_tokens (user_id, access_token, public_token, login_time, expires_at, generation_method)
      VALUES ($1, $2, $3, $4, $5, 'automated')
    `, [
      userId,
      tokenData.access_token,
      tokenData.public_token,
      tokenData.login_time,
      tokenData.expires_at
    ]);
    
    // Update last_used timestamp
    await db.query(
      `UPDATE kite_user_credentials SET last_used = NOW() WHERE user_id = $1`,
      [userId]
    );
    
    logger.info(`✅ Token stored successfully for user: ${userId}`);
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
    const { user_id, access_token, refresh_token, expires_at, mode } = tokenData;
    
    logger.info(`💾 Storing token data for user: ${user_id}`);
    
    try {
      // Insert or update token data
      const result = await db.query(`
        INSERT INTO stored_tokens (user_id, access_token, refresh_token, expires_at, mode, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          mode = EXCLUDED.mode,
          updated_at = NOW()
        RETURNING *
      `, [user_id, access_token, refresh_token, expires_at, mode]);
      
      logger.info(`✅ Token data stored successfully for user: ${user_id}`);
      return result.rows[0];
      
    } catch (error) {
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
          created_at,
          updated_at
        FROM stored_tokens
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `, [userId]);
      
      if (result.rows.length === 0) {
        logger.info(`ℹ️ No token found for user: ${userId}`);
        return null;
      }
      
      logger.info(`✅ Current token found for user: ${userId}`);
      return result.rows[0];
      
    } catch (error) {
      logger.error(`❌ Error getting current token for user ${userId}:`, error);
      throw error;
    }
  }
}

module.exports = new TokenManager();

