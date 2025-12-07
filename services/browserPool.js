/**
 * Browser Pool Service
 * Manages reusable browser instances to reduce memory pressure
 * Implements connection pooling pattern for Puppeteer browsers
 */

const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const os = require('os');

class BrowserPool {
  constructor(options = {}) {
    this.maxPoolSize = options.maxPoolSize || 1; // Start with 1, Railway has memory constraints
    this.idleTimeout = options.idleTimeout || 300000; // 5 minutes idle timeout
    this.maxAge = options.maxAge || 1800000; // 30 minutes max age
    this.pool = [];
    this.activeBrowsers = new Set();
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
    if (this.circuitBreaker.state === 'HALF_OPEN') {
      logger.info('✅ Circuit breaker: Moving to CLOSED state');
      this.circuitBreaker.state = 'CLOSED';
      this.circuitBreaker.failures = 0;
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

      // Determine Chromium executable path
      const chromiumPaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_BIN,
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable'
      ].filter(Boolean);

      const executablePath = chromiumPaths[0] || undefined;

      // Create browser with optimized args
      browser = await puppeteer.launch({
        headless: true, // Use legacy headless for better Alpine compatibility
        protocolTimeout: 120000,
        timeout: 90000,
        args: this.getBrowserArgs(),
        executablePath: executablePath || '/usr/bin/chromium-browser',
        ignoreHTTPSErrors: true,
        dumpio: true, // Output Chrome logs to stdout for debugging
        env: {
          ...process.env,
          // Ensure no weird env vars break it
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
        id: `browser-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };

      // Monitor browser process
      browser.on('disconnected', () => {
        logger.info(`🔌 Browser ${browserInfo.id} disconnected`);
        this.removeBrowser(browserInfo.id);
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
   * Get a browser from pool or create new one
   */
  async acquire() {
    // Check circuit breaker first
    if (this.checkCircuitBreaker()) {
      throw new Error('Browser pool unavailable. System recovering from failures.');
    }

    // Try to reuse existing browser
    const availableBrowser = this.pool.find(b => {
      const isIdle = !this.activeBrowsers.has(b.id);
      const isNotExpired = Date.now() - b.createdAt < this.maxAge;
      const isHealthy = b.browser && b.browser.isConnected();
      return isIdle && isNotExpired && isHealthy;
    });

    if (availableBrowser) {
      availableBrowser.lastUsed = Date.now();
      availableBrowser.useCount++;
      this.activeBrowsers.add(availableBrowser.id);
      this.stats.reused++;
      logger.info(`♻️ Reusing browser ${availableBrowser.id} (use count: ${availableBrowser.useCount})`);
      return availableBrowser;
    }

    // Check pool size limit
    if (this.pool.length >= this.maxPoolSize) {
      logger.warn(`⚠️ Pool size limit reached (${this.maxPoolSize}), waiting for available browser...`);

      // Wait up to 10 seconds for a browser to become available
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const nowAvailable = this.pool.find(b => {
          const isIdle = !this.activeBrowsers.has(b.id);
          const isHealthy = b.browser && b.browser.isConnected();
          return isIdle && isHealthy;
        });

        if (nowAvailable) {
          nowAvailable.lastUsed = Date.now();
          nowAvailable.useCount++;
          this.activeBrowsers.add(nowAvailable.id);
          this.stats.reused++;
          logger.info(`♻️ Reusing browser ${nowAvailable.id} after wait`);
          return nowAvailable;
        }
      }

      throw new Error('Browser pool exhausted. Please try again later.');
    }

    // Create new browser
    const browserInfo = await this.createBrowser();
    this.pool.push(browserInfo);
    this.activeBrowsers.add(browserInfo.id);

    return browserInfo;
  }

  /**
   * Release browser back to pool
   */
  release(browserId) {
    const browserInfo = this.pool.find(b => b.id === browserId);
    if (browserInfo) {
      this.activeBrowsers.delete(browserId);
      browserInfo.lastUsed = Date.now();
      logger.debug(`🔄 Released browser ${browserId} back to pool`);
    }
  }

  /**
   * Remove browser from pool
   */
  async removeBrowser(browserId) {
    const index = this.pool.findIndex(b => b.id === browserId);
    if (index !== -1) {
      const browserInfo = this.pool[index];
      this.activeBrowsers.delete(browserId);

      try {
        if (browserInfo.browser && browserInfo.browser.isConnected()) {
          await browserInfo.browser.close();
        }
      } catch (error) {
        logger.warn(`Failed to close browser ${browserId}: ${error.message}`);
      }

      this.pool.splice(index, 1);
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
      const isDisconnected = !browserInfo.browser || !browserInfo.browser.isConnected();

      if (isDisconnected || isExpired || isIdleTooLong) {
        toRemove.push(browserInfo.id);
      }
    }

    for (const browserId of toRemove) {
      await this.removeBrowser(browserId);
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

    // Close all browsers
    const closePromises = this.pool.map(browserInfo => {
      if (browserInfo.browser && browserInfo.browser.isConnected()) {
        return browserInfo.browser.close().catch(err => {
          logger.warn(`Failed to close browser ${browserInfo.id}: ${err.message}`);
        });
      }
    });

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

