const express = require('express');
const router = express.Router();
const db = require('../config/database');
const encryptor = require('../services/encryptor');
const { authenticateUser } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/credentials
 * Save/update user credentials (supports both user and service authentication)
 */
router.post('/', async (req, res, next) => {
  try {
    // Support both user authentication and service-to-service calls
    let user_id = null;
    
    // Check if authenticated user (user endpoint)
    if (req.user && req.user.user_id) {
      user_id = req.user.user_id;
      logger.info(`📝 User credential save requested for user: ${user_id}`);
    } 
    // Check if service-to-service call (backend endpoint)
    else if (req.body.user_id || req.query.user_id) {
      // Verify service API key for service-to-service calls
      const serviceApiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      const expectedApiKey = process.env.SERVICE_API_KEY || process.env.TOKENBOT_API_KEY;
      
      if (!serviceApiKey || (expectedApiKey && serviceApiKey !== expectedApiKey)) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized service call'
        });
      }
      
      user_id = req.body.user_id || req.query.user_id;
      logger.info(`📝 Service credential sync requested for user: ${user_id}`);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Missing user_id or authentication'
      });
    }
    
    const { kite_user_id, password, totp_secret, api_key, api_secret, auto_refresh_enabled } = req.body;
    
    logger.info(`📝 Saving credentials for user: ${user_id}`);
    
    // Validate required fields
    if (!kite_user_id || !password || !totp_secret || !api_key || !api_secret) {
      return res.status(400).json({ 
        success: false, 
        error: 'All credential fields are required',
        required: ['kite_user_id', 'password', 'totp_secret', 'api_key', 'api_secret']
      });
    }
    
    // Validate TOTP secret format
    if (totp_secret.length < 16) {
      return res.status(400).json({
        success: false,
        error: 'Invalid TOTP secret. Must be at least 16 characters'
      });
    }

    // Encrypt sensitive data
    const encrypted = {
      password: encryptor.encrypt(password),
      totp_secret: encryptor.encrypt(totp_secret),
      api_key: encryptor.encrypt(api_key),
      api_secret: encryptor.encrypt(api_secret)
    };
    
    // Upsert credentials
    const result = await db.query(`
      INSERT INTO kite_user_credentials (
        user_id, kite_user_id, encrypted_password, encrypted_totp_secret,
        encrypted_api_key, encrypted_api_secret, auto_refresh_enabled
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id)
      DO UPDATE SET
        kite_user_id = $2,
        encrypted_password = $3,
        encrypted_totp_secret = $4,
        encrypted_api_key = $5,
        encrypted_api_secret = $6,
        auto_refresh_enabled = $7,
        updated_at = NOW()
      RETURNING id, user_id, kite_user_id, is_active, auto_refresh_enabled
    `, [
      user_id, kite_user_id, encrypted.password, encrypted.totp_secret,
      encrypted.api_key, encrypted.api_secret, auto_refresh_enabled !== false
    ]);

    logger.info(`✅ Credentials saved for user: ${user_id}`);
    
    res.json({ 
      success: true, 
      message: 'Credentials saved successfully',
      data: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Error saving credentials:', error);
    next(error);
  }
});

/**
 * GET /api/credentials/status
 * Get credential status (without sensitive data)
 */
router.get('/status', authenticateUser, async (req, res, next) => {
  try {
    const { user_id } = req.user;
    
    const result = await db.query(`
      SELECT 
        kite_user_id, 
        is_active, 
        auto_refresh_enabled, 
        last_used,
        created_at,
        updated_at
      FROM kite_user_credentials 
      WHERE user_id = $1
    `, [user_id]);
    
    if (result.rows.length === 0) {
      return res.json({ 
        success: true, 
        data: { 
          configured: false,
          message: 'No credentials configured' 
        } 
      });
    }
    
    res.json({ 
      success: true, 
      data: { 
        configured: true, 
        ...result.rows[0] 
      } 
    });
    
  } catch (error) {
    logger.error('Error fetching credential status:', error);
    next(error);
  }
});

/**
 * DELETE /api/credentials
 * Delete credentials
 */
