# Debug Instrumentation Summary

**Date:** $(date)
**Status:** Code instrumented, ready for runtime verification

## Instrumentation Overview

Debug logs have been added to verify the following potential bugs:

### Hypothesis A: Race Condition in Browser Pool `acquire()`
**Location:** `services/browserPool.js:260-307`

**What we're testing:**
- Multiple concurrent requests acquiring the same browser
- Timing between checking `isIdle` and adding to `activeBrowsers`
- Browser state consistency

**Logs added:**
- `acquire()` entry: pool size, active browsers, max pool size
- Browser availability check: for each browser checked, logs idle status
- BEFORE adding to activeBrowsers: browser ID and current active browsers
- AFTER adding to activeBrowsers: browser ID and updated active browsers

**How to verify:**
1. Send 2-3 concurrent token refresh requests
2. Check logs for same browser ID being checked by multiple requests
3. Verify if same browser is added to activeBrowsers multiple times

---

### Hypothesis B: Circuit Breaker Failures Counter Never Resets
**Location:** `services/browserPool.js:141-160`

**What we're testing:**
- Circuit breaker failure counter only resets in HALF_OPEN state
- Failures accumulate even after successful operations in CLOSED state

**Logs added:**
- BEFORE recordFailure: current state and failure count
- AFTER recordFailure: updated state and failure count
- BEFORE recordSuccess: current state and failure count
- AFTER recordSuccess: updated state, failure count, and whether it was HALF_OPEN

**How to verify:**
1. Trigger 3 browser creation failures (to open circuit breaker)
2. Wait for HALF_OPEN state
3. Trigger successful browser creation
4. Check if failures counter resets to 0
5. Trigger another failure - verify if it immediately opens again

---

### Hypothesis C: Browser Disconnection Handling Race Condition
**Location:** `services/browserPool.js:232-235, 333-351`

**What we're testing:**
- Browser removed while still in activeBrowsers
- Disconnection event fires while browser is being used

**Logs added:**
- Browser disconnected event: browser ID, whether it's in activeBrowsers
- removeBrowser() entry: browser ID, whether it's in activeBrowsers

**How to verify:**
1. Acquire a browser
2. Force browser disconnection (kill Chrome process or network issue)
3. Check logs to see if browser was in activeBrowsers when disconnected
4. Verify if browser is properly cleaned up

---

### Hypothesis D: No Database Transaction in Token Storage
**Location:** `services/tokenManager.js:70-98`

**What we're testing:**
- Race condition between UPDATE (invalidate) and INSERT (new token)
- Multiple concurrent refreshes creating duplicate valid tokens

**Logs added:**
- storeToken() started: user ID, transaction status (false)
- BEFORE UPDATE: user ID
- AFTER UPDATE: user ID
- BEFORE INSERT: user ID
- AFTER INSERT: user ID

**How to verify:**
1. Send 2 concurrent token refresh requests for same user
2. Check logs for timing between UPDATE and INSERT operations
3. Query database to see if multiple valid tokens exist

---

### Hypothesis E: Server Shutdown Doesn't Clean Up Browser Pool
**Location:** `server.js:172-182, browserPool.js:407`

**What we're testing:**
- Browser pool shutdown not called during server shutdown
- Browser processes remain running after server stops

**Logs added:**
- SIGTERM/SIGINT received: whether browserPool.shutdown() will be called
- BEFORE process.exit(0): database ended status, browserPool shutdown status
- browserPool.shutdown() called: pool size, active browsers

**How to verify:**
1. Start server with active browsers in pool
2. Send SIGTERM or SIGINT to server
3. Check logs to see if browserPool.shutdown() was called
4. Check if browser processes are still running after server stops

---

### Hypothesis F: Browser Release Doesn't Verify Connection State
**Location:** `services/browserPool.js:321-328`

**What we're testing:**
- Disconnected browsers released back to pool
- Future acquire() calls return broken browsers

**Logs added:**
- release() called: browser ID, browser exists, is connected status

**How to verify:**
1. Acquire a browser
2. Force browser disconnection
3. Release browser back to pool
4. Check logs to see if disconnected browser was released
5. Try to acquire browser again - verify if broken browser is returned

