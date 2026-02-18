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

// Startup Logic (Refactored for fast port binding)
async function initializeServices() {
  logger.info('🚀 Initializing TokenBot Services...');

  // Check required environment variables
  const requiredEnvVars = ['DATABASE_URL', 'ENCRYPTION_KEY'];
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);

  if (missingVars.length > 0) {
    logger.warn(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
  }

  // 1. Database Initialization (Async)
  if (process.env.DATABASE_URL) {
    try {
      logger.info('🔄 Connecting to database...');

      // Ensure pool exists
      if (!db.pool) throw new Error('Database pool not created');

      // Test connection
      await db.query('SELECT 1');
      logger.info('✅ Database connection established');

      // Run Migrations
      logger.info('🔄 Running migrations...');

      // Try file-based first
      const migrationResult = await migrationRunner.runMigrations();

      // Always run essential migrations
      const essentialResult = await migrationRunner.runEssentialMigrations(true, db.pool);

      if (!essentialResult.success) {
        logger.error('❌ Essential migrations failed:', essentialResult.error);
        // We don't exit here, we just log. Health check will report status.
      } else {
        logger.info('✅ Essential migrations completed');
      }

      // Verify Tables
      const tableCheck = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('stored_tokens', 'kite_tokens', 'kite_user_credentials', 'token_generation_logs', 'BrokerConnection')
      `);

      if (tableCheck.rows.length < 5) {
        logger.error(`❌ Missing tables. Found: ${tableCheck.rows.map(r => r.table_name).join(', ')}`);
        logger.error(`   Missing: ${['stored_tokens', 'kite_tokens', 'kite_user_credentials', 'token_generation_logs', 'BrokerConnection'].filter(t => !tableCheck.rows.some(r => r.table_name === t)).join(', ')}`);
        // Try retry once
        const retryResult = await migrationRunner.runEssentialMigrations(true, db.pool);
        if (!retryResult.success) {
          logger.error('❌ Migration retry failed - service may not function correctly');
        }
        const credentialLoader = require('./services/credentialLoader');
        await credentialLoader.syncFromEnv();
      } else {
        logger.info('✅ All required tables verified');
        // Try to sync credentials even if tables existed before
        const credentialLoader = require('./services/credentialLoader');
        await credentialLoader.syncFromEnv();
      }

    } catch (dbError) {
      logger.error('❌ Database initialization failed:', dbError);
    }
  }

  // 2. Start other services
  try {
    if (process.env.ENCRYPTION_KEY) encryptor.test();
    if (process.env.DATABASE_URL) scheduler.start();
  } catch (err) {
    logger.warn('⚠️ Minor service initialization warning:', err.message);
  }

  logger.info('✨ Service initialization complete');
}

// Start Server IMMEDIATELY
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ TokenBot HTTP Server running on port ${PORT}`);
  // Start initialization in background
  initializeServices().catch(err => {
    logger.error('❌ Fatal error during background initialization:', err);
  });
});

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
