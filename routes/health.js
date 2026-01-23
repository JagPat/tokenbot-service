const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../utils/logger');

// Safely import browserPool - don't crash if it fails to load
let browserPool = null;
try {
  browserPool = require('../services/browserPool');
} catch (error) {
  logger.warn('Browser pool not available:', error.message);
}

/**
 * GET /health
 * Health check endpoint
 */
router.get('/', async (req, res) => {
  // Always return 200 for Railway health check
  // This allows deployment even with missing env vars
  
  let dbConnected = false;
  let dbLatency = null;
  let dbError = null;

  try {
    if (process.env.DATABASE_URL) {
      const startTime = Date.now();
      await db.query('SELECT 1');
      dbLatency = Date.now() - startTime;
      dbConnected = true;
    }
  } catch (error) {
    dbError = error.message;
    logger.error('Health check - database error:', error.message);
  }

  // Always return 200, even if database is not connected
  res.status(200).json({
    success: true,
    status: dbConnected ? 'healthy' : 'limited',
    service: 'tokenbot-service',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: {
      connected: dbConnected,
      latency_ms: dbLatency,
      error: dbError
    },
    environment: {
      has_database_url: !!process.env.DATABASE_URL,
      has_encryption_key: !!process.env.ENCRYPTION_KEY,
      has_jwt_secret: !!process.env.JWT_SECRET
    },
    memory: {
      used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    browser_pool: browserPool ? browserPool.getStats() : { error: 'not_available' }
  });
});

/**
 * GET /health/detailed
 * Detailed health check with stats
 */
router.get('/detailed', async (req, res) => {
  try {
    // Get database stats
    const usersResult = await db.query(`
      SELECT COUNT(*) as total_users,
             SUM(CASE WHEN is_active = true THEN 1 ELSE 0 END) as active_users,
             SUM(CASE WHEN auto_refresh_enabled = true THEN 1 ELSE 0 END) as auto_refresh_users
      FROM kite_user_credentials
    `);

    const tokensResult = await db.query(`
      SELECT COUNT(*) as total_tokens,
             SUM(CASE WHEN is_valid = true THEN 1 ELSE 0 END) as valid_tokens,
             SUM(CASE WHEN expires_at > NOW() THEN 1 ELSE 0 END) as unexpired_tokens
      FROM kite_tokens
    `);

    const logsResult = await db.query(`
      SELECT 
        COUNT(*) as total_attempts,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_attempts,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_attempts,
        AVG(CASE WHEN status = 'success' THEN execution_time_ms ELSE NULL END) as avg_success_time_ms
      FROM token_generation_logs
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats: {
        users: usersResult.rows[0],
        tokens: tokensResult.rows[0],
        recent_logs: {
          ...logsResult.rows[0],
          period: 'last_7_days'
        }
      }
    });
  } catch (error) {
    logger.error('Detailed health check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /health/migrate
 * Force run database migrations (for debugging/recovery)
 */
router.post('/migrate', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.JWT_SECRET || process.env.TOKENBOT_API_KEY;
  
  // Require API key for security
  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized - API key required'
    });
  }

  try {
    logger.info('🔄 [HEALTH] Force migration requested...');
    
    const migrationRunner = require('../config/migrations');
    
    // Run essential migrations
    logger.info('🔄 Running essential (inline) migrations...');
    const result = await migrationRunner.runEssentialMigrations();
    
    if (result.success) {
      // Verify tables
      const tableCheck = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('stored_tokens', 'kite_tokens', 'kite_user_credentials', 'token_generation_logs')
      `);
      
      logger.info(`✅ [HEALTH] Migration complete. Tables: ${tableCheck.rows.map(r => r.table_name).join(', ')}`);
      
      res.json({
        success: true,
        message: 'Migrations completed successfully',
        tables: tableCheck.rows.map(r => r.table_name)
      });
    } else {
      throw new Error(result.error || 'Migration failed');
    }
  } catch (error) {
    logger.error('❌ [HEALTH] Migration failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

