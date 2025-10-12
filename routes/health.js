const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * GET /health
 * Health check endpoint
 */
router.get('/', async (req, res) => {
  try {
    const startTime = Date.now();

    // Check database connection
    await db.query('SELECT 1');
    
    const dbLatency = Date.now() - startTime;

    res.json({
      success: true,
      status: 'healthy',
      service: 'tokenbot-service',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        connected: true,
        latency_ms: dbLatency
      },
      memory: {
        used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      database: {
        connected: false
      }
    });
  }
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

module.exports = router;