router.delete('/', authenticateUser, async (req, res, next) => {
  try {
    const { user_id } = req.user;
    
    logger.info(`🗑️ Deleting credentials for user: ${user_id}`);
    
    const result = await db.query(
      'DELETE FROM kite_user_credentials WHERE user_id = $1 RETURNING user_id',
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No credentials found to delete'
      });
    }
    
    logger.info(`✅ Credentials deleted for user: ${user_id}`);
    
    res.json({ 
      success: true, 
      message: 'Credentials deleted successfully' 
    });
    
  } catch (error) {
    logger.error('Error deleting credentials:', error);
    next(error);
  }
});

/**
 * PATCH /api/credentials/toggle
 * Toggle auto-refresh
 */
router.patch('/toggle', authenticateUser, async (req, res, next) => {
  try {
    const { user_id } = req.user;
    const { auto_refresh_enabled } = req.body;

    if (typeof auto_refresh_enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'auto_refresh_enabled must be a boolean'
      });
    }

    const result = await db.query(`
      UPDATE kite_user_credentials
      SET auto_refresh_enabled = $1, updated_at = NOW()
      WHERE user_id = $2
      RETURNING user_id, auto_refresh_enabled
    `, [auto_refresh_enabled, user_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No credentials found'
      });
    }

    logger.info(`✅ Auto-refresh toggled to ${auto_refresh_enabled} for user: ${user_id}`);

    res.json({
      success: true,
      message: `Auto-refresh ${auto_refresh_enabled ? 'enabled' : 'disabled'}`,
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Error toggling auto-refresh:', error);
    next(error);
  }
});

/**
 * PATCH /api/credentials/api-key
 * Update only the API key and/or API secret (partial update)
 * Allows web app to sync API key without needing all credentials
 * Service-to-service authentication only
 */
router.patch('/api-key', async (req, res, next) => {
  // Verify table exists before attempting query
  try {
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'kite_user_credentials'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      logger.error('❌ CRITICAL: kite_user_credentials table does not exist!');
      logger.error('   This indicates migrations did not run or database connection issue');
      return res.status(500).json({
        success: false,
        error: 'Database schema incomplete: kite_user_credentials table missing. Please check TokenBot logs for migration errors.'
      });
    }
  } catch (checkError) {
    logger.error('❌ Error checking table existence:', checkError.message);
    return res.status(500).json({
      success: false,
      error: 'Database connection error. Please check TokenBot configuration.'
    });
  }
  try {
    // Service-to-service authentication (no user auth required)
    const serviceApiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedApiKey = process.env.SERVICE_API_KEY || process.env.TOKENBOT_API_KEY;
    
    if (!serviceApiKey || (expectedApiKey && serviceApiKey !== expectedApiKey)) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized service call'
      });
    }

    const { user_id = 'default', api_key, api_secret } = req.body;
    
    if (!api_key) {
      return res.status(400).json({
        success: false,
        error: 'api_key is required'
      });
    }

    logger.info(`🔄 API key sync requested for user: ${user_id}`);

    // Check if credentials exist
    const existing = await db.query(
      `SELECT user_id FROM kite_user_credentials WHERE user_id = $1`,
      [user_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Credentials not found. Please create full credentials first via POST /api/credentials'
      });
    }

    // Encrypt API key (and optionally API secret)
    const encrypted = {
      api_key: encryptor.encrypt(api_key),
      ...(api_secret && { api_secret: encryptor.encrypt(api_secret) })
    };

    // Build update query dynamically
    const updateFields = ['encrypted_api_key = $1'];
    const updateValues = [encrypted.api_key];
    let paramIndex = 2;

    if (api_secret) {
      updateFields.push(`encrypted_api_secret = $${paramIndex}`);
      updateValues.push(encrypted.api_secret);
      paramIndex++;
    }

    updateFields.push('updated_at = NOW()');
    updateValues.push(user_id);

    const result = await db.query(`
      UPDATE kite_user_credentials
      SET ${updateFields.join(', ')}
      WHERE user_id = $${paramIndex}
      RETURNING user_id, kite_user_id, is_active
    `, updateValues);

    // Invalidate existing tokens since API key changed
    await db.query(`DELETE FROM stored_tokens WHERE user_id = $1`, [user_id]);
    logger.info(`🗑️ Invalidated tokens after API key update for user: ${user_id}`);

    logger.info(`✅ API key updated successfully for user: ${user_id}`);
    
    res.json({
      success: true,
      message: 'API key updated successfully. Tokens have been invalidated and will be regenerated.',
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Error updating API key:', error);
    next(error);
  }
});

module.exports = router;

