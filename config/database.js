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
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? {
          rejectUnauthorized: false
        } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
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

