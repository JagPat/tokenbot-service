const { Pool } = require('pg');
require('dotenv').config();

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? {
      rejectUnauthorized: false
    } : false,
  });

  try {
    console.log('🔄 Running migration: Create stored_tokens table...');
    
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

    await pool.query(`
      ALTER TABLE stored_tokens
      ADD COLUMN IF NOT EXISTS broker_connection_id VARCHAR(255);
    `);
    await pool.query(`
      UPDATE stored_tokens
      SET broker_connection_id = COALESCE(broker_connection_id, 'legacy:' || user_id || ':ZERODHA:default')
      WHERE broker_connection_id IS NULL;
    `);
    await pool.query(`DROP INDEX IF EXISTS stored_tokens_user_id_key;`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS stored_tokens_broker_connection_id_key
      ON stored_tokens(broker_connection_id);
    `);
    await pool.query(`
      ALTER TABLE stored_tokens
      ALTER COLUMN broker_connection_id SET NOT NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_stored_tokens_user_id ON stored_tokens(user_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_stored_tokens_broker_connection_id ON stored_tokens(broker_connection_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_stored_tokens_updated_at ON stored_tokens(updated_at);
    `);

    console.log('✅ Migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
