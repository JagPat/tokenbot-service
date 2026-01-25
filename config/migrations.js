const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Migration runner for TokenBot service
 * Runs all migrations in order on startup to ensure database schema is up-to-date
 */
class MigrationRunner {
  constructor() {
    this.migrationsDir = path.join(__dirname, '..', 'migrations');
  }

  /**
   * Extract database connection info for logging (without credentials)
   */
  extractDbInfo(connectionString) {
    try {
      // Parse connection string to extract host, port, database
      const url = new URL(connectionString.replace(/^postgresql:\/\//, 'http://'));
      return {
        host: url.hostname || 'unknown',
        port: url.port || '5432',
        database: url.pathname?.replace('/', '') || 'unknown'
      };
    } catch (e) {
      return { host: 'unknown', port: 'unknown', database: 'unknown' };
    }
  }

  /**
   * Get SSL configuration based on connection string
   */
  getSSLConfig(connectionString) {
    const isRailwayInternal = connectionString.includes('railway.internal');
    const hasSSLMode = connectionString.includes('sslmode=');

    if (hasSSLMode) {
      const sslModeMatch = connectionString.match(/sslmode=([^&]+)/);
      const sslMode = sslModeMatch ? sslModeMatch[1] : '';
      if (sslMode === 'require' || sslMode === 'prefer') {
        return { rejectUnauthorized: false };
      }
    } else if (isRailwayInternal) {
      return false;
    }

    return false;
  }

  /**
   * Create migrations tracking table if it doesn't exist
   */
  async ensureMigrationsTable(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT NOW()
      );
    `);
    logger.info('✅ Migrations tracking table ready');
  }

  /**
   * Get list of already executed migrations
   */
  async getExecutedMigrations(pool) {
    try {
      const result = await pool.query('SELECT name FROM _migrations ORDER BY id');
      return result.rows.map(row => row.name);
    } catch (error) {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Mark a migration as executed
   */
  async markMigrationExecuted(pool, migrationName) {
    await pool.query(
      'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [migrationName]
    );
  }

  /**
   * Run all pending migrations
   */
  async runMigrations() {
    if (!process.env.DATABASE_URL) {
      logger.warn('⚠️ DATABASE_URL not set, skipping migrations');
      return { success: false, reason: 'no_database_url' };
    }

    const connectionString = process.env.DATABASE_URL;
    const sslConfig = this.getSSLConfig(connectionString);

    const pool = new Pool({
      connectionString,
      ssl: sslConfig,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    try {
      logger.info('🔄 Running database migrations...');

      // Ensure migrations table exists
      await this.ensureMigrationsTable(pool);

      // Get executed migrations
      const executedMigrations = await this.getExecutedMigrations(pool);
      logger.info(`📋 Found ${executedMigrations.length} previously executed migrations`);

      // Get all migration files
      let migrationFiles = [];
      try {
        migrationFiles = fs.readdirSync(this.migrationsDir)
          .filter(f => f.endsWith('.sql'))
          .sort();
      } catch (err) {
        logger.warn(`⚠️ No migrations directory found at ${this.migrationsDir}`);
        return { success: true, reason: 'no_migrations_dir', executed: [] };
      }

      // Run pending migrations
      const executed = [];
      for (const file of migrationFiles) {
        if (executedMigrations.includes(file)) {
          logger.info(`⏭️ Skipping already executed: ${file}`);
          continue;
        }

        const migrationPath = path.join(this.migrationsDir, file);
        const sql = fs.readFileSync(migrationPath, 'utf8');

        logger.info(`🔄 Running migration: ${file}`);

        try {
          await pool.query(sql);
          await this.markMigrationExecuted(pool, file);
          executed.push(file);
          logger.info(`✅ Migration completed: ${file}`);
        } catch (migrationError) {
          // For some errors, we might want to continue (e.g., "relation already exists")
          if (migrationError.code === '42P07' || // duplicate_table
            migrationError.code === '42710' || // duplicate_object
            migrationError.message.includes('already exists')) {
            logger.warn(`⚠️ Migration ${file} skipped (object already exists)`);
            await this.markMigrationExecuted(pool, file);
            executed.push(file);
          } else {
            logger.error(`❌ Migration ${file} failed:`, migrationError.message);
            throw migrationError;
          }
        }
      }

      if (executed.length > 0) {
        logger.info(`✅ Successfully executed ${executed.length} new migrations`);
      } else {
        logger.info('✅ Database schema is up-to-date');
      }

      return { success: true, executed };

    } catch (error) {
      logger.error('❌ Migration runner failed:', error.message);
      return { success: false, error: error.message };
    } finally {
      await pool.end();
    }
  }

  /**
   * Run essential migrations inline (without reading from files)
   * This is a fallback in case the migrations directory is not available
   */
  async runEssentialMigrations(useSharedPool = false, sharedPool = null) {
    if (!process.env.DATABASE_URL) {
      logger.warn('⚠️ DATABASE_URL not set, skipping essential migrations');
      return { success: false, reason: 'no_database_url' };
    }

    // Use shared pool if provided, otherwise create new one
    let pool = sharedPool;
    let shouldClosePool = false;

    if (!useSharedPool || !sharedPool) {
      const connectionString = process.env.DATABASE_URL;
      const sslConfig = this.getSSLConfig(connectionString);

      // Extract database info for logging (without exposing credentials)
      const dbInfo = this.extractDbInfo(connectionString);
      logger.info(`📍 Database connection info: ${dbInfo.host}:${dbInfo.port}/${dbInfo.database}`);

      pool = new Pool({
        connectionString,
        ssl: sslConfig,
        max: 3,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000, // Increased timeout
      });
      const pool = useSharedPool && sharedPool ? sharedPool : this.pool;
      if (!pool) {
        logger.error('❌ Cannot run essential migrations: Database pool not initialized');
        return { success: false, error: 'DB pool missing' };
      }

      logger.info('🛡️ Running ESSENTIAL migrations (Fail-safe mode)...');

      try {
        // 1. Create _migrations table
        await pool.query(`
        CREATE TABLE IF NOT EXISTS public._migrations (
          id SERIAL PRIMARY KEY,
          migration_name VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP DEFAULT NOW()
        );
      `);
        logger.info('✅ Verified _migrations table');

        // 2. Create kite_user_credentials table
        await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kite_user_credentials (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL UNIQUE,
          api_key VARCHAR(255) NOT NULL,
          api_secret VARCHAR(255) NOT NULL,
          redirect_url VARCHAR(255) DEFAULT 'http://localhost:3000/api/kite/callback',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
        logger.info('✅ Verified kite_user_credentials table');

        // 3. Create kite_tokens table
        await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kite_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          public_token TEXT,
          login_time TIMESTAMP DEFAULT NOW(),
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
        logger.info('✅ Verified kite_tokens table');

        // 4. Create stored_tokens table
        await pool.query(`
        CREATE TABLE IF NOT EXISTS public.stored_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMP,
          mode VARCHAR(50) DEFAULT 'manual',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
        logger.info('✅ Verified stored_tokens table');

        // 5. Create token_generation_logs table
        await pool.query(`
        CREATE TABLE IF NOT EXISTS public.token_generation_logs (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255),
            status VARCHAR(50) NOT NULL,
            message TEXT,
            timestamp TIMESTAMP DEFAULT NOW()
        );
      `);
        logger.info('✅ Verified token_generation_logs table');

        return { success: true };
      } catch (error) {
        logger.error('❌ Essential migrations failed:', error.message);
        return { success: false, error: error.message };
      } finally {
        // Do not close shared pool
        if (!useSharedPool && pool && this.pool !== pool) {
          await pool.end();
        }
      }
    }
  }

module.exports = new MigrationRunner();
