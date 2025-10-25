const express = require('express');
const router = express.Router();
const tokenManager = require('../services/tokenManager');
const { authenticateUser, authenticateService } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/tokens/refresh
 * Manual token refresh
 */
router.post('/refresh', authenticateUser, async (req, res, next) => {
  try {
    const { user_id } = req.user;
    
    logger.info(`🔄 Manual token refresh requested for user: ${user_id}`);
    
    const tokenData = await tokenManager.refreshTokenForUser(user_id);
    
    res.json({ 
      success: true, 
      message: 'Token refreshed successfully',
      data: {
        expires_at: tokenData.expires_at,
        login_time: tokenData.login_time,
        execution_time_ms: tokenData.execution_time_ms
      }
    });
    
  } catch (error) {
    logger.error('Error refreshing token:', error);
    
    // Provide user-friendly error messages
    let errorMessage = error.message;
    
    if (error.message.includes('No active credentials')) {
      errorMessage = 'Please configure your broker credentials first';
    } else if (error.message.includes('Request token not found')) {
      errorMessage = 'Authentication failed. Please check your credentials';
    } else if (error.message.includes('TOTP')) {
      errorMessage = 'TOTP verification failed. Please check your TOTP secret';
    }
    
    res.status(500).json({ 
      success: false, 
      error: errorMessage 
    });
  }
});

/**
 * GET /api/tokens/status
 * Get current token status
 */
router.get('/status', authenticateUser, async (req, res, next) => {
  try {
    const { user_id } = req.user;
    
    const token = await tokenManager.getValidToken(user_id);
    
    if (!token) {
      return res.json({ 
        success: true, 
        data: { 
          has_token: false,
          message: 'No valid token found. Please refresh token.'
        } 
      });
    }

    // Calculate time until expiry
    const now = new Date();
    const expiresAt = new Date(token.expires_at);
    const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
    
    res.json({ 
      success: true, 
      data: {
        has_token: true,
        expires_at: token.expires_at,
        login_time: token.login_time,
        is_valid: token.is_valid,
        hours_until_expiry: Math.max(0, hoursUntilExpiry).toFixed(2),
        expires_soon: hoursUntilExpiry < 2
      }
    });
    
  } catch (error) {
    logger.error('Error fetching token status:', error);
    next(error);
  }
});

/**
 * GET /api/tokens/:userId (Service-to-service only)
 * Get valid token for a user (for AI trading backend)
 */
router.get('/:userId', authenticateService, async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    logger.info(`🔍 Token requested for user: ${userId}`);
    
    const token = await tokenManager.getCurrentToken(userId);
    
    if (!token) {
      return res.status(404).json({
        success: false,
        error: 'No token found for user'
      });
    }

    // Check if token expires soon
    const now = new Date();
    const expiresAt = new Date(token.expires_at);
    const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

    if (hoursUntilExpiry < 1) {
      logger.warn(`⚠️ Token for user ${userId} expires in less than 1 hour`);
    }

    res.json({
      success: true,
      data: {
        access_token: token.access_token,
        expires_at: token.expires_at,
        hours_until_expiry: Math.max(0, hoursUntilExpiry).toFixed(2)
      }
    });
    
  } catch (error) {
    logger.error('Error fetching token:', error);
    next(error);
  }
});

/**
 * GET /api/tokens/logs/:userId (User or Service)
 * Get token generation logs
 */
router.get('/logs/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;

    // Check authentication - either user accessing their own logs or service
    if (req.user && req.user.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
    }

    const logs = await tokenManager.getTokenLogs(userId, parseInt(limit));

    res.json({
      success: true,
      data: logs
    });
  } catch (error) {
    logger.error('Error fetching token logs:', error);
    next(error);
  }
});

/**
 * POST /api/tokens/store
 * Store token data for a user
 */
router.post('/store', authenticateService, async (req, res, next) => {
  try {
    const { user_id, access_token, refresh_token, expires_at, mode } = req.body;
    
    logger.info(`💾 Storing token data for user: ${user_id}`);
    
    // Validate required fields
    if (!user_id || !access_token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and access_token'
      });
    }
    
    // Store token data
    const result = await tokenManager.storeTokenData({
      user_id,
      access_token,
      refresh_token,
      expires_at,
      mode: mode || 'manual'
    });
    
    res.json({
      success: true,
      message: 'Token data stored successfully',
      data: result
    });
    
  } catch (error) {
    logger.error('Error storing token data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/tokens/current
 * Get current token for a user
 */
router.get('/current', authenticateService, async (req, res, next) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: user_id'
      });
    }
    
    logger.info(`🔍 Getting current token for user: ${user_id}`);
    
    const tokenData = await tokenManager.getCurrentToken(user_id);
    
    if (!tokenData) {
      return res.status(404).json({
        success: false,
        error: 'No token found for user'
      });
    }
    
    res.json({
      success: true,
      data: tokenData
    });
    
  } catch (error) {
    logger.error('Error getting current token:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

