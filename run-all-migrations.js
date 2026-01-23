const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/**
 * Run all database migrations for TokenBot service
 * This script ensures all required tables are created
 */
async function runAllMigrations() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  
  // Determine SSL config based on connection string
  const isRailwayInternal = connectionString.includes('railway.internal');
  const hasSSLMode = connectionString.includes('sslmode=');
  
  let sslConfig = false;
  if (hasSSLMode) {
    const sslModeMatch = connectionString.match(/sslmode=([^&]+)/);
    const sslMode = sslModeMatch ? sslModeMatch[1] : '';
    if (sslMode === 'require' || sslMode === 'prefer') {
      sslConfig = { rejectUnauthorized: false };
    }
  } else if (!isRailwayInternal && connectionString.includes('railway')) {
    sslConfig = { rejectUnauthorized: false };
  }

  const pool = new Pool({
    connectionString,
    ssl: sslConfig,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('🔄 Starting database migrations...\n');

    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection established\n');

    // Create migrations tracking table
    console.log('📋 Creating migrations tracking table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Migrations tracking table ready\n');

    // Get already executed migrations
    let executedMigrations = [];
    try {
      const result = await pool.query('SELECT name FROM _migrations ORDER BY id');
      executedMigrations = result.rows.map(row => row.name);
      console.log(`📋 Found ${executedMigrations.length} previously executed migrations\n`);
    } catch (err) {
      console.log('📋 No previous migrations found (this is normal for first run)\n');
    }

    // Get all migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`📁 Found ${migrationFiles.length} migration file(s)\n`);

    // Run each migration
    let executed = 0;
    for (const file of migrationFiles) {
      if (executedMigrations.includes(file)) {
        console.log(`⏭️  Skipping already executed: ${file}`);
        continue;
      }

      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');

      console.log(`🔄 Running migration: ${file}...`);
      
      try {
        await pool.query(sql);
        await pool.query(
          'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [file]
        );
        executed++;
        console.log(`✅ Migration completed: ${file}\n`);
      } catch (migrationError) {
        // Handle "already exists" errors gracefully
        if (migrationError.code === '42P07' || // duplicate_table
            migrationError.code === '42710' || // duplicate_object
            migrationError.message.includes('already exists')) {
          console.log(`⚠️  Migration ${file} skipped (object already exists)`);
          await pool.query(
            'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
            [file]
          );
          executed++;
        } else {
          console.error(`❌ Migration ${file} failed:`, migrationError.message);
          throw migrationError;
        }
      }
    }

    if (executed > 0) {
      console.log(`\n✅ Successfully executed ${executed} new migration(s)`);
    } else {
      console.log('\n✅ Database schema is up-to-date (no new migrations)');
    }

    // Verify all required tables exist
    console.log('\n🔍 Verifying required tables...');
    const requiredTables = [
      'kite_user_credentials',
      'kite_tokens',
      'token_generation_logs',
      'stored_tokens'
    ];

    for (const tableName of requiredTables) {
      const result = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        );
      `, [tableName]);

      if (result.rows[0].exists) {
        console.log(`  ✅ Table '${tableName}' exists`);
      } else {
        console.error(`  ❌ Table '${tableName}' is MISSING`);
      }
    }

    console.log('\n✅ All migrations completed successfully!');
    return { success: true, executed };

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('Stack:', error.stack);
    return { success: false, error: error.message };
  } finally {
    await pool.end();
  }
}

// Run migrations
runAllMigrations()
  .then((result) => {
    if (result.success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
