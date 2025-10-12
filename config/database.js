const { Pool } = require('pg');
require('dotenv').config();

class Database {
  constructor() {
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
  }

  async query(text, params) {
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
    return await this.pool.query();
  }

  async end() {
    await this.pool.end();
    console.log('🔌 Database pool closed');
  }
}

module.exports = new Database();

