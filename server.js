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
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
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
  try {
    logger.info('🚀 Starting TokenBot Service...');
    
    // Test database connection
    await db.query('SELECT NOW()');
    logger.info('✅ Database connected');
    
    // Test encryption
    const encryptTest = encryptor.test();
    if (!encryptTest) {
      throw new Error('Encryption test failed');
    }
    
    // Start scheduler
    scheduler.start();
    
    // Start server
    app.listen(PORT, () => {
      logger.info(`✅ TokenBot Service running on port ${PORT}`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`📅 Scheduler: Active (8:00 AM IST daily)`);
    });
    
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
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

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();

