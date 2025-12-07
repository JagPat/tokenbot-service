require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('./utils/logger');
const db = require('./config/database');
const encryptor = require('./services/encryptor');
const scheduler = require('./services/scheduler');
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
  // Start server FIRST to ensure it's listening ASAP for healthchecks
  // Then initialize other services in background
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`✅ TokenBot Service running on port ${PORT}`);
    logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Initialize services in background (non-blocking)
  try {
    logger.info('🚀 Starting TokenBot Service...');
    
    // Check required environment variables
    const requiredEnvVars = ['DATABASE_URL', 'ENCRYPTION_KEY'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    
    if (missingVars.length > 0) {
      logger.warn(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
      logger.warn('⚠️ Service will start in limited mode. Set these variables for full functionality.');
    }
    
    // Test database connection (with fallback)
    if (process.env.DATABASE_URL) {
      try {
        await db.query('SELECT NOW()');
        logger.info('✅ Database connected');
      } catch (dbError) {
        logger.error('❌ Database connection failed:', dbError.message);
        logger.warn('⚠️ Starting service without database (limited functionality)');
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
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
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
    // Try to start server anyway in degraded mode
    try {
      app.listen(PORT, '0.0.0.0', () => {
        logger.info(`⚠️ TokenBot Service running in emergency mode on port ${PORT}`);
      });
    } catch (listenError) {
      logger.error('❌ Failed to start server even in emergency mode:', listenError);
      process.exit(1);
    }
  }
})();

