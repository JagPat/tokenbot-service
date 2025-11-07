const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? {
      rejectUnauthorized: false
    } : false,
  });

  try {
    console.log('🔄 Running migration: Fix kite_tokens updated_at column...');
    
    // Read migration SQL file
    const migrationPath = path.join(__dirname, 'migrations', '002_fix_kite_tokens_trigger.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute migration
    await pool.query(migrationSQL);
    
    console.log('✅ Migration 002 completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration 002 failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();

