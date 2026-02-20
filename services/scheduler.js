const cron = require('node-cron');
const { randomUUID } = require('crypto');
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

  _isAuthError(error) {
    const message = String(error?.message || '').toLowerCase();
    const statusCode = Number(error?.statusCode || error?.status || 0);
    return (
      statusCode === 401 ||
      statusCode === 403 ||
      message.includes('token') ||
      message.includes('auth') ||
      message.includes('invalid') ||
      message.includes('expired') ||
      message.includes('unauthorized')
    );
  }

  async _listZerodhaConnections({ expiringOnly = false } = {}) {
    let query = `
      SELECT
        bc.id,
        bc."userId" AS user_id,
        bc."accountId" AS account_id,
        bc."expiresAt" AS expires_at,
        bc."lastAuthAt" AS last_auth_at,
        bc."status" AS status,
        kuc.kite_user_id
      FROM "BrokerConnection" bc
      INNER JOIN kite_user_credentials kuc
        ON kuc.user_id = bc."userId"
      WHERE bc."brokerType" = 'ZERODHA'
        AND bc."isActive" = true
        AND kuc.is_active = true
        AND kuc.auto_refresh_enabled = true
    `;

    if (expiringOnly) {
      query += `
        AND (
          (bc."expiresAt" IS NOT NULL AND bc."expiresAt" < NOW() + INTERVAL '3 hours')
          OR
          (bc."expiresAt" IS NULL AND (bc."lastAuthAt" IS NULL OR bc."lastAuthAt" < NOW() - INTERVAL '20 hours'))
        )
      `;
    }

    query += `
      ORDER BY
        COALESCE(bc."expiresAt", NOW()) ASC,
        bc."updatedAt" DESC
      LIMIT 500
    `;

    const result = await db.query(query);
    return this._filterSchedulableUsers(result.rows || []);
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

    // Dhan proactive refresh every hour using BrokerConnection expiry metadata.
    const dhanCronExpression = '15 * * * *';
    cron.schedule(dhanCronExpression, async () => {
      logger.info('⏰ [Scheduler] Dhan proactive refresh check (hourly)');
      await this.refreshExpiringDhanConnections();
    }, {
      timezone: 'Asia/Kolkata'
    });

    logger.info('✅ [Scheduler] Daily token refresh scheduled for 8:30 AM IST');
    logger.info('✅ [Scheduler] Proactive refresh check scheduled every 2 hours');
    logger.info('✅ [Scheduler] Dhan proactive refresh scheduled hourly');
    logger.info(`📅 [Scheduler] Next run: ${this.getNextRunTime()}`);

    // Startup Check: If it's between 8:30 AM and 3:30 PM, and we don't have a valid token
    // trigger a refresh. This handles the "server down during 8:30 AM" case.
    this._runStartupCheck();
  }

  async _runStartupCheck() {
    try {
      logger.info('🔍 [Scheduler] Running startup token check...');

      const schedulableUsers = await this._listZerodhaConnections();

      if (schedulableUsers.length === 0) {
        logger.info('ℹ️ [Scheduler] No active users found for startup check');
        return;
      }

      logger.info(`🔍 [Scheduler] Checking tokens for ${schedulableUsers.length} active Zerodha connection(s)...`);

      let needsRefreshCount = 0;
      for (const user of schedulableUsers) {
        const needsRefresh = await this._checkIfTokenNeeded(user);
        if (needsRefresh) {
          needsRefreshCount++;
          logger.warn(`⚠️ [Scheduler] Connection ${user.id} (user ${user.user_id}) needs token refresh`);
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

  async _checkIfTokenNeeded(connectionRow) {
    try {
      if (!connectionRow?.expires_at) return true;
      const expiresAt = new Date(connectionRow.expires_at);
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

    this.isRunning = true;
    try {
      const expiringUsers = await this._listZerodhaConnections({ expiringOnly: true });
      if (expiringUsers.length === 0) {
        logger.info('✅ [Scheduler] No Zerodha connections expiring soon (next 3 hours)');
        return;
      }

      logger.info(`🔄 [Scheduler] Found ${expiringUsers.length} Zerodha connection(s) expiring soon, refreshing...`);

      for (const row of expiringUsers) {
        const now = new Date();
        const hasExpiry = !!row.expires_at;
        const hoursUntilExpiry = hasExpiry
          ? (new Date(row.expires_at) - now) / (1000 * 60 * 60)
          : 0;

        if (!hasExpiry || hoursUntilExpiry < 2) {
          logger.info(`⏰ [Scheduler] Token for connection ${row.id} (user ${row.user_id}) expires in ${hoursUntilExpiry.toFixed(1)} hours, refreshing...`);
          const correlationId = randomUUID();
          try {
            await tokenManager.refreshTokenForUser({
              userId: row.user_id,
              brokerType: 'ZERODHA',
              accountId: row.account_id || null,
              brokerConnectionId: row.id,
              correlationId
            });
            logger.info(`✅ [Scheduler] Proactively refreshed token for connection ${row.id}`);

            // Small delay between users
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            logger.error(`❌ [Scheduler] Failed to proactively refresh connection ${row.id}: ${error.message}`);
            const status = this._isAuthError(error) ? 'REAUTH_REQUIRED' : 'ERROR';
            await db.query(`
              UPDATE "BrokerConnection"
              SET "status" = $1,
                  "lastError" = $2,
                  "updatedAt" = NOW()
              WHERE id = $3
            `, [
              status,
              `${String(error.message || 'Zerodha auto-refresh failed').substring(0, 450)} [ref: ${correlationId}]`,
              row.id
            ]);
          }
        }
      }
    } catch (error) {
      logger.error(`❌ [Scheduler] Error in proactive refresh: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async refreshExpiringDhanConnections() {
    if (this.isRunning) {
      logger.warn('⚠️ Token refresh already in progress, skipping Dhan proactive check');
      return;
    }

    this.isRunning = true;
    try {
      const result = await db.query(`
        SELECT
          id,
          "userId" AS user_id,
          "accountId" AS account_id,
          "expiresAt" AS expires_at,
          "lastAuthAt" AS last_auth_at
        FROM "BrokerConnection"
        WHERE "brokerType" = 'DHAN'
          AND "isActive" = true
          AND (
            ("expiresAt" IS NOT NULL AND "expiresAt" < NOW() + INTERVAL '2 hours')
            OR
            ("expiresAt" IS NULL AND ("lastAuthAt" IS NULL OR "lastAuthAt" < NOW() - INTERVAL '20 hours'))
          )
        ORDER BY COALESCE("expiresAt", NOW()) ASC
        LIMIT 200
      `);

      const candidates = this._filterSchedulableUsers(result.rows || []);
      if (candidates.length === 0) {
        logger.info('✅ [Scheduler] No Dhan connections require proactive refresh');
        return;
      }

      logger.info(`🔄 [Scheduler] Found ${candidates.length} Dhan connection(s) requiring refresh`);

      for (const row of candidates) {
        const correlationId = randomUUID();
        try {
          await tokenManager.refreshTokenForUser({
            userId: row.user_id,
            brokerType: 'DHAN',
            accountId: row.account_id || null,
            brokerConnectionId: row.id,
            correlationId
          });
          logger.info(`✅ [Scheduler] Dhan token refreshed for connection ${row.id}`);
        } catch (error) {
          logger.error(`❌ [Scheduler] Dhan refresh failed for connection ${row.id}: ${error.message}`);
          const status = this._isAuthError(error) ? 'REAUTH_REQUIRED' : 'ERROR';
          try {
            await db.query(`
              UPDATE "BrokerConnection"
              SET "status" = $1,
                  "lastError" = $2,
                  "updatedAt" = NOW()
              WHERE id = $3
            `, [
              status,
              `${String(error.message || 'Dhan auto-renew failed').substring(0, 450)} [ref: ${correlationId}]`,
              row.id
            ]);
          } catch (persistError) {
            logger.warn(`⚠️ [Scheduler] Could not persist Dhan refresh error for ${row.id}: ${persistError.message}`);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      logger.error(`❌ [Scheduler] Error in Dhan proactive refresh: ${error.message}`);
    } finally {
      this.isRunning = false;
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
      const users = await this._listZerodhaConnections();
      logger.info(`📋 [Scheduler] Found ${users.length} Zerodha connection(s) for token refresh`);

      if (users.length === 0) {
        logger.info('ℹ️ No Zerodha connections to refresh');
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
            const correlationId = randomUUID();
            logger.info(`🔄 Processing connection: ${user.id} (user ${user.user_id}, kite ${user.kite_user_id}) [attempt ${attempt}/${maxRetries}]`);
            await tokenManager.refreshTokenForUser({
              userId: user.user_id,
              brokerType: 'ZERODHA',
              accountId: user.account_id || null,
              brokerConnectionId: user.id,
              correlationId
            });
            results.success.push(user.id);
            logger.info(`✅ Success: ${user.id}`);
            success = true;
          } catch (error) {
            if (error.message.includes('Browser pool exhausted') && attempt < maxRetries) {
              logger.warn(`⏳ Pool exhausted for connection ${user.id}, waiting 30s before retry (attempt ${attempt}/${maxRetries})...`);
              await new Promise(resolve => setTimeout(resolve, 30000));
            } else {
              const correlationId = randomUUID();
              const status = this._isAuthError(error) ? 'REAUTH_REQUIRED' : 'ERROR';
              await db.query(`
                UPDATE "BrokerConnection"
                SET "status" = $1,
                    "lastError" = $2,
                    "updatedAt" = NOW()
                WHERE id = $3
              `, [
                status,
                `${String(error.message || 'Zerodha refresh failed').substring(0, 450)} [ref: ${correlationId}]`,
                user.id
              ]).catch(() => { });
              results.failed.push({
                connection_id: user.id,
                user_id: user.user_id,
                kite_user_id: user.kite_user_id,
                error: error.message
              });
              logger.error(`❌ Failed: ${user.id} (${user.user_id}) - ${error.message}`);
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
