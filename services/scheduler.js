const cron = require('node-cron');
const db = require('../config/database');
const tokenManager = require('./tokenManager');
const logger = require('../utils/logger');
const { isDefaultUserId } = require('../utils/userIdPolicy');

class Scheduler {
  constructor() {
    this.isRunning = false;
  }

  _filterSchedulableUsers(rows = []) {
    if (process.env.NODE_ENV !== 'production') {
      return rows;
    }

    const filtered = rows.filter((row) => !isDefaultUserId(row.user_id));
    const skipped = rows.length - filtered.length;
    if (skipped > 0) {
      logger.warn(`⚠️ [Scheduler] Skipping ${skipped} default-user records in production`);
    }
    return filtered;
  }

  start() {
    // Run daily at 8:30 AM IST (primary refresh)
    // Cron format: minute hour day month dayOfWeek
    const cronExpression = '30 8 * * *';

    cron.schedule(cronExpression, async () => {
      logger.info('⏰ [Scheduler] Triggered via Cron (8:30 AM IST)');
      await this.refreshAllTokens();
    }, {
      timezone: 'Asia/Kolkata'
    });

    // PROACTIVE REFRESH: Check every 2 hours for tokens expiring soon
    // This ensures tokens are refreshed before expiry, not after
    const proactiveCronExpression = '0 */2 * * *'; // Every 2 hours

    cron.schedule(proactiveCronExpression, async () => {
      logger.info('⏰ [Scheduler] Proactive refresh check (every 2 hours)');
      await this.refreshExpiringTokens();
    }, {
      timezone: 'Asia/Kolkata'
    });

    logger.info('✅ [Scheduler] Daily token refresh scheduled for 8:30 AM IST');
    logger.info('✅ [Scheduler] Proactive refresh check scheduled every 2 hours');
    logger.info(`📅 [Scheduler] Next run: ${this.getNextRunTime()}`);

    // Startup Check: If it's between 8:30 AM and 3:30 PM, and we don't have a valid token
    // trigger a refresh. This handles the "server down during 8:30 AM" case.
    this._runStartupCheck();
  }

  async _runStartupCheck() {
    try {
      logger.info('🔍 [Scheduler] Running startup token check...');

      // Get all active users
      const usersResult = await db.query(`
        SELECT user_id, kite_user_id 
        FROM kite_user_credentials 
        WHERE is_active = true AND auto_refresh_enabled = true
      `);

      const schedulableUsers = this._filterSchedulableUsers(usersResult.rows);

      if (schedulableUsers.length === 0) {
        logger.info('ℹ️ [Scheduler] No active users found for startup check');
        return;
      }

      logger.info(`🔍 [Scheduler] Checking tokens for ${schedulableUsers.length} active users...`);

      let needsRefreshCount = 0;
      for (const user of schedulableUsers) {
        const needsRefresh = await this._checkIfTokenNeeded(user.user_id);
        if (needsRefresh) {
          needsRefreshCount++;
          logger.warn(`⚠️ [Scheduler] User ${user.user_id} needs token refresh`);
        }
      }

      if (needsRefreshCount > 0) {
        logger.warn(`⚠️ [Scheduler] ${needsRefreshCount} users need token refresh. Triggering refresh...`);
        // Run refresh in background (non-blocking)
        this.refreshAllTokens().catch(err => {
          logger.error(`❌ [Scheduler] Startup refresh failed: ${err.message}`);
        });
      } else {
        logger.info('✅ [Scheduler] All users have valid tokens. No startup refresh needed.');
      }
    } catch (error) {
      logger.error(`❌ [Scheduler] Startup check failed: ${error.message}`);
      // Don't throw - startup check failure shouldn't prevent service from starting
    }
  }

  async _checkIfTokenNeeded(userId) {
    try {
      const token = await tokenManager.getValidToken(userId);
      // specific logic: if no token OR token expires in < 2 hours (proactive buffer)
      if (!token) return true;

      const expiresAt = new Date(token.expires_at);
      const now = new Date();
      const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

      // Refresh if expires in less than 2 hours (proactive buffer)
      return hoursUntilExpiry < 2;
    } catch (e) {
      return true; // fail safe: try to refresh
    }
  }

