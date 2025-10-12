const express = require('express');
const router = express.Router();
const db = require('../config/database');
const encryptor = require('../services/encryptor');
const { authenticateUser } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/credentials
 * Save/update user credentials
 */
router.post('/', authenticateUser, async (req, res, next) => {
  try {
    const { user_id } = req.user;
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

module.exports = router;

