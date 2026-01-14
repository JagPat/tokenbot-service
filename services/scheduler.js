const cron = require('node-cron');
const db = require('../config/database');
const tokenManager = require('./tokenManager');
const logger = require('../utils/logger');

class Scheduler {
  constructor() {
    this.isRunning = false;
  }

  start() {
    // Run daily at 8:30 AM IST
    // Cron format: minute hour day month dayOfWeek
    const cronExpression = '30 8 * * *';

    cron.schedule(cronExpression, async () => {
      logger.info('⏰ [Scheduler] Triggered via Cron (8:30 AM IST)');
      await this.refreshAllTokens();
    }, {
      timezone: 'Asia/Kolkata'
    });

    logger.info('✅ [Scheduler] Daily token refresh scheduled for 8:30 AM IST');
    logger.info(`📅 [Scheduler] Next run: ${this.getNextRunTime()}`);

    // Startup Check: If it's between 8:30 AM and 3:30 PM, and we don't have a valid token
    // trigger a refresh. This handles the "server down during 8:30 AM" case.
    this._runStartupCheck();
  }

  async _runStartupCheck() {
    try {
      // Get current time in IST
      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const hours = istTime.getHours();
      const minutes = istTime.getMinutes();

      // Market hours check (approx 8:30 AM to 3:30 PM)
      const isMarketHours = (hours > 8 || (hours === 8 && minutes >= 30)) && hours < 16;

      if (isMarketHours) {
        logger.info('🔍 [Scheduler] Service started during market hours. Checking for valid token...');

        // Check for default user
        const needsRefresh = await this._checkIfTokenNeeded('default');

        if (needsRefresh) {
          logger.warn('⚠️ [Scheduler] No valid token found during market hours! Triggering immediate refresh.');
          await this.refreshAllTokens();
        } else {
          logger.info('✅ [Scheduler] Valid token exists. No immediate refresh needed.');
        }
      }
    } catch (error) {
      logger.error(`❌ [Scheduler] Startup check failed: ${error.message}`);
    }
  }

  async _checkIfTokenNeeded(userId) {
    try {
      const token = await tokenManager.getValidToken(userId);
      // specific logic: if no token OR token expires in < 1 hour
      if (!token) return true;

      const expiresAt = new Date(token.expires_at);
      const now = new Date();
      const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

      return hoursUntilExpiry < 1;
    } catch (e) {
      return true; // fail safe: try to refresh
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

      const users = result.rows;
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

