const { Pool } = require('pg');
require('dotenv').config();

class Database {
  constructor() {
    if (!process.env.DATABASE_URL) {
      console.warn('⚠️ DATABASE_URL not set, database operations will fail');
      this.pool = null;
      return;
    }

    try {
      // Smart SSL configuration: only use SSL if DATABASE_URL explicitly requires it
      // Check if connection string contains sslmode or if it's Railway internal URL
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
        // For external production connections, try SSL but allow fallback
        // Set sslmode=prefer in connection string to enable this
        sslConfig = false; // Disable SSL for now since new DB doesn't support it
      }

      // Extract database info for logging
      let dbInfo = { host: 'unknown', port: 'unknown', database: 'unknown' };
      try {
        const url = new URL(process.env.DATABASE_URL.replace(/^postgresql:\/\//, 'http://'));
        dbInfo = {
          host: url.hostname || 'unknown',
          port: url.port || '5432',
          database: url.pathname?.replace('/', '') || 'unknown'
        };
      } catch (e) {
        // Ignore parsing errors
      }
      
      console.log(`📍 [Database] Connecting to: ${dbInfo.host}:${dbInfo.port}/${dbInfo.database}`);
      
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: sslConfig,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });
      
      // Verify connection and log database name
      this.pool.on('connect', async (client) => {
        try {
          const result = await client.query('SELECT current_database(), current_user');
          console.log(`✅ [Database] Connected to: ${result.rows[0].current_database} as ${result.rows[0].current_user}`);
        } catch (e) {
          // Ignore errors during connection logging
        }
      });

      this.pool.on('error', (err) => {
        console.error('❌ Unexpected database pool error:', err);
      });

      this.pool.on('connect', () => {
        console.log('✅ New database connection established');
      });
    } catch (error) {
      console.error('❌ Failed to create database pool:', error);
      this.pool = null;
    }
  }

  async query(text, params) {
    if (!this.pool) {
      throw new Error('Database pool not initialized - check DATABASE_URL');
    }
    
    const start = Date.now();
    try {
      const res = await this.pool.query(text, params);
      const duration = Date.now() - start;
      console.log(`📊 Query executed in ${duration}ms`);
      return res;
    } catch (error) {
      console.error('❌ Database query error:', error);
      throw error;
    }
  }

  async getClient() {
    if (!this.pool) {
      throw new Error('Database pool not initialized - check DATABASE_URL');
    }
    return await this.pool.connect();
  }

  async end() {
    if (this.pool) {
      await this.pool.end();
      console.log('🔌 Database pool closed');
    }
  }
}

module.exports = new Database();

