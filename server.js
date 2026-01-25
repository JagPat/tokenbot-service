console.log("DEBUG: Server Process Started " + new Date().toISOString() + " - Build v1.0.1");
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('./utils/logger');
const db = require('./config/database');
const migrationRunner = require('./config/migrations');
const encryptor = require('./services/encryptor');
const scheduler = require('./services/scheduler');
const browserPool = require('./services/browserPool');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

// Import routes
const healthRoutes = require('./routes/health');
const credentialsRoutes = require('./routes/credentials');
const tokensRoutes = require('./routes/tokens');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());

// CORS configuration - allow frontend origins
const allowedOrigins = [
  'https://quantum-leap-frontend-production.up.railway.app',
  'https://www.quantumleap.trade',
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || process.env.CORS_ORIGIN === '*') {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked origin: ${origin}`);
      callback(null, true); // Still allow for now, log for monitoring
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });

  next();
});

// Routes
app.use('/health', healthRoutes);
app.use('/api/credentials', credentialsRoutes);
app.use('/api/tokens', tokensRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'TokenBot Service',
    version: '1.0.0',
    description: 'Autonomous Kite token generation microservice for QuantumLeap Trading',
    endpoints: {
      health: '/health',
      credentials: '/api/credentials',
      tokens: '/api/tokens'
    }
  });
});

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Startup
async function startServer() {
  logger.info('🚀 Starting TokenBot Service...');

  // Check required environment variables
  const requiredEnvVars = ['DATABASE_URL', 'ENCRYPTION_KEY'];
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);

  if (missingVars.length > 0) {
    logger.warn(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
    logger.warn('⚠️ Service will start in limited mode. Set these variables for full functionality.');
  }

  // RUN MIGRATIONS BEFORE ANYTHING ELSE
  // This ensures database schema is ready before the server starts accepting requests
  if (process.env.DATABASE_URL) {
    try {
      logger.info('🔄 Initializing database schema...');
      logger.info(`📍 DATABASE_URL present: ${!!process.env.DATABASE_URL}`);
      
      // Ensure database pool is initialized
      if (!db.pool) {
        logger.error('❌ Database pool not initialized! Cannot run migrations.');
        throw new Error('Database pool not initialized - check DATABASE_URL and database connection');
      }
      
      // Test database connection before running migrations
      try {
        await db.query('SELECT 1');
        logger.info('✅ Database connection verified');
      } catch (connError) {
        logger.error('❌ Database connection test failed:', connError.message);
        throw new Error(`Database connection failed: ${connError.message}`);
      }
      
      // First, try to run migrations from files
      logger.info('🔄 Step 1: Running file-based migrations...');
      const migrationResult = await migrationRunner.runMigrations();
      logger.info(`📋 File migrations result: ${JSON.stringify(migrationResult)}`);
      
      // ALWAYS run essential migrations as a safety net
      // This ensures critical tables exist even if file migrations fail
      if (!migrationResult.success || migrationResult.reason === 'no_migrations_dir') {
        logger.warn('⚠️ File-based migrations unavailable, running essential migrations...');
      } else {
        logger.info('✅ File-based migrations completed, verifying with essential migrations...');
      }
      
      // Always run essential migrations to ensure all tables exist
      // Use the shared database pool to ensure we're using the same connection
      logger.info('🔄 Step 2: Running essential (inline) migrations...');
      logger.info('📍 Using shared database pool for migrations...');
      const essentialResult = await migrationRunner.runEssentialMigrations(true, db.pool);
      logger.info(`📋 Essential migrations result: ${JSON.stringify(essentialResult)}`);
      
      if (!essentialResult.success) {
        logger.error('❌ Essential migrations failed:', essentialResult.error);
        throw new Error(`Database migration failed: ${essentialResult.error}`);
      }
      
      // Verify tables exist and check columns (using main db pool)
      logger.info('🔄 Step 3: Verifying tables exist...');
      
      // Wait a moment for any async operations to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // First, verify which database we're connected to
      const dbInfo = await db.query('SELECT current_database(), current_user');
      logger.info(`📍 Connected to database: ${dbInfo.rows[0].current_database} as ${dbInfo.rows[0].current_user}`);
      
      // Retry table check up to 3 times (in case of timing issues)
      let tableCheck;
      let retries = 3;
      while (retries > 0) {
        try {
          tableCheck = await db.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name IN ('stored_tokens', 'kite_tokens', 'kite_user_credentials')
          `);
          break;
        } catch (checkError) {
          retries--;
          if (retries === 0) throw checkError;
          logger.warn(`⚠️ Table check failed, retrying... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      logger.info(`✅ Tables found: ${tableCheck.rows.map(r => r.table_name).join(', ') || 'NONE'}`);
      
      // Also list all tables for debugging
      const allTables = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      logger.info(`📋 All tables in database: ${allTables.rows.map(r => r.table_name).join(', ') || 'NONE'}`);
      
      if (tableCheck.rows.length < 3) {
        logger.error('❌ CRITICAL: Not all required tables exist!');
        logger.error(`   Found tables: ${tableCheck.rows.map(r => r.table_name).join(', ') || 'NONE'}`);
        logger.error(`   Missing: ${['stored_tokens', 'kite_tokens', 'kite_user_credentials'].filter(t => !tableCheck.rows.some(r => r.table_name === t)).join(', ')}`);
        logger.error('❌ Attempting to re-run essential migrations...');
        
        // Try one more time with the shared pool
        const retryResult = await migrationRunner.runEssentialMigrations(true, db.pool);
        if (!retryResult.success) {
          throw new Error(`Required database tables not created - migrations failed: ${retryResult.error}`);
        }
        
        // Re-check tables after retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        const retryCheck = await db.query(`
          SELECT table_name FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name IN ('stored_tokens', 'kite_tokens', 'kite_user_credentials')
        `);
        
        if (retryCheck.rows.length < 3) {
          throw new Error(`Required database tables still not created after retry. Found: ${retryCheck.rows.map(r => r.table_name).join(', ')}`);
        }
        
        logger.info('✅ Tables created successfully after retry');
      }
      
      // Verify stored_tokens has refresh tracking columns (non-blocking)
      try {
        const columnCheck = await db.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'stored_tokens' 
          AND column_name IN ('last_refresh_at', 'refresh_status', 'error_reason')
        `);
        const foundColumns = columnCheck.rows.map(r => r.column_name);
        const requiredColumns = ['last_refresh_at', 'refresh_status', 'error_reason'];
        const missingColumns = requiredColumns.filter(c => !foundColumns.includes(c));
        
        if (missingColumns.length > 0) {
          logger.warn(`⚠️ stored_tokens missing columns: ${missingColumns.join(', ')}`);
          logger.warn('   Attempting to add missing columns...');
          // Re-run essential migrations to add missing columns
          const retryResult = await migrationRunner.runEssentialMigrations();
          if (!retryResult.success) {
            logger.error(`❌ Failed to add missing columns: ${retryResult.error}`);
            logger.warn('⚠️ Service will continue but refresh tracking may not work');
            // Don't throw - allow service to start even if columns are missing
            // The columns will be added on next migration run
          } else {
            logger.info('✅ Missing columns added successfully');
          }
        } else {
          logger.info('✅ All refresh tracking columns exist');
        }
      } catch (colError) {
        logger.warn(`⚠️ Error verifying columns: ${colError.message}`);
        logger.warn('⚠️ Service will continue but refresh tracking may not work');
        // Don't throw - allow service to start
      }
      
      logger.info('✅ Database schema initialized and verified');
    } catch (migrationError) {
      logger.error('❌ Migration error:', migrationError.message);
      logger.error('Stack:', migrationError.stack);
      // Don't continue if migrations fail - database is required
      throw new Error(`Failed to initialize database: ${migrationError.message}`);
    }
  } else {
    logger.error('❌ DATABASE_URL not set - cannot run migrations');
  }

  // Start server to respond to healthchecks
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`✅ TokenBot Service running on port ${PORT}`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      resolve(server);
    });

    server.on('error', (error) => {
      logger.error(`❌ Server error: ${error.message}`);
      reject(error);
    });
  });

  // Initialize remaining services in background (non-blocking)
  (async () => {
    try {
      // Test database connection (with fallback)
      if (process.env.DATABASE_URL) {
        try {
          await db.query('SELECT NOW()');
          logger.info('✅ Database connected');
        } catch (dbError) {
          logger.error('❌ Database connection failed:', dbError.message);
          logger.warn('⚠️ Service running without database (limited functionality)');
        }
      } else {
        logger.warn('⚠️ DATABASE_URL not set, skipping database connection');
      }

      // Test encryption (with fallback)
      if (process.env.ENCRYPTION_KEY) {
        try {
          const encryptTest = encryptor.test();
          if (!encryptTest) {
            logger.warn('⚠️ Encryption test failed');
          }
        } catch (encError) {
          logger.warn('⚠️ Encryption service unavailable:', encError.message);
        }
      } else {
        logger.warn('⚠️ ENCRYPTION_KEY not set, encryption unavailable');
      }

      // Start scheduler (with fallback)
      if (process.env.DATABASE_URL) {
        try {
          scheduler.start();
          logger.info('✅ Scheduler started');
        } catch (schedError) {
          logger.warn('⚠️ Scheduler failed to start:', schedError.message);
        }
      } else {
        logger.warn('⚠️ Scheduler disabled (no database connection)');
      }

      logger.info(`📊 Status: ${missingVars.length > 0 ? 'Limited Mode' : 'Fully Operational'}`);
      if (missingVars.length === 0) {
        logger.info(`📅 Scheduler: Active (8:00 AM IST daily)`);
      }

    } catch (error) {
      logger.error('❌ Failed to initialize services:', error);
      logger.warn('⚠️ Service running in degraded mode');
    }
  })();

  return server;
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');

  // FIX: Shutdown browser pool before closing database
  try {
    await browserPool.shutdown();
  } catch (error) {
    logger.error(`Error shutting down browser pool: ${error.message}`);
  }

  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');

  // FIX: Shutdown browser pool before closing database
  try {
    await browserPool.shutdown();
  } catch (error) {
    logger.error(`Error shutting down browser pool: ${error.message}`);
  }

  await db.end();
  process.exit(0);
});

