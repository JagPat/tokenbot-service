const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const tokenManager = require('../services/tokenManager');
const { authenticateUser, authenticateService } = require('../middleware/auth');
const logger = require('../utils/logger');
const { assertProductionSafeUserId, normalizeUserId } = require('../utils/userIdPolicy');

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

function resolveCorrelationId(req) {
  const headerCorrelationId = req.headers['x-correlation-id'];
  if (headerCorrelationId && typeof headerCorrelationId === 'string' && headerCorrelationId.trim()) {
    return headerCorrelationId.trim();
  }
  return randomUUID();
}

function resolveConnectionId(req) {
  const direct =
    req.body?.brokerConnectionId ||
    req.body?.connectionId ||
    req.query?.brokerConnectionId ||
    req.query?.connectionId ||
    null;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
}

/**
 * POST /api/tokens/refresh
 * Token refresh (supports both user and service authentication)
 */
router.post('/refresh', async (req, res, next) => {
  const correlationId = resolveCorrelationId(req);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Support both user authentication and service-to-service calls
    let user_id = null;
    const connectionId = resolveConnectionId(req);
    const brokerType = String(req.body.brokerType || req.query.brokerType || 'ZERODHA').toUpperCase();
    const accountId = req.body.accountId || req.query.accountId;

    // Check if authenticated user (user endpoint)
    if (req.user && req.user.user_id) {
      user_id = req.user.user_id;
      logger.info(`🔄 User token refresh requested for user: ${user_id} (connection: ${connectionId || 'none'})`);
    }
    // Check if service-to-service call (backend endpoint)
    else if (req.body.user_id || req.query.user_id || connectionId) {
      // Verify service API key for service-to-service calls
      const serviceApiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      const expectedApiKey = process.env.SERVICE_API_KEY || process.env.TOKENBOT_API_KEY;

      if (!expectedApiKey) {
        return res.status(500).json({
          success: false,
          error: 'Service auth is not configured on TokenBot',
          correlationId
        });
      }

      if (!serviceApiKey || serviceApiKey !== expectedApiKey) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized service call',
          correlationId
        });
      }

      user_id = req.body.user_id || req.query.user_id || null;
      logger.info(`🔄 Service token refresh requested for user: ${user_id || 'resolved-via-connection'} (connection: ${connectionId || 'none'})`);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Missing brokerConnectionId or user_id',
        correlationId
      });
    }

    if (user_id) {
      user_id = assertProductionSafeUserId(user_id, 'refresh');
    }

    const tokenData = await tokenManager.refreshTokenForUser({
      userId: user_id,
      brokerType,
      accountId,
      brokerConnectionId: connectionId,
      correlationId
    });

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      correlationId,
      data: {
        access_token: tokenData.access_token,
        expires_at: tokenData.expires_at,
        login_time: tokenData.login_time,
        execution_time_ms: tokenData.execution_time_ms,
        broker_connection_id: tokenData.broker_connection_id || connectionId || null
      }
    });

  } catch (error) {
    logger.error(`Error refreshing token [ref: ${correlationId}]:`, error);

    // Provide user-friendly error messages
    let errorMessage = error.message;
    let statusCode = error.statusCode || 500;
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
    } else if (error.code === 'INVALID_DEFAULT_USER') {
      statusCode = 400;
      retryAfterMs = null;
    } else if (error.code === 'BROKER_CONNECTION_AMBIGUOUS') {
      statusCode = 409;
      retryAfterMs = null;
    } else if (error.code === 'BROKER_CONNECTION_REQUIRED') {
      statusCode = 400;
      retryAfterMs = null;
    } else if (error.code === 'BROKER_CONNECTION_NOT_FOUND') {
      statusCode = 404;
      retryAfterMs = null;
    } else if (error.code === 'BROKER_CONNECTION_USER_MISMATCH') {
      statusCode = 403;
      retryAfterMs = null;
    }

    if (statusCode === 503 && retryAfterMs) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(retryAfterMs / 1000)));
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      correlationId,
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
  const correlationId = resolveCorrelationId(req);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { brokerType, accountId } = req.query;
    const connectionId = resolveConnectionId(req);
    const user_id = normalizeUserId(req.query.user_id);

    if (!user_id && !connectionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: brokerConnectionId or user_id',
        correlationId
      });
    }

    const safeUserId = user_id ? assertProductionSafeUserId(user_id, 'lookup') : null;

    logger.info(`🔍 Getting current token for user: ${safeUserId || 'resolved-via-connection'} (Broker: ${brokerType || 'Default'}, connection: ${connectionId || 'none'})`);

    const tokenData = await tokenManager.getCurrentToken({
      userId: safeUserId,
      brokerType: String(brokerType || 'ZERODHA').toUpperCase(),
      accountId,
      brokerConnectionId: connectionId
    });

    if (!tokenData) {
      return res.status(404).json({
        success: false,
        error: 'No token found for user/connection',
        correlationId
      });
    }

    res.json({
      success: true,
      correlationId,
      data: tokenData
    });

  } catch (error) {
    logger.error(`Error getting current token [ref: ${correlationId}]:`, error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      correlationId
    });
  }
});

/**
 * GET /api/tokens/logs/:userId (User or Service)
 * Get token generation logs
 */
router.get('/logs/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const safeUserId = assertProductionSafeUserId(userId, 'logs');
    const { limit = 10 } = req.query;

    // Check authentication - either user accessing their own logs or service
    if (req.user && req.user.user_id !== safeUserId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
    }

    const logs = await tokenManager.getTokenLogs(safeUserId, parseInt(limit));

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
 * GET /api/tokens/:userId (Service-to-service only)
 * Get valid token for a user (for AI trading backend)
 */
router.get('/:userId', authenticateService, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const safeUserId = assertProductionSafeUserId(userId, 'lookup');

    logger.info(`🔍 Token requested for user: ${safeUserId}`);

    const token = await tokenManager.getCurrentToken(safeUserId);

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
      logger.warn(`⚠️ Token for user ${safeUserId} expires in less than 1 hour`);
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
 * POST /api/tokens/store
 * Store token data for a user
 */
router.post('/store', authenticateService, async (req, res, next) => {
  const correlationId = resolveCorrelationId(req);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { access_token, refresh_token, expires_at, mode, brokerType, accountId } = req.body;
    const connectionId =
      req.body?.brokerConnectionId ||
      req.body?.connectionId ||
      null;
    const user_id = assertProductionSafeUserId(req.body.user_id, 'store');

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
      accountId,
      connectionId,
      brokerConnectionId: connectionId
    });

    res.json({
      success: true,
      message: 'Token data stored successfully',
      correlationId,
      data: result
    });

  } catch (error) {
    logger.error(`Error storing token data [ref: ${correlationId}]:`, error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      correlationId
    });
  }
});

module.exports = router;
