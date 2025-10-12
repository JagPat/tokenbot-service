const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * Authenticate user using JWT token
 */
function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'Authorization header required'
      });
    }

    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Token required'
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Attach user info to request
    req.user = {
      user_id: decoded.user_id || decoded.userId || decoded.sub,
      ...decoded
    };

    next();
  } catch (error) {
    logger.error('Authentication error:', error.message);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
}

/**
 * Authenticate internal service-to-service calls using API key
 */
function authenticateService(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API key required'
    });
  }

  const expectedKey = process.env.TOKENBOT_API_KEY;
  
  if (apiKey !== expectedKey && apiKey !== `Bearer ${expectedKey}`) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  next();
}

/**
 * Optional authentication - tries to authenticate but doesn't fail if missing
 */
function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    
    if (authHeader) {
      const token = authHeader.startsWith('Bearer ') 
        ? authHeader.substring(7) 
        : authHeader;

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = {
        user_id: decoded.user_id || decoded.userId || decoded.sub,
        ...decoded
      };
    }
  } catch (error) {
    // Ignore auth errors for optional auth
    logger.debug('Optional auth failed:', error.message);
  }

  next();
}

module.exports = {
  authenticateUser,
  authenticateService,
  optionalAuth
};

