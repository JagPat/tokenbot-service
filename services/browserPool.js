/**
 * Browser Pool Service
 * Manages reusable browser instances to reduce memory pressure
 * Implements connection pooling pattern for Puppeteer browsers
 */

const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const os = require('os');
const crypto = require('crypto');

class BrowserPool {
  constructor(options = {}) {
    this.maxPoolSize = parseInt(options.maxPoolSize) || 1; // Start with 1, Railway has memory constraints
    this.idleTimeout = parseInt(options.idleTimeout) || 300000; // 5 minutes idle timeout
    this.maxAge = parseInt(options.maxAge) || 1800000; // 30 minutes max age

    // Validate configuration
    if (this.maxPoolSize < 1) this.maxPoolSize = 1;
    if (this.idleTimeout < 1000) this.idleTimeout = 300000;

    this.pool = [];
    // Map<browserId, requestId> - Tracks which request owns which browser
    this.activeBrowsers = new Map();

    this.stats = {
      created: 0,
      reused: 0,
      closed: 0,
      errors: 0,
      memoryPressure: 0
    };
    this.circuitBreaker = {
      failures: 0,
      lastFailure: null,
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      threshold: 3,
      resetTimeout: 60000 // 1 minute
    };

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Every minute

    // Monitor memory pressure
    this.memoryCheckInterval = setInterval(() => this.checkMemoryPressure(), 30000); // Every 30 seconds
  }

  /**
   * Get optimal browser launch args for Railway containerized environment
   */
  getBrowserArgs() {
    return [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // CRITICAL: Single process mode saves memory
      '--disable-gpu',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--disable-component-extensions-with-background-pages',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-crashpad',
      '--disable-in-process-stack-traces',
      '--disable-logging',
      '--log-level=3',
      '--disable-features=VizDisplayCompositor',
      '--disable-features=Crashpad,CrashReporting',
      // Additional memory optimizations
      '--disable-javascript-harmony-shipping',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-features=AudioServiceOutOfProcess',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-speech-api',
      '--disable-web-security', // Only for internal automation
      '--disable-features=IsolateOrigins,site-per-process',
      '--js-flags=--max-old-space-size=128' // Limit JS heap
    ];
  }

