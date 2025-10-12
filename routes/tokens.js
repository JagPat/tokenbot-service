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
    
    const token = await tokenManager.getValidToken(userId);
    
    if (!token) {
      return res.status(404).json({
        success: false,
        error: 'No valid token found',
        message: 'User needs to refresh token or configure credentials'
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

module.exports = router;

