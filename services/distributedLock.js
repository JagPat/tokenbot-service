const crypto = require('crypto');
const logger = require('../utils/logger');

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

class DistributedLockService {
  constructor() {
    this.redisClient = null;
    this.redisInitPromise = null;
    this.localLocks = new Map();
    this.redisRequiredInProd =
      process.env.TOKENBOT_REDIS_LOCK_REQUIRED !== 'false';
  }

  _isProduction() {
    return process.env.NODE_ENV === 'production';
  }

  _redisUrl() {
    return process.env.REDIS_URL || process.env.REDISCLOUD_URL || null;
  }

  _lockKey(rawKey) {
    return `tokenbot:lock:${String(rawKey || '').trim()}`;
  }

  _makeLockUnavailableError(message, retryAfterMs = 5000) {
    const error = new Error(message);
    error.code = 'TOKEN_REFRESH_LOCK_UNAVAILABLE';
    error.statusCode = 503;
    error.retryAfterMs = Math.max(1000, Number(retryAfterMs || 5000));
    return error;
  }

  _makeLockHeldError(lockKey, retryAfterMs = 10000) {
    const error = new Error(`Token refresh already in progress for ${lockKey}`);
    error.code = 'TOKEN_REFRESH_LOCKED';
    error.statusCode = 503;
    error.retryAfterMs = Math.max(1000, Number(retryAfterMs || 10000));
    return error;
  }

  async _ensureRedisClient() {
    if (this.redisClient) {
      return this.redisClient;
    }

    if (this.redisInitPromise) {
      return this.redisInitPromise;
    }

    this.redisInitPromise = (async () => {
      const redisUrl = this._redisUrl();
      if (!redisUrl) {
        if (this._isProduction() && this.redisRequiredInProd) {
          throw this._makeLockUnavailableError('Redis is required in production for token refresh locks');
        }
        return null;
      }

      try {
        const Redis = require('ioredis');
        const client = new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: true,
          retryStrategy: (times) => Math.min(times * 200, 2000)
        });

        client.on('error', (error) => {
          logger.warn(`[DistributedLock] Redis error: ${error.message}`);
        });

        await client.connect();
        this.redisClient = client;
        logger.info('[DistributedLock] Redis lock transport connected');
        return this.redisClient;
      } catch (error) {
        logger.error(`[DistributedLock] Redis init failed: ${error.message}`);
        if (this._isProduction() && this.redisRequiredInProd) {
          throw this._makeLockUnavailableError('Redis lock transport is unavailable');
        }
        return null;
      } finally {
        this.redisInitPromise = null;
      }
    })();

    return this.redisInitPromise;
  }

  _acquireLocalLock(lockKey, ttlMs) {
    const now = Date.now();
    const current = this.localLocks.get(lockKey);
    if (current && current.expiresAt > now) {
      throw this._makeLockHeldError(lockKey, current.expiresAt - now);
    }

    const token = crypto.randomUUID();
    this.localLocks.set(lockKey, {
      token,
      expiresAt: now + ttlMs
    });

    return {
      key: lockKey,
      token,
      ttlMs,
      mode: 'memory'
    };
  }

  async acquire(rawKey, ttlMs = 45000) {
    const lockKey = this._lockKey(rawKey);
    if (!lockKey || lockKey.endsWith(':')) {
      throw new Error('Cannot acquire distributed lock with empty key');
    }

    const safeTtlMs = Math.max(1000, Number(ttlMs || 45000));
    const redisClient = await this._ensureRedisClient();

    if (!redisClient) {
      return this._acquireLocalLock(lockKey, safeTtlMs);
    }

    const token = crypto.randomUUID();
    const acquired = await redisClient.set(lockKey, token, 'PX', safeTtlMs, 'NX');
    if (acquired !== 'OK') {
      const remainingTtl = await redisClient.pttl(lockKey).catch(() => -1);
      throw this._makeLockHeldError(lockKey, remainingTtl > 0 ? remainingTtl : 10000);
    }

    return {
      key: lockKey,
      token,
      ttlMs: safeTtlMs,
      mode: 'redis'
    };
  }

  async release(lock) {
    if (!lock || !lock.key || !lock.token) {
      return;
    }

    if (lock.mode === 'memory') {
      const current = this.localLocks.get(lock.key);
      if (current?.token === lock.token) {
        this.localLocks.delete(lock.key);
      }
      return;
    }

    const redisClient = await this._ensureRedisClient();
    if (!redisClient) {
      return;
    }

    try {
      await redisClient.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
    } catch (error) {
      logger.warn(`[DistributedLock] Failed to release lock ${lock.key}: ${error.message}`);
    }
  }

  getStatus() {
    return {
      transport: this.redisClient ? 'redis' : 'memory',
      redisConfigured: Boolean(this._redisUrl()),
      strictInProduction: this._isProduction() && this.redisRequiredInProd
    };
  }
}

module.exports = new DistributedLockService();
