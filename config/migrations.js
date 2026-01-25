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
  async runEssentialMigrations() {
    if (!process.env.DATABASE_URL) {
      logger.warn('⚠️ DATABASE_URL not set, skipping essential migrations');
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
      logger.info('🔄 Running essential database migrations (inline)...');

      // 1. Create kite_user_credentials table
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

      // 4. Create stored_tokens table with enhanced columns for refresh tracking
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stored_tokens (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMP NOT NULL,
          mode VARCHAR(50) DEFAULT 'manual',
          last_refresh_at TIMESTAMP,
          refresh_status VARCHAR(50) DEFAULT 'pending',
          error_reason TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_user_id ON stored_tokens(user_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_updated_at ON stored_tokens(updated_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_expires_at ON stored_tokens(expires_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_stored_tokens_refresh_status ON stored_tokens(refresh_status);`);
      
      // Add new columns if they don't exist (for existing tables)
      try {
        await pool.query(`ALTER TABLE stored_tokens ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMP;`);
        await pool.query(`ALTER TABLE stored_tokens ADD COLUMN IF NOT EXISTS refresh_status VARCHAR(50) DEFAULT 'pending';`);
        await pool.query(`ALTER TABLE stored_tokens ADD COLUMN IF NOT EXISTS error_reason TEXT;`);
      } catch (alterError) {
        // Ignore if columns already exist
        if (!alterError.message.includes('duplicate column')) {
          logger.warn(`⚠️ Could not add refresh tracking columns: ${alterError.message}`);
        }
      }
      
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
      return { success: false, error: error.message };
    } finally {
      await pool.end();
    }
  }
}

module.exports = new MigrationRunner();
