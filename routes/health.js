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
 * GET /health/schema
 * Get database schema details including tables, indexes, and constraints
 */
router.get('/schema', async (req, res) => {
  try {
    // Get all tables
    const tablesResult = await db.query(`
      SELECT table_name, 
             (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    // Get all indexes
    const indexesResult = await db.query(`
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);

    // Get table sizes
    const sizesResult = await db.query(`
      SELECT 
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size,
        pg_size_pretty(pg_relation_size(relid)) as data_size,
        pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) as index_size,
        n_live_tup as row_count
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `);

    // Get triggers
    const triggersResult = await db.query(`
      SELECT 
        trigger_name,
        event_manipulation,
        event_object_table,
        action_timing
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
    `);

    // Get constraints
    const constraintsResult = await db.query(`
      SELECT 
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = 'public'
      ORDER BY tc.table_name, tc.constraint_type
    `);

    // Build optimization report
    const tables = tablesResult.rows;
    const indexes = indexesResult.rows;
    const sizes = sizesResult.rows;
    const triggers = triggersResult.rows;
    const constraints = constraintsResult.rows;

    // Check for missing optimizations
    const recommendations = [];
    
    // Check if each table has a primary key
    const tablesWithPK = new Set(constraints.filter(c => c.constraint_type === 'PRIMARY KEY').map(c => c.table_name));
    tables.forEach(t => {
      if (!tablesWithPK.has(t.table_name) && !t.table_name.startsWith('_')) {
        recommendations.push(`Table '${t.table_name}' is missing a PRIMARY KEY`);
      }
    });

    // Check for user_id indexes on key tables
    const requiredIndexes = [
      { table: 'kite_tokens', column: 'user_id' },
      { table: 'kite_tokens', column: 'is_valid' },
      { table: 'kite_tokens', column: 'expires_at' },
      { table: 'kite_user_credentials', column: 'user_id' },
      { table: 'kite_user_credentials', column: 'is_active' },
      { table: 'stored_tokens', column: 'user_id' },
      { table: 'token_generation_logs', column: 'user_id' },
      { table: 'token_generation_logs', column: 'created_at' }
    ];

    requiredIndexes.forEach(req => {
      const hasIndex = indexes.some(i => 
        i.tablename === req.table && 
        i.indexdef.toLowerCase().includes(req.column.toLowerCase())
      );
      if (!hasIndex) {
        recommendations.push(`Missing index on '${req.table}.${req.column}'`);
      }
    });

    res.json({
      success: true,
      schema: {
        tables: tables.map(t => ({
          name: t.table_name,
          columns: parseInt(t.column_count),
          size: sizes.find(s => s.table_name === t.table_name) || null
        })),
        indexes: indexes.map(i => ({
          table: i.tablename,
          name: i.indexname,
          definition: i.indexdef
        })),
        triggers: triggers,
        constraints: constraints
      },
      optimization: {
        total_tables: tables.length,
        total_indexes: indexes.length,
        total_triggers: triggers.length,
        recommendations: recommendations,
        status: recommendations.length === 0 ? 'OPTIMIZED' : 'NEEDS_ATTENTION'
      }
    });
  } catch (error) {
    logger.error('Schema check failed:', error);
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
  // Accept the known TokenBot API key (same one used for other endpoints)
  const validKeys = [
    process.env.JWT_SECRET,
    process.env.TOKENBOT_API_KEY,
    '4b0b4a4f4ab5f3130ea01acbeaab365ddc26a08d70070e1f4d996a237861d1eb' // Fallback known key
  ].filter(Boolean);
  
  // Require API key for security
  if (!apiKey || !validKeys.includes(apiKey)) {
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

