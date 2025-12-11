# Potential Bugs Report - TokenBot Service

**Generated:** $(date)
**Status:** Analysis Complete - Ready for Instrumentation & Debugging

## Critical Bugs (High Priority)

### 1. Race Condition in Browser Pool `acquire()` Method
**Location:** `services/browserPool.js:267-280`

**Issue:** Multiple concurrent requests can acquire the same browser instance because the check (`isIdle`) and the update (`activeBrowsers.add()`) are not atomic.

**Code Pattern:**
```javascript
const availableBrowser = this.pool.find(b => {
  const isIdle = !this.activeBrowsers.has(b.id);  // Check
  // ... other checks
  return isIdle && isNotExpired && isHealthy;
});

if (availableBrowser) {
  this.activeBrowsers.add(availableBrowser.id);  // Update - NOT ATOMIC
  return availableBrowser;
}
```

**Impact:** Two requests could both see a browser as idle and both acquire it, causing:
- Browser state corruption
- One request failing unexpectedly
- Potential memory leaks if browser is used by multiple requests

**Fix:** Use atomic operations or a lock mechanism to ensure only one request can acquire a browser at a time.

---

### 2. Circuit Breaker Failures Counter Never Resets
**Location:** `services/browserPool.js:154-160`

**Issue:** The circuit breaker's `failures` counter is only reset when transitioning from `HALF_OPEN` to `CLOSED`, but never resets when already in `CLOSED` state after successful operations.

**Code Pattern:**
```javascript
recordSuccess() {
  if (this.circuitBreaker.state === 'HALF_OPEN') {
    this.circuitBreaker.state = 'CLOSED';
    this.circuitBreaker.failures = 0;  // Only resets in HALF_OPEN
  }
  // No reset if already CLOSED
}
```

**Impact:** After 3 failures, even if subsequent operations succeed, the failures counter remains at 3. If another failure occurs, it immediately opens again without giving the system a chance to recover properly.

**Fix:** Reset failures counter to 0 when in CLOSED state after a successful operation, or implement a decay mechanism.

---

### 3. Browser Disconnection Handling Race Condition
**Location:** `services/browserPool.js:232-235`

**Issue:** When a browser disconnects, the `disconnected` event handler calls `removeBrowser()`, but if the browser is currently in `activeBrowsers`, it might be removed while still being used by a request.

**Code Pattern:**
```javascript
browser.on('disconnected', () => {
  logger.info(`🔌 Browser ${browserInfo.id} disconnected`);
  this.removeBrowser(browserInfo.id);  // Removes even if active
});
```

**Impact:** A request might be using a browser that gets removed from the pool mid-operation, causing:
- Unexpected errors
- Browser state inconsistency
- Potential memory leaks

**Fix:** Check if browser is in `activeBrowsers` before removing, or mark it for removal after release.

---

### 4. No Database Transaction in Token Storage
**Location:** `services/tokenManager.js:70-98`

**Issue:** The `storeToken()` method performs two separate database operations (UPDATE and INSERT) without a transaction, creating a race condition window.

**Code Pattern:**
```javascript
// Invalidate old tokens
await db.query(`UPDATE kite_tokens SET is_valid = false WHERE user_id = $1`, [userId]);

// Insert new token
await db.query(`INSERT INTO kite_tokens ...`, [...]);
```

**Impact:** If two concurrent refresh requests occur:
- Both could invalidate old tokens
- Both could insert new tokens
- Database could end up with multiple "valid" tokens
- Token consistency is broken

**Fix:** Wrap both operations in a database transaction.

---

### 5. Server Shutdown Doesn't Clean Up Browser Pool
**Location:** `server.js:172-182`

**Issue:** The server shutdown handlers (`SIGTERM`, `SIGINT`) close the database connection but never call `browserPool.shutdown()`, leaving browser instances running.

**Code Pattern:**
```javascript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await db.end();  // Closes DB
  // Missing: await browserPool.shutdown();
  process.exit(0);
});
```

**Impact:** 
- Browser processes remain running after server shutdown
- Memory leaks
- Resource exhaustion on Railway
- Potential billing issues

**Fix:** Call `browserPool.shutdown()` in shutdown handlers.

---

## Medium Priority Bugs

### 6. Browser Release Doesn't Verify Connection State
**Location:** `services/browserPool.js:321-328`

**Issue:** The `release()` method doesn't verify that the browser is still connected before releasing it back to the pool.

**Code Pattern:**
```javascript
release(browserId) {
  const browserInfo = this.pool.find(b => b.id === browserId);
  if (browserInfo) {
    this.activeBrowsers.delete(browserId);
    browserInfo.lastUsed = Date.now();
    // No check: browserInfo.browser.isConnected()
  }
}
```

**Impact:** Disconnected browsers could be released back to the pool, causing:
- Future `acquire()` calls to return broken browsers
- Errors when trying to use disconnected browsers
- Pool pollution

**Fix:** Verify `browser.isConnected()` before releasing, or remove disconnected browsers.

---

### 7. Request Interception Race Condition
**Location:** `services/tokenFetcher.js:40-87`