// Handle uncaught errors - but don't exit immediately, let server try to start
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  logger.error('Stack:', error.stack);
  // Don't exit immediately - let Railway see the error in logs
  // Process will exit naturally if server can't start
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit immediately - let server continue
});

// Start the server with error handling
(async () => {
  try {
    await startServer();
    } catch (error) {
      logger.error('❌ Failed to start server:', error);
      logger.error('Stack:', error.stack);
      
      // If it's a critical migration/database error (tables missing), don't start
      // But if it's just column issues, allow service to start (columns can be added later)
      if (error.message.includes('table') && 
          (error.message.includes('does not exist') || error.message.includes('not created'))) {
        logger.error('❌ CRITICAL: Required database tables missing. Service cannot start.');
        logger.error('❌ Please check DATABASE_URL and ensure migrations can run.');
        logger.error('❌ Service will exit to prevent operating without core tables.');
        process.exit(1);
      }
      
      // For column or other non-critical errors, try to start anyway
      // The service can operate with missing columns (they'll be added on next migration)
      logger.warn('⚠️ Some database issues detected, but attempting to start service...');
      logger.warn('⚠️ Some functionality may be limited until migrations complete');
      
      try {
        app.listen(PORT, '0.0.0.0', () => {
          logger.info(`⚠️ TokenBot Service running in degraded mode on port ${PORT}`);
          logger.warn('⚠️ Some functionality may be limited');
        });
      } catch (listenError) {
        logger.error('❌ Failed to start server even in degraded mode:', listenError);
        process.exit(1);
      }
    }
})();

