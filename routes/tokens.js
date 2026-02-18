const express = require('express');
const router = express.Router();
const tokenManager = require('../services/tokenManager');
const { authenticateUser, authenticateService } = require('../middleware/auth');
const logger = require('../utils/logger');

function isTransientBrowserFailure(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const statusCode = Number(error?.statusCode || 0);

  if (statusCode === 503) return true;

  if ([
    'BROWSER_POOL_UNAVAILABLE',
    'BROWSER_POOL_EXHAUSTED',
    'BROWSER_POOL_TIMEOUT'
  ].includes(code)) {
    return true;
  }

  return [
    'browser unavailable',
    'browser pool unavailable',
    'circuit breaker',
    'target closed',
    'detached frame',
    'protocol error (target.createtarget)',
    'navigation failed',
    'session closed'
  ].some((needle) => message.includes(needle));
}

/**
 * POST /api/tokens/refresh
 * Token refresh (supports both user and service authentication)
 */
router.post('/refresh', async (req, res, next) => {
  try {
    // Support both user authentication and service-to-service calls
    let user_id = null;

    // Check if authenticated user (user endpoint)
    if (req.user && req.user.user_id) {
      user_id = req.user.user_id;
      logger.info(`🔄 User token refresh requested for user: ${user_id}`);
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
      logger.info(`🔄 Service token refresh requested for user: ${user_id}`);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Missing user_id'
      });
    }

    const brokerType = String(req.body.brokerType || req.query.brokerType || 'ZERODHA').toUpperCase();
    const accountId = req.body.accountId || req.query.accountId;
    const connectionId = req.body.connectionId || req.query.connectionId;

    const tokenData = await tokenManager.refreshTokenForUser(user_id, brokerType, accountId, connectionId);

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        access_token: tokenData.access_token,
        expires_at: tokenData.expires_at,
        login_time: tokenData.login_time,
        execution_time_ms: tokenData.execution_time_ms
      }
    });

  } catch (error) {
    logger.error('Error refreshing token:', error);

    // Provide user-friendly error messages
    let errorMessage = error.message;
    let statusCode = 500;
    let retryAfterMs = error.retryAfterMs || null;

    if (error.message.includes('No active credentials')) {
      errorMessage = 'Please configure your broker credentials first';
      statusCode = 404;
    } else if (error.message.includes('incomplete') || error.message.includes('incomplete')) {
      errorMessage = 'Credentials incomplete. API key is set, but full credentials (kite_user_id, password, totp_secret) are required for token generation. Please use POST /api/credentials to set them up.';
      statusCode = 400;
    } else if (error.message.includes('Request token not found')) {
      errorMessage = 'Authentication failed. Please check your credentials';
    } else if (error.message.includes('TOTP')) {
      errorMessage = 'TOTP verification failed. Please check your TOTP secret';
    } else if (isTransientBrowserFailure(error)) {
      errorMessage = 'Token refresh temporarily unavailable: browser pool is recovering';
      statusCode = 503;
      retryAfterMs = retryAfterMs || error.retryAfterMs || 30000;
      if (retryAfterMs) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil(retryAfterMs / 1000)));
      }
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      retry_after_ms: retryAfterMs,
      hint: error.message.includes('incomplete') ? 'Use POST /api/credentials with all required fields (kite_user_id, password, totp_secret, api_key, api_secret) to complete credential setup.' : undefined
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
 * GET /api/tokens/current
 * Get current token for a user
 */
router.get('/current', authenticateService, async (req, res, next) => {
  try {
    const { user_id, brokerType, accountId, connectionId } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: user_id'
      });
    }

    logger.info(`🔍 Getting current token for user: ${user_id} (Broker: ${brokerType || 'Default'})`);

    const tokenData = await tokenManager.getCurrentToken(user_id, String(brokerType || 'ZERODHA').toUpperCase(), accountId, connectionId);

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
    const { user_id, access_token, refresh_token, expires_at, mode, brokerType, accountId } = req.body;

    logger.info(`💾 Storing token data for user: ${user_id} (${brokerType || 'ZERODHA'})`);

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
      mode: mode || 'manual',
      brokerType,
      accountId
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

module.exports = router;
