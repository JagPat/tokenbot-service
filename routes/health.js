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
  let tokenRefreshHealth = {
    last_success_at: null,
    last_failure_at: null,
    recent_successes: 0,
    recent_failures: 0
  };

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

  // Verify critical tables exist and get database info
  let tablesExist = false;
  let missingTables = [];
  let dbInfo = null;
  if (dbConnected) {
    try {
      // Get database connection info
      const dbInfoResult = await db.query('SELECT current_database(), current_user, version()');
      dbInfo = {
        database: dbInfoResult.rows[0].current_database,
        user: dbInfoResult.rows[0].current_user,
        version: dbInfoResult.rows[0].version.split(' ')[0] + ' ' + dbInfoResult.rows[0].version.split(' ')[1] // PostgreSQL version
      };
      
      // Extract connection info from DATABASE_URL (without credentials)
      try {
        const url = new URL(process.env.DATABASE_URL.replace(/^postgresql:\/\//, 'http://'));
        dbInfo.host = url.hostname;
        dbInfo.port = url.port || '5432';
      } catch (e) {
        // Ignore parsing errors
      }
      
      const tableCheck = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('stored_tokens', 'kite_tokens', 'kite_user_credentials')
      `);
      const foundTables = tableCheck.rows.map(r => r.table_name);
      const requiredTables = ['stored_tokens', 'kite_tokens', 'kite_user_credentials'];
      missingTables = requiredTables.filter(t => !foundTables.includes(t));
      tablesExist = missingTables.length === 0;
      
      if (!tablesExist) {
        logger.error(`❌ CRITICAL: Missing required tables: ${missingTables.join(', ')}`);
        logger.error(`   Database: ${dbInfo.database} on ${dbInfo.host || 'unknown'}:${dbInfo.port || 'unknown'}`);
      }

      // Token refresh health metrics (best effort)
      try {
        const tokenHealthResult = await db.query(`
          SELECT
            MAX(CASE WHEN status = 'success' THEN created_at END) AS last_success_at,
            MAX(CASE WHEN status = 'failed' THEN created_at END) AS last_failure_at,
            SUM(CASE WHEN status = 'success' AND created_at > NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END) AS recent_successes,
            SUM(CASE WHEN status = 'failed' AND created_at > NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END) AS recent_failures
          FROM token_generation_logs
        `);

        if (tokenHealthResult?.rows?.[0]) {
          tokenRefreshHealth = {
            last_success_at: tokenHealthResult.rows[0].last_success_at,
            last_failure_at: tokenHealthResult.rows[0].last_failure_at,
            recent_successes: parseInt(tokenHealthResult.rows[0].recent_successes || '0', 10),
            recent_failures: parseInt(tokenHealthResult.rows[0].recent_failures || '0', 10)
          };
        }
      } catch (metricsError) {
        logger.warn(`⚠️ Token refresh metrics unavailable: ${metricsError.message}`);
      }
    } catch (tableError) {
      logger.error(`❌ Error checking tables: ${tableError.message}`);
    }
  }

  const browserPoolStats = browserPool ? browserPool.getStats() : { error: 'not_available' };
  const breakerState = browserPoolStats?.circuitBreaker?.state || 'UNKNOWN';
  const breakerOpen = breakerState === 'OPEN';
  const degraded = !(dbConnected && tablesExist) || breakerOpen;

  // Always return 200, even if database is not connected
  res.status(200).json({
    success: true,
    status: degraded ? 'degraded' : 'healthy',
    service: 'tokenbot-service',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: {
      connected: dbConnected,
      latency_ms: dbLatency,
      error: dbError,
      tables_exist: tablesExist,
      missing_tables: missingTables,
      info: dbInfo ? {
        database: dbInfo.database,
        host: dbInfo.host,
        port: dbInfo.port,
        user: dbInfo.user,
        version: dbInfo.version
      } : null
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
    browser_pool: browserPoolStats,
    token_refresh: tokenRefreshHealth
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

    let tokenHealthResult = null;
    try {
      tokenHealthResult = await db.query(`
        SELECT
          MAX(CASE WHEN status = 'success' THEN created_at END) AS last_success_at,
          MAX(CASE WHEN status = 'failed' THEN created_at END) AS last_failure_at
        FROM token_generation_logs
      `);
    } catch (metricsError) {
      logger.warn(`Detailed health token metrics unavailable: ${metricsError.message}`);
    }

    res.json({
      success: true,
      status: browserPool?.getStats?.()?.circuitBreaker?.state === 'OPEN' ? 'degraded' : 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats: {
        users: usersResult.rows[0],
        tokens: tokensResult.rows[0],
        browser_pool: browserPool ? browserPool.getStats() : null,
        token_health: tokenHealthResult?.rows?.[0] || null,
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
        (i.indexdef.toLowerCase().includes(req.column.toLowerCase()) ||
         i.indexname.toLowerCase().includes(req.column.toLowerCase()))
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
    process.env.SERVICE_API_KEY
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

/**
 * POST /health/optimize
 * Run safe database optimizations (non-destructive)
 */
router.post('/optimize', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const validKeys = [
    process.env.JWT_SECRET,
    process.env.TOKENBOT_API_KEY,
    process.env.SERVICE_API_KEY
  ].filter(Boolean);
  
  if (!apiKey || !validKeys.includes(apiKey)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const results = {
    extensions: [],
    indexes: [],
    triggers: [],
    defaults: [],
    errors: []
  };

  try {
    logger.info('🔧 [OPTIMIZE] Starting database optimizations...');

    // 1. Check and enable pgvector if available
    try {
      const extCheck = await db.query(`SELECT * FROM pg_available_extensions WHERE name = 'vector'`);
      if (extCheck.rows.length > 0) {
        await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        results.extensions.push('pgvector enabled');
        logger.info('✅ pgvector extension enabled');
      } else {
        results.extensions.push('pgvector not available on this PostgreSQL instance');
      }
    } catch (e) {
      results.extensions.push(`pgvector check: ${e.message}`);
    }

    // 2. Add composite indexes for common query patterns (non-destructive)
    const compositeIndexes = [
      // AIDecisionLog - common queries
      { name: 'idx_ai_decision_symbol_decided', table: 'AIDecisionLog', columns: '(symbol, "decidedAt" DESC)' },
      { name: 'idx_ai_decision_source_decided', table: 'AIDecisionLog', columns: '(source, "decidedAt" DESC)' },
      { name: 'idx_ai_decision_validated', table: 'AIDecisionLog', columns: '("wasCorrect", "validatedAt")' },
      
      // BacktestResult - strategy analysis
      { name: 'idx_backtest_strategy_created', table: 'BacktestResult', columns: '("strategyId", "createdAt" DESC)' },
      { name: 'idx_backtest_symbol_dates', table: 'BacktestResult', columns: '(symbol, "startDate", "endDate")' },
      
      // ResearchSnapshot - time-series queries
      { name: 'idx_research_stock_time', table: 'ResearchSnapshot', columns: '("stockId", timestamp DESC)' },
      
      // AIUsageLog - cost analysis
      { name: 'idx_ai_usage_provider_time', table: 'AIUsageLog', columns: '(provider, timestamp DESC)' },
      { name: 'idx_ai_usage_feature_time', table: 'AIUsageLog', columns: '(feature, timestamp DESC)' },
      
      // Strategy - active strategies
      { name: 'idx_strategy_active_updated', table: 'Strategy', columns: '("isActive", "updatedAt" DESC)' },
      
      // UserFeedback - feedback analysis
      { name: 'idx_feedback_type_created', table: 'UserFeedback', columns: '("feedbackType", "createdAt" DESC)' },
      
      // SimulationResult - active simulations
      { name: 'idx_simulation_active_started', table: 'SimulationResult', columns: '("isActive", "startedAt" DESC)' }
    ];

    for (const idx of compositeIndexes) {
      try {
        await db.query(`CREATE INDEX IF NOT EXISTS ${idx.name} ON "${idx.table}" ${idx.columns}`);
        results.indexes.push(`${idx.name} on ${idx.table}`);
      } catch (e) {
        if (!e.message.includes('already exists')) {
          results.errors.push(`Index ${idx.name}: ${e.message}`);
        }
      }
    }
    logger.info(`✅ Added ${results.indexes.length} composite indexes`);

    // 3. Add updated_at triggers for tables that need them
    const tablesNeedingTriggers = ['AIDecisionLog', 'AILesson', 'UserFeedback', 'UserPrinciple'];
    
    // Create trigger function if not exists
    await db.query(`
      CREATE OR REPLACE FUNCTION trigger_set_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW."updatedAt" = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    for (const table of tablesNeedingTriggers) {
      try {
        // Check if table has updatedAt column
        const colCheck = await db.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = '${table}' AND column_name = 'updatedAt'
        `);
        
        if (colCheck.rows.length > 0) {
          const triggerName = `set_timestamp_${table.toLowerCase()}`;
          await db.query(`
            DROP TRIGGER IF EXISTS ${triggerName} ON "${table}";
            CREATE TRIGGER ${triggerName}
            BEFORE UPDATE ON "${table}"
            FOR EACH ROW
            EXECUTE FUNCTION trigger_set_timestamp();
          `);
          results.triggers.push(`${triggerName} on ${table}`);
        }
      } catch (e) {
        // Table might not have updatedAt, that's fine
      }
    }
    logger.info(`✅ Added ${results.triggers.length} auto-update triggers`);

    // 4. Populate default AI models if empty
    const modelCount = await db.query(`SELECT COUNT(*) as count FROM "AIModel"`);
    if (parseInt(modelCount.rows[0].count) === 0) {
      const defaultModels = [
        { name: 'Gemini 2.5 Flash', provider: 'GOOGLE', modelId: 'gemini-2.5-flash-preview-05-20', capabilities: ['RESEARCH', 'TRADE', 'DEBATE'], costPerInput: 0.075, costPerOutput: 0.30, isActive: true, isDefault: true },
        { name: 'Gemini 2.0 Flash', provider: 'GOOGLE', modelId: 'gemini-2.0-flash', capabilities: ['RESEARCH', 'TRADE'], costPerInput: 0.10, costPerOutput: 0.40, isActive: true, isDefault: false },
        { name: 'Claude 3.5 Sonnet', provider: 'ANTHROPIC', modelId: 'claude-3-5-sonnet-20241022', capabilities: ['CODING', 'RESEARCH', 'DEBATE'], costPerInput: 3.0, costPerOutput: 15.0, isActive: true, isDefault: false },
        { name: 'GPT-4o', provider: 'OPENAI', modelId: 'gpt-4o', capabilities: ['RESEARCH', 'TRADE', 'CODING'], costPerInput: 2.5, costPerOutput: 10.0, isActive: true, isDefault: false },
        { name: 'GPT-4o Mini', provider: 'OPENAI', modelId: 'gpt-4o-mini', capabilities: ['RESEARCH', 'TRADE'], costPerInput: 0.15, costPerOutput: 0.60, isActive: true, isDefault: false }
      ];
      
      for (const model of defaultModels) {
        try {
          await db.query(`
            INSERT INTO "AIModel" (id, name, provider, "modelId", capabilities, "costPerInput", "costPerOutput", "isActive", "isDefault", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
          `, [model.name, model.provider, model.modelId, model.capabilities, model.costPerInput, model.costPerOutput, model.isActive, model.isDefault]);
          results.defaults.push(`AIModel: ${model.name}`);
        } catch (e) {
          results.errors.push(`AIModel ${model.name}: ${e.message}`);
        }
      }
      logger.info(`✅ Populated ${results.defaults.length} default AI models`);
    } else {
      results.defaults.push('AIModel already has data, skipped');
    }

    // 5. Verify all optimizations
    const finalIndexCount = await db.query(`
      SELECT COUNT(*) as count FROM pg_indexes WHERE schemaname = 'public'
    `);
    
    const finalTriggerCount = await db.query(`
      SELECT COUNT(*) as count FROM information_schema.triggers WHERE trigger_schema = 'public'
    `);

    logger.info('✅ [OPTIMIZE] Database optimizations complete');
    
    res.json({
      success: true,
      message: 'Database optimizations completed',
      results: {
        extensions: results.extensions,
        indexesAdded: results.indexes.length,
        indexes: results.indexes,
        triggersAdded: results.triggers.length,
        triggers: results.triggers,
        defaultsPopulated: results.defaults,
        errors: results.errors,
        totals: {
          totalIndexes: parseInt(finalIndexCount.rows[0].count),
          totalTriggers: parseInt(finalTriggerCount.rows[0].count)
        }
      },
      dataPreserved: true
    });

  } catch (error) {
    logger.error('❌ [OPTIMIZE] Failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      results: results
    });
  }
});

module.exports = router;
