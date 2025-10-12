/**
 * Retry utility with exponential backoff
 */

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxAttempts - Maximum number of attempts (default: 3)
 * @param {Function} onRetry - Callback called on each retry (error, attemptNumber)
 * @returns {Promise} - Result of successful function call
 */
async function retryWithBackoff(fn, maxAttempts = 3, onRetry = null) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxAttempts) {
        throw error;
      }
      
      // Call onRetry callback if provided
      if (onRetry) {
        onRetry(error, attempt);
      }
      
      // Exponential backoff: 2^attempt seconds
      // Attempt 1: 2s, Attempt 2: 4s, Attempt 3: 8s
      const delayMs = Math.pow(2, attempt) * 1000;
      
      console.log(`⏳ Waiting ${delayMs / 1000}s before retry ${attempt + 1}/${maxAttempts}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  throw lastError;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  retryWithBackoff,
  sleep
};