  /**
   * Proactive refresh: Check for tokens expiring soon and refresh them
   * This runs every 2 hours to catch tokens before they expire
   */
  async refreshExpiringTokens() {
    if (this.isRunning) {
      logger.warn('⚠️ Token refresh already in progress, skipping proactive check');
      return;
    }

    try {
      // Get all users with tokens expiring in next 3 hours
      const result = await db.query(`
        SELECT DISTINCT st.user_id, st.expires_at, kuc.kite_user_id
        FROM stored_tokens st
        INNER JOIN kite_user_credentials kuc ON st.user_id = kuc.user_id
        WHERE kuc.is_active = true 
          AND kuc.auto_refresh_enabled = true
          AND st.expires_at > NOW()
          AND st.expires_at < NOW() + INTERVAL '3 hours'
          AND (st.refresh_status IS NULL OR st.refresh_status != 'refreshing')
        ORDER BY st.expires_at ASC
      `);

      const expiringUsers = this._filterSchedulableUsers(result.rows);
      if (expiringUsers.length === 0) {
        logger.info('✅ [Scheduler] No tokens expiring soon (next 3 hours)');
        return;
      }

      logger.info(`🔄 [Scheduler] Found ${expiringUsers.length} tokens expiring soon, refreshing...`);

      for (const row of expiringUsers) {
        const expiresAt = new Date(row.expires_at);
        const now = new Date();
        const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

        if (hoursUntilExpiry < 2) {
          logger.info(`⏰ [Scheduler] Token for ${row.user_id} expires in ${hoursUntilExpiry.toFixed(1)} hours, refreshing...`);
          try {
            // Mark as refreshing to prevent duplicate refreshes
            await db.query(`
              UPDATE stored_tokens 
              SET refresh_status = 'refreshing', updated_at = NOW()
              WHERE user_id = $1
            `, [row.user_id]);

            await tokenManager.refreshTokenForUser(row.user_id);
            logger.info(`✅ [Scheduler] Proactively refreshed token for ${row.user_id}`);
            
            // Small delay between users
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            logger.error(`❌ [Scheduler] Failed to proactively refresh token for ${row.user_id}: ${error.message}`);
            // Reset status on failure
            await db.query(`
              UPDATE stored_tokens 
              SET refresh_status = 'failed', 
                  error_reason = $1,
                  updated_at = NOW()
              WHERE user_id = $2
            `, [error.message.substring(0, 500), row.user_id]);
          }
        }
      }
    } catch (error) {
      logger.error(`❌ [Scheduler] Error in proactive refresh: ${error.message}`);
    }
  }

  getNextRunTime() {
    const now = new Date();
    const next = new Date(now);

    // Set to 8:00 AM IST today
    next.setHours(8, 0, 0, 0);

    // If already past 8 AM today, set to tomorrow
    if (now.getHours() >= 8) {
      next.setDate(next.getDate() + 1);
    }

    return next.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium'
    });
  }

  async refreshAllTokens() {
    if (this.isRunning) {
      logger.warn('⚠️ Token refresh already in progress');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const result = await db.query(`
        SELECT user_id, kite_user_id FROM kite_user_credentials 
        WHERE is_active = true AND auto_refresh_enabled = true
      `);

      const users = this._filterSchedulableUsers(result.rows);
      logger.info(`📋 [Scheduler] Found ${users.length} users for token refresh`);

      if (users.length === 0) {
        logger.info('ℹ️ No users to refresh');
        return { success: [], failed: [] };
      }

      const results = {
        success: [],
        failed: []
      };

      for (const user of users) {
        const maxRetries = 3;
        let attempt = 0;
        let success = false;

        while (attempt < maxRetries && !success) {
          attempt++;
          try {
            logger.info(`🔄 Processing user: ${user.user_id} (${user.kite_user_id}) [attempt ${attempt}/${maxRetries}]`);
            await tokenManager.refreshTokenForUser(user.user_id);
            results.success.push(user.user_id);
            logger.info(`✅ Success: ${user.user_id}`);
            success = true;
          } catch (error) {
            if (error.message.includes('Browser pool exhausted') && attempt < maxRetries) {
              logger.warn(`⏳ Pool exhausted for ${user.user_id}, waiting 30s before retry (attempt ${attempt}/${maxRetries})...`);
              await new Promise(resolve => setTimeout(resolve, 30000));
            } else {
              results.failed.push({
                user_id: user.user_id,
                kite_user_id: user.kite_user_id,
                error: error.message
              });
              logger.error(`❌ Failed: ${user.user_id} - ${error.message}`);
              break;
            }
          }
        }

        // Delay between users to avoid rate limiting (only if successful)
        if (success) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }

      const duration = Date.now() - startTime;
      logger.info(`✅ Token refresh complete in ${duration}ms: ${results.success.length} success, ${results.failed.length} failed`);

      // Log summary
      if (results.failed.length > 0) {
        logger.warn('⚠️ Failed users:', results.failed);
      }

      return results;
    } catch (error) {
      logger.error(`❌ [Scheduler] Error in refreshAllTokens: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Manual trigger for testing/debugging
   */
  async triggerNow() {
    logger.info('🔄 [Scheduler] Manual trigger initiated');
    return await this.refreshAllTokens();
  }
}

module.exports = new Scheduler();
