/**
 * Browser Pool Service
 *
 * Self-healing browser pool for Puppeteer with:
 * - circuit breaker with HALF_OPEN probes
 * - bounded backpressure queue
 * - stale lease cleanup
 * - pool reset + healing metrics
 */

const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const os = require('os');
const crypto = require('crypto');

class BrowserPool {
  constructor(options = {}) {
    this.maxPoolSize = Math.max(1, parseInt(options.maxPoolSize || '2', 10));
    this.idleTimeout = Math.max(1000, parseInt(options.idleTimeout || '300000', 10));
    this.maxAge = Math.max(30000, parseInt(options.maxAge || '1800000', 10));

    this.maxQueueSize = Math.max(1, parseInt(options.maxQueueSize || '20', 10));
    this.acquireTimeoutMs = Math.max(1000, parseInt(options.acquireTimeoutMs || '45000', 10));
    this.staleLeaseMs = Math.max(60000, parseInt(options.staleLeaseMs || '300000', 10));

    this.pool = [];
    // Map<browserId, { requestId, acquiredAt }>
    this.activeBrowsers = new Map();
    this.pendingQueue = [];

    this.stats = {
      created: 0,
      reused: 0,
      closed: 0,
      errors: 0,
      memoryPressure: 0,
      queueRejected: 0,
      queueTimedOut: 0,
      halfOpenProbes: 0,
      healingResets: 0,
      circuitTrips: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null
    };

    this.circuitBreaker = {
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      failures: 0,
      threshold: parseInt(options.failureThreshold || '3', 10),
      resetTimeout: parseInt(options.resetTimeout || '60000', 10),
      openedAt: null,
      halfOpenInFlight: false,
      consecutiveHalfOpenSuccesses: 0,
      successThreshold: parseInt(options.halfOpenSuccessThreshold || '1', 10)
    };

    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanup();
      } catch (error) {
        logger.error(`Cleanup interval error: ${error.message}`);
      }
    }, 60000);

    this.memoryCheckInterval = setInterval(() => this.checkMemoryPressure(), 30000);

    // Frequent healing loop for breaker probes + queue drain.
    this.healInterval = setInterval(async () => {
      try {
        await this.runSelfHeal();
      } catch (error) {
        logger.error(`Self-heal loop error: ${error.message}`);
      }
    }, 15000);
  }

  getBrowserArgs() {
    return [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--mute-audio',
      '--disable-features=TranslateUI,IsolateOrigins,site-per-process',
      '--js-flags=--max-old-space-size=512'
    ];
  }

  checkMemoryPressure() {
    try {
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const usagePercent = (usedMem / totalMem) * 100;

      if (usagePercent > 85) {
        this.stats.memoryPressure += 1;
        logger.warn(`High memory pressure: ${usagePercent.toFixed(1)}%`);
        return true;
      }

      return false;
    } catch (error) {
      logger.warn(`Failed to check memory pressure: ${error.message}`);
      return false;
    }
  }

  _transitionToOpen(reason) {
    if (this.circuitBreaker.state !== 'OPEN') {
      this.stats.circuitTrips += 1;
    }

    this.circuitBreaker.state = 'OPEN';
    this.circuitBreaker.openedAt = Date.now();
    this.circuitBreaker.halfOpenInFlight = false;
    this.circuitBreaker.consecutiveHalfOpenSuccesses = 0;
    this.stats.lastFailureReason = reason || 'unknown';
    this.stats.lastFailureAt = new Date().toISOString();

    logger.error(`Circuit breaker OPENED: ${this.stats.lastFailureReason}`);
  }

  _recordFailure(error) {
    const reason = error?.message || 'unknown browser failure';
    this.circuitBreaker.failures += 1;

    if (this.circuitBreaker.state === 'HALF_OPEN') {
      this._transitionToOpen(`HALF_OPEN probe failed: ${reason}`);
      return;
    }

    if (this.circuitBreaker.failures >= this.circuitBreaker.threshold) {
      this._transitionToOpen(reason);
    } else {
      this.stats.lastFailureReason = reason;
      this.stats.lastFailureAt = new Date().toISOString();
    }
  }

  _recordSuccess() {
    this.circuitBreaker.failures = 0;
    this.stats.lastSuccessAt = new Date().toISOString();

    if (this.circuitBreaker.state === 'HALF_OPEN') {
      this.circuitBreaker.consecutiveHalfOpenSuccesses += 1;
      if (this.circuitBreaker.consecutiveHalfOpenSuccesses >= this.circuitBreaker.successThreshold) {
        this.circuitBreaker.state = 'CLOSED';
        this.circuitBreaker.openedAt = null;
        this.circuitBreaker.halfOpenInFlight = false;
        this.circuitBreaker.consecutiveHalfOpenSuccesses = 0;
        logger.info('Circuit breaker CLOSED after successful HALF_OPEN probe');
      }
    }
  }

  _isLaunchBlocked() {
    const breaker = this.circuitBreaker;

    if (breaker.state !== 'OPEN') {
      return false;
    }

    if (!breaker.openedAt) {
      return true;
    }

    const elapsed = Date.now() - breaker.openedAt;
    if (elapsed >= breaker.resetTimeout) {
      breaker.state = 'HALF_OPEN';
      breaker.halfOpenInFlight = false;
      breaker.consecutiveHalfOpenSuccesses = 0;
      logger.info('Circuit breaker OPEN -> HALF_OPEN (probe window)');
      return false;
    }

    return true;
  }

  _buildBlockedError(prefix) {
    const breaker = this.circuitBreaker;
    const openedAt = breaker.openedAt || Date.now();
    const retryInMs = Math.max(0, breaker.resetTimeout - (Date.now() - openedAt));
    const retryInSec = Math.ceil(retryInMs / 1000);
    const reason = this.stats.lastFailureReason || 'browser failures';

    return new Error(`${prefix}: circuit breaker ${breaker.state} (retry in ${retryInSec}s, reason: ${reason})`);
  }

  async _createBrowser({ isProbe = false } = {}) {
    if (!isProbe && this._isLaunchBlocked()) {
      throw this._buildBlockedError('Browser launch blocked');
    }

    if (this.checkMemoryPressure()) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.checkMemoryPressure()) {
        throw new Error('Insufficient memory for browser launch');
      }
    }

    const breaker = this.circuitBreaker;
    if (breaker.state === 'HALF_OPEN') {
      if (breaker.halfOpenInFlight) {
        throw new Error('HALF_OPEN probe already in flight');
      }
      breaker.halfOpenInFlight = true;
      this.stats.halfOpenProbes += 1;
    }

    const start = Date.now();
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

    try {
      const browser = await puppeteer.launch({
        headless: 'new',
        executablePath,
        protocolTimeout: 240000,
        timeout: 180000,
        args: this.getBrowserArgs(),
        ignoreHTTPSErrors: true,
        dumpio: true,
        env: {
          ...process.env,
          NODE_OPTIONS: undefined
        }
      });

      const browserInfo = {
        browser,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        useCount: 0,
        id: `browser-${crypto.randomUUID()}`,
        markedForRemoval: false
      };

      browser.on('disconnected', () => {
        browserInfo.markedForRemoval = true;
        if (!this.activeBrowsers.has(browserInfo.id)) {
          this.removeBrowser(browserInfo.id).catch((error) => {
            logger.error(`Error removing disconnected browser: ${error.message}`);
          });
        }
      });

      this.stats.created += 1;
      this._recordSuccess();

      logger.info(`Browser created in ${Date.now() - start}ms${isProbe ? ' (probe)' : ''}`);
      return browserInfo;
    } catch (error) {
      this.stats.errors += 1;
      this._recordFailure(error);
      logger.error(`Browser creation failed after ${Date.now() - start}ms: ${error.message}`);
      throw error;
    } finally {
      if (breaker.state === 'HALF_OPEN') {
        breaker.halfOpenInFlight = false;
      }
    }
  }

  _findAndLockAvailableBrowser(requestId) {
    const now = Date.now();

    for (const browserInfo of this.pool) {
      if (this.activeBrowsers.has(browserInfo.id)) continue;

      const age = now - browserInfo.createdAt;
      const isExpired = age > this.maxAge;
      const isHealthy = browserInfo.browser && browserInfo.browser.isConnected() && !browserInfo.markedForRemoval;

      if (!isExpired && isHealthy) {
        this.activeBrowsers.set(browserInfo.id, { requestId, acquiredAt: now });
        browserInfo.lastUsed = now;
        browserInfo.useCount += 1;
        this.stats.reused += 1;
        return browserInfo;
      }
    }

    return null;
  }

  async acquire() {
    const requestId = `req-${crypto.randomUUID()}`;

    const available = this._findAndLockAvailableBrowser(requestId);
    if (available) {
      return { ...available, requestId };
    }

    if (this.pool.length < this.maxPoolSize) {
      const browserInfo = await this._createBrowser();
      this.pool.push(browserInfo);
      this.activeBrowsers.set(browserInfo.id, { requestId, acquiredAt: Date.now() });
      return { ...browserInfo, requestId };
    }

    if (this._isLaunchBlocked()) {
      throw this._buildBlockedError('Browser pool unavailable');
    }

    if (this.pendingQueue.length >= this.maxQueueSize) {
      this.stats.queueRejected += 1;
      throw new Error(`Browser pool queue full (${this.maxQueueSize})`);
    }

    return new Promise((resolve, reject) => {
      const queuedAt = Date.now();
      const timeout = setTimeout(() => {
        const idx = this.pendingQueue.findIndex((entry) => entry.requestId === requestId);
        if (idx >= 0) {
          this.pendingQueue.splice(idx, 1);
        }
        this.stats.queueTimedOut += 1;
        reject(new Error(`Browser acquisition timed out after ${this.acquireTimeoutMs}ms`));
      }, this.acquireTimeoutMs);

      this.pendingQueue.push({ requestId, resolve, reject, queuedAt, timeout });
      logger.warn(`Browser request queued (${this.pendingQueue.length}/${this.maxQueueSize})`);
    });
  }

  async _drainQueue() {
    if (this.pendingQueue.length === 0) return;

    while (this.pendingQueue.length > 0) {
      const next = this.pendingQueue[0];
      let browserInfo = this._findAndLockAvailableBrowser(next.requestId);

      if (!browserInfo && this.pool.length < this.maxPoolSize) {
        try {
          browserInfo = await this._createBrowser();
          this.pool.push(browserInfo);
          this.activeBrowsers.set(browserInfo.id, {
            requestId: next.requestId,
            acquiredAt: Date.now()
          });
        } catch (error) {
          // Keep queued requests; self-heal/probe will retry.
          break;
        }
      }

      if (!browserInfo) {
        break;
      }

      this.pendingQueue.shift();
      clearTimeout(next.timeout);
      next.resolve({ ...browserInfo, requestId: next.requestId });
    }
  }

  release(browserId, requestId) {
    if (!requestId) {
      logger.error(`Release denied for ${browserId}: missing requestId`);
      return;
    }

    const lockInfo = this.activeBrowsers.get(browserId);
    if (!lockInfo) {
      logger.warn(`Release ignored for ${browserId}: browser not active`);
      return;
    }

    if (lockInfo.requestId !== requestId) {
      logger.error(`Release denied for ${browserId}: ownership mismatch (${requestId} != ${lockInfo.requestId})`);
      return;
    }

    this.activeBrowsers.delete(browserId);

    const browserInfo = this.pool.find((entry) => entry.id === browserId);
    if (browserInfo) {
      browserInfo.lastUsed = Date.now();
      if (browserInfo.markedForRemoval || !browserInfo.browser || !browserInfo.browser.isConnected()) {
        this.removeBrowser(browserId).catch((error) => {
          logger.error(`Failed to remove disconnected browser ${browserId}: ${error.message}`);
        });
      }
    }

    this._drainQueue().catch((error) => {
      logger.error(`Queue drain error after release: ${error.message}`);
    });
  }

  async removeBrowser(browserId) {
    const idx = this.pool.findIndex((entry) => entry.id === browserId);
    if (idx === -1) return;

    const browserInfo = this.pool[idx];
    this.pool.splice(idx, 1);
    this.activeBrowsers.delete(browserId);

    try {
      if (browserInfo.browser && browserInfo.browser.isConnected()) {
        await browserInfo.browser.close();
      }
    } catch (error) {
      logger.warn(`Failed to close browser ${browserId}: ${error.message}`);
    }

    this.stats.closed += 1;
  }

  async _cleanupStaleLeases() {
    const now = Date.now();

    for (const [browserId, lockInfo] of this.activeBrowsers.entries()) {
      if (!lockInfo?.acquiredAt) continue;
      const age = now - lockInfo.acquiredAt;
      if (age <= this.staleLeaseMs) continue;

      logger.warn(`Reclaiming stale browser lease ${browserId} (age ${Math.round(age / 1000)}s)`);
      this.activeBrowsers.delete(browserId);

      const browserInfo = this.pool.find((entry) => entry.id === browserId);
      if (browserInfo) {
        browserInfo.markedForRemoval = true;
      }
    }
  }

  async cleanup() {
    await this._cleanupStaleLeases();

    const now = Date.now();
    const toRemove = [];

    for (const browserInfo of this.pool) {
      const isIdle = !this.activeBrowsers.has(browserInfo.id);
      if (!isIdle) continue;

      const idleTooLong = (now - browserInfo.lastUsed) > this.idleTimeout;
      const isExpired = (now - browserInfo.createdAt) > this.maxAge;
      const disconnected = browserInfo.markedForRemoval || !browserInfo.browser || !browserInfo.browser.isConnected();

      if (idleTooLong || isExpired || disconnected) {
        toRemove.push(browserInfo.id);
      }
    }

    for (const browserId of toRemove) {
      await this.removeBrowser(browserId);
    }

    await this._drainQueue();
  }

  async resetPool(reason = 'manual reset') {
    logger.warn(`Resetting browser pool: ${reason}`);
    this.stats.healingResets += 1;

    const closeOps = this.pool.map((browserInfo) => {
      if (!browserInfo.browser || !browserInfo.browser.isConnected()) return Promise.resolve();
      return browserInfo.browser.close().catch((error) => {
        logger.warn(`Failed closing browser during reset ${browserInfo.id}: ${error.message}`);
      });
    });

    await Promise.all(closeOps);

    this.pool = [];
    this.activeBrowsers.clear();

    for (const pending of this.pendingQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Browser pool reset: ${reason}`));
    }
    this.pendingQueue = [];

    this.circuitBreaker.state = 'HALF_OPEN';
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.openedAt = Date.now();
    this.circuitBreaker.halfOpenInFlight = false;
    this.circuitBreaker.consecutiveHalfOpenSuccesses = 0;
  }

  async runSelfHeal() {
    // Keep pool tidy first.
    await this.cleanup();

    if (this.circuitBreaker.state !== 'OPEN') {
      return;
    }

    const openedAt = this.circuitBreaker.openedAt || Date.now();
    const elapsed = Date.now() - openedAt;
    if (elapsed < this.circuitBreaker.resetTimeout) {
      return;
    }

    if (this.circuitBreaker.halfOpenInFlight) {
      return;
    }

    logger.info('Running HALF_OPEN self-heal probe');

    try {
      // Force HALF_OPEN so probe can run.
      this.circuitBreaker.state = 'HALF_OPEN';
      const probeBrowser = await this._createBrowser({ isProbe: true });
      this.pool.push(probeBrowser);
      logger.info('HALF_OPEN probe succeeded; pool recovered');
      await this._drainQueue();
    } catch (error) {
      this._transitionToOpen(`Self-heal probe failed: ${error.message}`);
    }
  }

  getStats() {
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();

    return {
      ...this.stats,
      poolSize: this.pool.length,
      activeBrowsers: this.activeBrowsers.size,
      idleBrowsers: Math.max(0, this.pool.length - this.activeBrowsers.size),
      queue: {
        size: this.pendingQueue.length,
        maxSize: this.maxQueueSize,
        acquireTimeoutMs: this.acquireTimeoutMs
      },
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failures: this.circuitBreaker.failures,
        threshold: this.circuitBreaker.threshold,
        resetTimeoutMs: this.circuitBreaker.resetTimeout,
        openedAt: this.circuitBreaker.openedAt ? new Date(this.circuitBreaker.openedAt).toISOString() : null,
        halfOpenInFlight: this.circuitBreaker.halfOpenInFlight,
        consecutiveHalfOpenSuccesses: this.circuitBreaker.consecutiveHalfOpenSuccesses
      },
      memory: {
        total: totalMem,
        free: os.freemem(),
        used: usedMem,
        percent: ((usedMem / totalMem) * 100).toFixed(1)
      }
    };
  }

  async shutdown() {
    logger.info('Shutting down browser pool');

    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.memoryCheckInterval) clearInterval(this.memoryCheckInterval);
    if (this.healInterval) clearInterval(this.healInterval);

    for (const pending of this.pendingQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Browser pool shutting down'));
    }
    this.pendingQueue = [];

    const closeOps = this.pool.map((browserInfo) => {
      if (!browserInfo.browser || !browserInfo.browser.isConnected()) return Promise.resolve();
      return browserInfo.browser.close().catch((error) => {
        logger.warn(`Failed closing browser ${browserInfo.id}: ${error.message}`);
      });
    });

    await Promise.all(closeOps);
    this.pool = [];
    this.activeBrowsers.clear();

    logger.info('Browser pool shut down complete');
  }
}

const browserPool = new BrowserPool({
  maxPoolSize: parseInt(process.env.BROWSER_POOL_SIZE || '1', 10),
  idleTimeout: parseInt(process.env.BROWSER_IDLE_TIMEOUT || '300000', 10),
  maxAge: parseInt(process.env.BROWSER_MAX_AGE || '1800000', 10),
  maxQueueSize: parseInt(process.env.BROWSER_QUEUE_MAX || '20', 10),
  acquireTimeoutMs: parseInt(process.env.BROWSER_ACQUIRE_TIMEOUT_MS || '45000', 10),
  staleLeaseMs: parseInt(process.env.BROWSER_STALE_LEASE_MS || '300000', 10),
  failureThreshold: parseInt(process.env.BROWSER_BREAKER_THRESHOLD || '3', 10),
  resetTimeout: parseInt(process.env.BROWSER_BREAKER_RESET_TIMEOUT_MS || '60000', 10),
  halfOpenSuccessThreshold: parseInt(process.env.BROWSER_BREAKER_HALF_OPEN_SUCCESS || '1', 10)
});

process.on('SIGTERM', async () => {
  await browserPool.shutdown();
});

process.on('SIGINT', async () => {
  await browserPool.shutdown();
});

module.exports = browserPool;
