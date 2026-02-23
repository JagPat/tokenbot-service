const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
    const res = await pool.query('SELECT id, user_id, kite_user_id, is_active FROM kite_user_credentials;');
    console.log(JSON.stringify(res.rows, null, 2));
    pool.end();
}
check();