---

### Hypothesis G: Request Interception Race Condition
**Location:** `services/tokenFetcher.js:31-43, 191`

**What we're testing:**
- Requests occurring before interception listener is attached
- Token extraction missed due to timing

**Logs added:**
- Page created, BEFORE setting up interception
- Request interception enabled, BEFORE attaching listener
- Request intercepted: URL, has request_token
- BEFORE page.goto() - navigation starting

**How to verify:**
1. Monitor logs during token fetch
2. Check timing between interception setup and navigation
3. Verify if any requests occur before listener is attached
4. Check if token is successfully intercepted

---

### Hypothesis I: Page Cleanup Failures May Be Silent
**Location:** `services/tokenFetcher.js:930-936`

**What we're testing:**
- Page.close() failures in error handler
- Page leaks going unnoticed

**Logs added:**
- BEFORE page.close() in error handler
- AFTER page.close() SUCCESS
- page.close() FAILED: error message

**How to verify:**
1. Trigger an error during token fetch
2. Check logs for page.close() success/failure
3. Monitor for page leaks over multiple error scenarios

---

### Hypothesis J: Scheduler Doesn't Handle Concurrent Cron Triggers
**Location:** `services/scheduler.js:51-55`

**What we're testing:**
- Concurrent cron triggers silently ignored
- No visibility into skipped executions

**Logs added:**
- refreshAllTokens() called: isRunning status
- refreshAllTokens() skipped - already running: isRunning status

**How to verify:**
1. Manually trigger refreshAllTokens() twice quickly
2. Check logs to see if second call is skipped
3. Verify if skipped execution is logged

---

## Test Scenarios

### Scenario 1: Concurrent Browser Acquisition
**Purpose:** Verify race condition in acquire()
**Steps:**
1. Start server
2. Send 3 concurrent POST requests to `/api/tokens/refresh` (same user)
3. Check logs for browser acquisition patterns

### Scenario 2: Circuit Breaker Recovery
**Purpose:** Verify failure counter reset behavior
**Steps:**
1. Cause 3 browser creation failures (e.g., invalid Chrome path)
2. Wait for circuit breaker to open
3. Wait for HALF_OPEN state
4. Trigger successful browser creation
5. Check if failures counter resets

### Scenario 3: Concurrent Token Refresh
**Purpose:** Verify database transaction race condition
**Steps:**
1. Send 2 concurrent token refresh requests for same user
2. Check database for duplicate valid tokens
3. Review logs for UPDATE/INSERT timing

### Scenario 4: Server Shutdown
**Purpose:** Verify browser pool cleanup
**Steps:**
1. Start server
2. Trigger a token refresh (creates browser)
3. Send SIGTERM to server
4. Check logs for browserPool.shutdown() call
5. Verify browser processes are terminated

### Scenario 5: Browser Disconnection
**Purpose:** Verify disconnection handling
**Steps:**
1. Acquire browser
2. Kill Chrome process externally
3. Check logs for disconnection event
4. Verify browser cleanup

---

## Log File Location

**Path:** `/Users/Chanakya/.cursor/debug.log`
**Format:** NDJSON (one JSON object per line)

## Next Steps

1. **Clear log file** (already done)
2. **Run test scenarios** above
3. **Analyze logs** to confirm/reject hypotheses
4. **Fix confirmed bugs** based on evidence
5. **Re-run tests** to verify fixes

---

## Expected Log Patterns

### If Bug A (Race Condition) Exists:
- Same browser ID appears in "BEFORE adding" logs from multiple requests
- Same browser ID appears multiple times in "AFTER adding" activeBrowsers arrays

### If Bug B (Circuit Breaker) Exists:
- After successful operation in CLOSED state, failures counter remains > 0
- Only resets when transitioning from HALF_OPEN to CLOSED

### If Bug D (Database Transaction) Exists:
- Two concurrent requests show overlapping UPDATE/INSERT operations
- Database query shows multiple valid tokens for same user

### If Bug E (Shutdown) Exists:
- SIGTERM/SIGINT logs show `browserPoolShutdownCalled: false`
- browserPool.shutdown() logs never appear
