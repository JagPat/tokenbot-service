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

    // Startup Check: If it's between 8:30 AM and 3:30 PM, and we just started, 
    // we might want to ensure we have a token.
    // However, forcing it on every restart can be risky (OTP spam).
    // Better to just rely on Cron or manual trigger.
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
        try {
          logger.info(`🔄 Processing user: ${user.user_id} (${user.kite_user_id})`);
          await tokenManager.refreshTokenForUser(user.user_id);
          results.success.push(user.user_id);
          logger.info(`✅ Success: ${user.user_id}`);
        } catch (error) {
          results.failed.push({
            user_id: user.user_id,
            kite_user_id: user.kite_user_id,
            error: error.message
          });
          logger.error(`❌ Failed: ${user.user_id} - ${error.message}`);
        }

        // Small delay between users to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
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

