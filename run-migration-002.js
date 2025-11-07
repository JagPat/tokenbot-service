const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function runMigration() {
  // Smart SSL configuration: only use SSL if DATABASE_URL explicitly requires it
  // Use the same logic as config/database.js
  const connectionString = process.env.DATABASE_URL || '';
  const isRailwayInternal = connectionString.includes('railway.internal');
  const hasSSLMode = connectionString.includes('sslmode=');
  
  // Extract sslmode from connection string if present
  let sslConfig = false;
  if (hasSSLMode) {
    const sslModeMatch = connectionString.match(/sslmode=([^&]+)/);
    const sslMode = sslModeMatch ? sslModeMatch[1] : '';
    if (sslMode === 'require' || sslMode === 'prefer') {
      sslConfig = { rejectUnauthorized: false };
    }
  } else if (isRailwayInternal) {
    // Railway internal URLs typically don't need SSL
    sslConfig = false;
  } else if (process.env.NODE_ENV === 'production' && !connectionString.includes('railway.internal')) {
    // For external production connections, disable SSL if not explicitly required
    sslConfig = false;
  }
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
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