  /**
   * Check if system has enough memory for browser launch
   */
  checkMemoryPressure() {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = (usedMem / totalMem) * 100;

      // Log memory stats periodically
      if (this.stats.created % 5 === 0) {
        logger.info(`💾 Memory: ${(usedMem / 1024 / 1024 / 1024).toFixed(2)}GB used / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)}GB total (${memUsagePercent.toFixed(1)}%)`);
      }

      // If memory usage > 85%, mark as pressure
      if (memUsagePercent > 85) {
        this.stats.memoryPressure++;
        logger.warn(`⚠️ High memory pressure: ${memUsagePercent.toFixed(1)}% used`);
        return true;
      }

      return false;
    } catch (error) {
      logger.warn(`Failed to check memory: ${error.message}`);
      return false;
    }
  }

  /**
   * Check circuit breaker state
   */
  checkCircuitBreaker() {
    const { state, failures, lastFailure, resetTimeout } = this.circuitBreaker;

    if (state === 'OPEN') {
      if (lastFailure && Date.now() - lastFailure > resetTimeout) {
        logger.info('🔄 Circuit breaker: Moving to HALF_OPEN state');
        this.circuitBreaker.state = 'HALF_OPEN';
        return false; // Allow one attempt
      }
      logger.warn('🚫 Circuit breaker: OPEN - browser launches blocked');
      return true; // Block launches
    }

    return false; // Allow launches
  }

  /**
   * Record circuit breaker failure
   */
  recordFailure() {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failures >= this.circuitBreaker.threshold) {
      this.circuitBreaker.state = 'OPEN';
      logger.error(`🚫 Circuit breaker: OPENED after ${this.circuitBreaker.failures} failures`);
    }
  }

  /**
   * Record circuit breaker success
   */
  recordSuccess() {
    // Reset failures on any success to allow recovery from transient errors
    if (this.circuitBreaker.failures > 0) {
      this.circuitBreaker.failures = 0;
    }

    if (this.circuitBreaker.state === 'HALF_OPEN') {
      logger.info('✅ Circuit breaker: Moving to CLOSED state');
      this.circuitBreaker.state = 'CLOSED';
    }
  }

  /**
   * Create a new browser instance
   */
  async createBrowser() {
    // Check circuit breaker
    if (this.checkCircuitBreaker()) {
      throw new Error('Browser launch blocked by circuit breaker. System recovering from failures.');
    }

    // Check memory pressure
    if (this.checkMemoryPressure()) {
      logger.warn('⚠️ High memory pressure detected, delaying browser creation');
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

      // Check again
      if (this.checkMemoryPressure()) {
        throw new Error('Insufficient memory for browser launch. Please try again later.');
      }
    }

    const startTime = Date.now();
    let browser = null;

    try {
      logger.info('🚀 Creating new browser instance...');

      // Standardizing args for official Docker image
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote'
      ];

      // Create browser with explicit executablePath for Docker image
      // Use system Chrome from Puppeteer Docker image
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

      browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath, // CRITICAL: Explicitly set Chrome path
        protocolTimeout: 120000,
        timeout: 90000,
        args: args,
        ignoreHTTPSErrors: true,
        dumpio: true, // Output Chrome logs to stdout for debugging
        env: {
          ...process.env,
          NODE_OPTIONS: undefined
        }
      });

      const launchTime = Date.now() - startTime;
      logger.info(`✅ Browser created successfully in ${launchTime}ms`);

      this.stats.created++;
      this.recordSuccess();

      // Track browser
      const browserInfo = {
        browser,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        useCount: 0,
        id: `browser-${crypto.randomUUID()}`, // Use crypto for safer ID
        markedForRemoval: false
      };

      // Monitor browser process
      browser.on('disconnected', () => {
        logger.info(`🔌 Browser ${browserInfo.id} disconnected`);
        // Don't remove immediately if it's currently in use (active)
        // Just mark it, and it will be cleaned up on release() or next cleanup() cycle
        if (this.activeBrowsers.has(browserInfo.id)) {
          logger.warn(`⚠️ Browser ${browserInfo.id} disconnected while active! Marking for removal.`);
          browserInfo.markedForRemoval = true;
        } else {
          // Safe to remove if idle
          this.removeBrowser(browserInfo.id).catch(err => {
            logger.error(`Error removing disconnected browser: ${err.message}`);
          });
        }
      });

      return browserInfo;

    } catch (error) {
      const launchTime = Date.now() - startTime;
      logger.error(`❌ Browser creation failed after ${launchTime}ms: ${error.message}`);

      this.stats.errors++;
      this.recordFailure();

      // Enhanced error context
      if (error.message?.includes('Resource temporarily unavailable') ||
        error.message?.includes('ENOMEM') ||
        error.message?.includes('Cannot allocate memory')) {
        throw new Error('Browser launch failed due to insufficient resources. Railway container may need more memory/CPU allocated.');
      }

      throw error;
    }
  }

  /**
   * Helper to atomically find an available browser and lock it
   * This ensures no race condition between finding and setting the active state
   */
  findAndLock(requestId) {
    // Single synchronous pass to find and lock
    // This atomic operation prevents race conditions in single-threaded JS
    for (const browserInfo of this.pool) {
      if (!this.activeBrowsers.has(browserInfo.id)) {
        // Check health/age
        const age = Date.now() - browserInfo.createdAt;
        const isExpired = age > this.maxAge;
        const isHealthy = browserInfo.browser && browserInfo.browser.isConnected() && !browserInfo.markedForRemoval;

        if (!isExpired && isHealthy) {
          // ATOMIC LOCK: Marking as active immediately within the loop
          this.activeBrowsers.set(browserInfo.id, requestId);
          return browserInfo;
        }
      }
    }
    return null;
  }

  /**
   * Get a browser from pool or create new one
   * Returns attached requestId to ensure safe release
   */
  async acquire() {
    // Generate unique request ID 
    const requestId = `req-${crypto.randomUUID()}`;

    // Check circuit breaker first
    if (this.checkCircuitBreaker()) {
      throw new Error('Browser pool unavailable. System recovering from failures.');
    }

    // Attempt 1: Immediate acquisition
    const availableBrowser = this.findAndLock(requestId);

    if (availableBrowser) {
      availableBrowser.lastUsed = Date.now();
      availableBrowser.useCount++;
      this.stats.reused++;
      logger.info(`♻️ Reusing browser ${availableBrowser.id} for request ${requestId} (use count: ${availableBrowser.useCount})`);

      return { ...availableBrowser, requestId };
    }

    // Check pool size limit
    if (this.pool.length >= this.maxPoolSize) {
      logger.warn(`⚠️ Pool size limit reached (${this.maxPoolSize}), waiting for available browser...`);

      // Wait up to 10 seconds for a browser to become available
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Re-check for available browser using atomic helper
        const nowAvailable = this.findAndLock(requestId);

        if (nowAvailable) {
          nowAvailable.lastUsed = Date.now();
          nowAvailable.useCount++;
          this.stats.reused++;
          logger.info(`♻️ Reusing browser ${nowAvailable.id} after wait (Req: ${requestId})`);

          return { ...nowAvailable, requestId };
        }
      }

      throw new Error('Browser pool exhausted. Please try again later.');
    }

    // Create new browser
    const browserInfo = await this.createBrowser();
    this.pool.push(browserInfo);

    // Atomic lock
    this.activeBrowsers.set(browserInfo.id, requestId);

    return {
      ...browserInfo,
      requestId
    };
  }

  /**
   * Release browser back to pool
   * Requires requestId to prevent double-release/wrong-release
   */
  release(browserId, requestId) {
    // STRICT SECURITY: requestId is MANDATORY
    if (!requestId) {
      logger.error(`❌ Security Violation: Attempted to release browser ${browserId} without requestId. DENIED.`);
      return; // Fail safe - do not release
    }

    const currentOwner = this.activeBrowsers.get(browserId);

    if (!currentOwner) {
      logger.warn(`⚠️ Attempted to release browser ${browserId} which is not active.`);
      return;
    }

    if (currentOwner !== requestId) {
      logger.error(`❌ Security/Race: Request ${requestId} tried to release browser ${browserId} owned by ${currentOwner}. DENIED.`);
      return;
    }

    const browserInfo = this.pool.find(b => b.id === browserId);

    // Cleanup active status
    this.activeBrowsers.delete(browserId);

    if (browserInfo) {
      browserInfo.lastUsed = Date.now();

      // Post-release checks
      if (browserInfo.markedForRemoval || !browserInfo.browser || !browserInfo.browser.isConnected()) {
        logger.info(`🧹 Browser ${browserId} was marked for removal or disconnected. Cleaning up now.`);
        this.removeBrowser(browserId).catch(e => logger.error(`Failed to cleanup released browser: ${e.message}`));
      } else {
        logger.debug(`🔄 Released browser ${browserId} back to pool (Req: ${requestId})`);
      }
    }
  }

  /**
   * Remove browser from pool
   */
  async removeBrowser(browserId) {
    const index = this.pool.findIndex(b => b.id === browserId);
    if (index !== -1) {
      const browserInfo = this.pool[index];

      // Remove from pool immediately to prevent re-acquisition
      this.pool.splice(index, 1);

      // If active, just remove from map
      this.activeBrowsers.delete(browserId);

      try {
        if (browserInfo.browser && browserInfo.browser.isConnected()) {
          await browserInfo.browser.close();
        }
      } catch (error) {
        logger.warn(`Failed to close browser ${browserId}: ${error.message}`);
      }

      this.stats.closed++;
      logger.info(`🗑️ Removed browser ${browserId} from pool`);
    }
  }

  /**
   * Cleanup idle and expired browsers
   */
  async cleanup() {
    const now = Date.now();
    const toRemove = [];

    for (const browserInfo of this.pool) {
      const isIdle = !this.activeBrowsers.has(browserInfo.id);
      const idleTime = now - browserInfo.lastUsed;
      const age = now - browserInfo.createdAt;
      const isExpired = age > this.maxAge;
      const isIdleTooLong = isIdle && idleTime > this.idleTimeout;

      // Check disconnection using puppeteer API + markedForRemoval flag
      const isDisconnected = browserInfo.markedForRemoval || !browserInfo.browser || !browserInfo.browser.isConnected();

      if ((isDisconnected || isExpired || isIdleTooLong) && isIdle) {
        toRemove.push(browserInfo.id);
      }
    }

    for (const browserId of toRemove) {
      // Double-check: ensure browser didn't become active between check and removal
      if (!this.activeBrowsers.has(browserId)) {
        await this.removeBrowser(browserId);
      } else {
        logger.debug(`Skipping removal of browser ${browserId} - became active during cleanup`);
      }
    }

    if (toRemove.length > 0) {
      logger.info(`🧹 Cleaned up ${toRemove.length} browser(s) from pool`);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      poolSize: this.pool.length,
      activeBrowsers: this.activeBrowsers.size,
      idleBrowsers: this.pool.length - this.activeBrowsers.size,
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failures: this.circuitBreaker.failures
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
        percent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(1)
      }
    };
  }

  /**
   * Close all browsers and cleanup
   */
  async shutdown() {
    logger.info('🛑 Shutting down browser pool...');

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
    }

    const activeCount = this.activeBrowsers.size;
    if (activeCount > 0) {
      logger.warn(`⚠️ Shutting down with ${activeCount} active browser(s). Active requests may fail.`);
      // Log active request IDs for debugging
      const activeIds = Array.from(this.activeBrowsers.values()).join(', ');
      logger.warn(`Active requests affected: ${activeIds}`);
    }

    // Close all browsers
    const closePromises = this.pool.map(browserInfo => {
      if (browserInfo.browser && browserInfo.browser.isConnected()) {
        return browserInfo.browser.close().catch(err => {
          logger.warn(`Failed to close browser ${browserInfo.id}: ${err.message}`);
        });
      }
      return null;
    }).filter(p => p !== null);

    await Promise.all(closePromises);
    this.pool = [];
    this.activeBrowsers.clear();

    logger.info('✅ Browser pool shut down');
  }
}

// Singleton instance
const browserPool = new BrowserPool({
  maxPoolSize: parseInt(process.env.BROWSER_POOL_SIZE || '1'), // Start with 1 for Railway
  idleTimeout: parseInt(process.env.BROWSER_IDLE_TIMEOUT || '300000'), // 5 minutes
  maxAge: parseInt(process.env.BROWSER_MAX_AGE || '1800000') // 30 minutes
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await browserPool.shutdown();
});

process.on('SIGINT', async () => {
  await browserPool.shutdown();
});

module.exports = browserPool;
