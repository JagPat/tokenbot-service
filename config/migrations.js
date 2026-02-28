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
      shouldClosePool = true;
    }

    if (!pool) {
      logger.error('❌ Cannot run essential migrations: Database pool not initialized');
      return { success: false, error: 'DB pool missing' };
    }

    try {
      // Verify we're connected to the right database
      const dbCheck = await pool.query('SELECT current_database(), current_user, version()');
      logger.info(`✅ Connected to database: ${dbCheck.rows[0].current_database}`);
      logger.info(`✅ Connected as user: ${dbCheck.rows[0].current_user}`);
      
      logger.info('🔄 Running essential database migrations (inline)...');

      // 1. Create kite_user_credentials table (FULL SCHEMA matching code expectations)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kite_user_credentials (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL UNIQUE,
          kite_user_id VARCHAR(100) NOT NULL,
          encrypted_password TEXT NOT NULL,
          encrypted_totp_secret TEXT NOT NULL,
          encrypted_api_key TEXT NOT NULL,
          encrypted_api_secret TEXT NOT NULL,
          is_active BOOLEAN DEFAULT true,
          auto_refresh_enabled BOOLEAN DEFAULT true,
          last_used TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kite_user_credentials_user_id ON kite_user_credentials(user_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kite_user_credentials_is_active ON kite_user_credentials(is_active);`);
      logger.info('✅ kite_user_credentials table ready');

      // 2. Create kite_tokens table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kite_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          access_token TEXT NOT NULL,
          public_token TEXT,
          login_time TIMESTAMP,
          expires_at TIMESTAMP,
          generation_method VARCHAR(50) DEFAULT 'manual',
          is_valid BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kite_tokens_user_id ON kite_tokens(user_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kite_tokens_is_valid ON kite_tokens(is_valid);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kite_tokens_expires_at ON kite_tokens(expires_at);`);
      logger.info('✅ kite_tokens table ready');

      // 3. Create token_generation_logs table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS token_generation_logs (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          attempt_number INTEGER NOT NULL,
          status VARCHAR(50) NOT NULL,
          error_message TEXT,
          execution_time_ms INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_generation_logs_user_id ON token_generation_logs(user_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_generation_logs_created_at ON token_generation_logs(created_at);`);
      logger.info('✅ token_generation_logs table ready');

      // 4. Create stored_tokens table (basic structure first)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stored_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          broker_connection_id VARCHAR(255) NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMP,
          mode VARCHAR(50) DEFAULT 'manual',
          last_refresh_at TIMESTAMP,
          refresh_status VARCHAR(50) DEFAULT 'pending',
          error_reason TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      
      // Add/repair columns if they don't exist
      try {
        const columnCheck = await pool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'stored_tokens' 
          AND column_name IN ('broker_connection_id', 'last_refresh_at', 'refresh_status', 'error_reason')
        `);
        
        const existingColumns = columnCheck.rows.map(r => r.column_name);

        if (!existingColumns.includes('broker_connection_id')) {
          try {
            await pool.query(`ALTER TABLE stored_tokens ADD COLUMN broker_connection_id VARCHAR(255);`);
            logger.info('✅ Added broker_connection_id column to stored_tokens');
          } catch (addError) {
            if (!addError.message.includes('already exists') && !addError.message.includes('duplicate')) {
              logger.warn(`⚠️ Could not add broker_connection_id: ${addError.message}`);
            }
          }
        }
        
        if (!existingColumns.includes('last_refresh_at')) {
          try {
            await pool.query(`ALTER TABLE stored_tokens ADD COLUMN last_refresh_at TIMESTAMP;`);
            logger.info('✅ Added last_refresh_at column to stored_tokens');
          } catch (addError) {
            if (!addError.message.includes('already exists') && !addError.message.includes('duplicate')) {
              logger.warn(`⚠️ Could not add last_refresh_at: ${addError.message}`);
            }
          }
        }
        
        if (!existingColumns.includes('refresh_status')) {
          try {
            await pool.query(`ALTER TABLE stored_tokens ADD COLUMN refresh_status VARCHAR(50) DEFAULT 'pending';`);
            logger.info('✅ Added refresh_status column to stored_tokens');
          } catch (addError) {
            if (!addError.message.includes('already exists') && !addError.message.includes('duplicate')) {
              logger.warn(`⚠️ Could not add refresh_status: ${addError.message}`);
            }
          }
        }
        
        if (!existingColumns.includes('error_reason')) {
          try {
            await pool.query(`ALTER TABLE stored_tokens ADD COLUMN error_reason TEXT;`);
            logger.info('✅ Added error_reason column to stored_tokens');
          } catch (addError) {
            if (!addError.message.includes('already exists') && !addError.message.includes('duplicate')) {
              logger.warn(`⚠️ Could not add error_reason: ${addError.message}`);
            }
          }
        }
      } catch (colError) {
        logger.warn(`⚠️ Could not check/add columns: ${colError.message}`);
      }

      try {
        await pool.query(`
          UPDATE stored_tokens
          SET broker_connection_id = COALESCE(broker_connection_id, 'legacy:' || user_id || ':ZERODHA:default')
          WHERE broker_connection_id IS NULL
        `);
        await pool.query(`DROP INDEX IF EXISTS stored_tokens_user_id_key;`);
        await pool.query(`DROP INDEX IF EXISTS idx_stored_tokens_user_id_key;`);
        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS stored_tokens_broker_connection_id_key
          ON stored_tokens(broker_connection_id)
        `);
        await pool.query(`
          ALTER TABLE stored_tokens
          ALTER COLUMN broker_connection_id SET NOT NULL
        `);
      } catch (rekeyError) {
        logger.warn(`⚠️ Could not fully re-key stored_tokens to broker_connection_id: ${rekeyError.message}`);
      }
      
      // Create indexes
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_user_id ON stored_tokens(user_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_broker_connection_id ON stored_tokens(broker_connection_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_updated_at ON stored_tokens(updated_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_expires_at ON stored_tokens(expires_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_refresh_status ON stored_tokens(refresh_status);`);
      
      logger.info('✅ stored_tokens table ready with refresh tracking');

      // 5. Create update trigger function
      await pool.query(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ language 'plpgsql';
      `);
      logger.info('✅ Trigger function ready');

      return { success: true };

    } catch (error) {
      logger.error('❌ Essential migrations failed:', error.message);
      logger.error('❌ Migration error stack:', error.stack);
      return { success: false, error: error.message };
    } finally {
      // Only close pool if we created it (not if it's shared)
      if (shouldClosePool && pool) {
        try {
          await pool.end();
          logger.info('✅ Migration pool closed');
        } catch (closeError) {
          logger.warn(`⚠️ Error closing migration pool: ${closeError.message}`);
        }
      }
    }
  }
  }

module.exports = new MigrationRunner();
