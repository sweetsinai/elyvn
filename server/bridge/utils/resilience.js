/**
 * Graceful Degradation & Resilience
 * Wraps async operations with timeout, retry, and circuit breaker patterns
 */

/**
 * Wrap an async function with fallback
 * @param {function} asyncFn - The async function to call
 * @param {function} fallbackFn - Fallback function if asyncFn fails
 * @param {string} serviceName - Name for logging
 * @returns {Promise} Result from asyncFn or fallbackFn
 */
async function withFallback(asyncFn, fallbackFn, serviceName = 'service') {
  try {
    return await asyncFn();
  } catch (err) {
    console.error(`[resilience] ${serviceName} failed:`, err.message);
    try {
      return await fallbackFn(err);
    } catch (fallbackErr) {
      console.error(`[resilience] ${serviceName} fallback also failed:`, fallbackErr.message);
      throw fallbackErr;
    }
  }
}

/**
 * Wrap an async function with timeout
 * @param {function} asyncFn - The async function (optionally receives AbortSignal)
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} serviceName - Name for logging
 * @returns {Promise} Result or timeout error
 */
async function withTimeout(asyncFn, timeoutMs, serviceName = 'service') {
  const controller = new AbortController();
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${serviceName} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([asyncFn(controller.signal), timeoutPromise]);
  } catch (err) {
    console.error(`[resilience] ${serviceName} timeout or error:`, err.message);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Wrap an async function with exponential backoff retry
 * @param {function} asyncFn - The async function
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} delayMs - Initial delay in milliseconds
 * @param {string} serviceName - Name for logging
 * @returns {Promise} Result from asyncFn
 */
async function withRetry(asyncFn, maxRetries = 3, delayMs = 1000, serviceName = 'service') {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await asyncFn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const backoffMs = delayMs * Math.pow(2, attempt - 1);
        console.warn(`[resilience] ${serviceName} attempt ${attempt} failed, retry in ${backoffMs}ms:`, err.message);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  console.error(`[resilience] ${serviceName} exhausted ${maxRetries} retries`);
  throw lastError;
}

/**
 * Circuit breaker for cascading failures
 * Tracks failures and opens circuit after threshold
 */
class CircuitBreaker {
  constructor(asyncFn, options = {}) {
    this.asyncFn = asyncFn;
    this.failureThreshold = options.failureThreshold || 5;
    this.failureWindow = options.failureWindow || 60000; // 1 min
    this.cooldownPeriod = options.cooldownPeriod || 30000; // 30 sec
    this.serviceName = options.serviceName || 'service';

    this.state = 'closed'; // closed | open | half-open
    this.failures = [];
    this.lastFailureTime = null;
    this.cooldownUntil = null;
  }

  async call(...args) {
    // Check if in cooldown
    if (this.state === 'open') {
      if (Date.now() < this.cooldownUntil) {
        const remaining = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
        console.warn(`[circuit-breaker] ${this.serviceName} circuit open (${remaining}s remaining)`);
        throw new Error(`Circuit breaker open for ${this.serviceName}`);
      }
      // Try half-open
      this.state = 'half-open';
      console.log(`[circuit-breaker] ${this.serviceName} entering half-open state`);
    }

    try {
      const result = await this.asyncFn(...args);
      // Success — reset failures
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = [];
        console.log(`[circuit-breaker] ${this.serviceName} circuit closed (recovered)`);
      }
      return result;
    } catch (err) {
      // Record failure
      const now = Date.now();
      this.failures = this.failures.filter(t => now - t < this.failureWindow);
      this.failures.push(now);
      this.lastFailureTime = now;

      // Check if threshold exceeded
      if (this.failures.length >= this.failureThreshold) {
        this.state = 'open';
        this.cooldownUntil = now + this.cooldownPeriod;
        console.error(
          `[circuit-breaker] ${this.serviceName} circuit opened (${this.failures.length} failures in ${this.failureWindow}ms)`
        );
      }

      throw err;
    }
  }
}

module.exports = { withFallback, withTimeout, withRetry, CircuitBreaker };