**Issue:** Request interception is set up after page creation, but requests might occur before the listener is attached, causing tokens to be missed.

**Code Pattern:**
```javascript
page = await browser.newPage();
// ... setup code ...
await page.setRequestInterception(true);  // Setup interception
page.on('request', (request) => { ... }); // Attach listener
```

**Impact:** If Zerodha redirects happen very quickly, the token might be missed, causing:
- Token fetch failures
- Need for retries
- Poor user experience

**Fix:** Set up interception before any navigation, or use `page.once()` for critical requests.

---

### 8. Cleanup Interval Never Cleared on Error
**Location:** `services/browserPool.js:34-37`

**Issue:** If the BrowserPool constructor throws an error after creating intervals, the intervals are never cleared, causing memory leaks.

**Code Pattern:**
```javascript
constructor(options = {}) {
  // ... initialization ...
  this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  this.memoryCheckInterval = setInterval(() => this.checkMemoryPressure(), 30000);
  // If error occurs here, intervals are never cleared
}
```

**Impact:** Memory leaks if constructor fails partially.

**Fix:** Use try-catch in constructor or ensure intervals are cleared in error paths.

---

### 9. Page Cleanup in Error Handler May Fail Silently
**Location:** `services/tokenFetcher.js:930-936`

**Issue:** Page cleanup in error handler catches errors but doesn't log them properly, making debugging difficult.

**Code Pattern:**
```javascript
if (page) {
  try {
    await page.close();
  } catch (closeError) {
    logger.warn(`Failed to close page: ${closeError.message}`);  // Only warns
  }
}
```

**Impact:** Page leaks might go unnoticed, accumulating over time.

**Fix:** Log page cleanup failures more prominently, or track page lifecycle.

---

### 10. Scheduler Doesn't Handle Concurrent Cron Triggers
**Location:** `services/scheduler.js:52-55`

**Issue:** The `isRunning` flag prevents concurrent executions, but if a cron job is triggered while another is running, it silently returns without logging.

**Code Pattern:**
```javascript
if (this.isRunning) {
  logger.warn('⚠️ Token refresh already in progress');
  return;  // Silent return - no indication to caller
}
```

**Impact:** 
- Cron triggers might be silently ignored
- No visibility into skipped executions
- Potential token refresh gaps

**Fix:** Log skipped executions with timestamps, or queue requests.

---

## Low Priority Bugs / Code Quality Issues

### 11. Memory Check Logging Frequency Issue
**Location:** `services/browserPool.js:101-103`

**Issue:** Memory stats are logged every 5 browser creations (`this.stats.created % 5 === 0`), but if browsers are reused, this might not log frequently enough.

**Impact:** Reduced observability of memory pressure.

**Fix:** Log based on time intervals instead of creation count.

---

### 12. Browser Pool Wait Loop Doesn't Check for New Browsers
**Location:** `services/browserPool.js:288-305`

**Issue:** When waiting for an available browser, the code only checks existing browsers in the pool, not newly created ones that might become available.

**Impact:** Unnecessary waiting even if a browser becomes available.

**Fix:** Re-check pool size and available browsers in the wait loop.

---

### 13. Token Expiry Calculation Timezone Handling
**Location:** `services/tokenFetcher.js:952-968`

**Issue:** The `calculateExpiry()` method manually calculates IST offset, which might not account for daylight saving time or timezone changes.

**Code Pattern:**
```javascript
const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
```

**Impact:** Token expiry times might be incorrect if timezone rules change.

**Fix:** Use a proper timezone library like `date-fns-tz` or `luxon`.

---

### 14. No Validation of Browser Pool Configuration
**Location:** `services/browserPool.js:436-440`

**Issue:** Environment variables are parsed with `parseInt()` but no validation is performed to ensure they're positive numbers.

**Impact:** Invalid configuration (negative numbers, NaN) could cause unexpected behavior.

**Fix:** Add validation for environment variables.

---

### 15. Database Query Logging in Production
**Location:** `config/database.js:66`

**Issue:** Every database query logs execution time, which could be verbose in production.

**Code Pattern:**
```javascript
console.log(`📊 Query executed in ${duration}ms`);
```

**Impact:** Log noise, potential performance impact, log storage costs.

**Fix:** Use logger with appropriate log level, or disable in production.

---

## Summary

**Total Bugs Identified:** 15
- **Critical:** 5
- **Medium:** 5  
- **Low Priority:** 5

**Recommended Next Steps:**
1. Instrument code with debug logs to verify these bugs occur in runtime
2. Fix critical bugs first (race conditions, resource leaks)
3. Add comprehensive tests for concurrent scenarios
4. Implement proper transaction handling for database operations
5. Add monitoring/alerting for browser pool health

---

## Testing Recommendations

1. **Concurrency Tests:**
   - Multiple simultaneous token refresh requests
   - Browser pool exhaustion scenarios
   - Circuit breaker state transitions

2. **Resource Leak Tests:**
   - Long-running server with multiple token refreshes
   - Browser disconnection scenarios
   - Server shutdown/restart cycles

3. **Database Consistency Tests:**
   - Concurrent token storage operations
   - Transaction rollback scenarios
   - Token invalidation edge cases
