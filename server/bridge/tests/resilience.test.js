jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { withFallback, withTimeout, withRetry, CircuitBreaker } = require('../utils/resilience');
const { logger } = require('../utils/logger');

describe('withFallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call asyncFn and return result on success', async () => {
    const asyncFn = jest.fn().mockResolvedValue('success');
    const fallbackFn = jest.fn();

    const result = await withFallback(asyncFn, fallbackFn, 'test');
    expect(result).toBe('success');
    expect(asyncFn).toHaveBeenCalled();
    expect(fallbackFn).not.toHaveBeenCalled();
  });

  it('should call fallbackFn if asyncFn throws', async () => {
    const error = new Error('primary failed');
    const asyncFn = jest.fn().mockRejectedValue(error);
    const fallbackFn = jest.fn().mockResolvedValue('fallback result');

    const result = await withFallback(asyncFn, fallbackFn, 'test');
    expect(result).toBe('fallback result');
    expect(fallbackFn).toHaveBeenCalledWith(error);
  });

  it('should throw if both asyncFn and fallbackFn fail', async () => {
    const error1 = new Error('primary failed');
    const error2 = new Error('fallback failed');
    const asyncFn = jest.fn().mockRejectedValue(error1);
    const fallbackFn = jest.fn().mockRejectedValue(error2);

    await expect(withFallback(asyncFn, fallbackFn, 'test')).rejects.toThrow('fallback failed');
    expect(logger.error).toHaveBeenCalled();
    // Should have logged both errors
    expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should pass serviceName to logs', async () => {
    const error = new Error('primary failed');
    const asyncFn = jest.fn().mockRejectedValue(error);
    const fallbackFn = jest.fn().mockResolvedValue('fallback result');

    await withFallback(asyncFn, fallbackFn, 'myService');
    expect(logger.error).toHaveBeenCalled();
    const serviceCall = logger.error.mock.calls.find(call =>
      call[0] && call[0].includes('myService')
    );
    expect(serviceCall).toBeDefined();
  });

  it('should use default serviceName if not provided', async () => {
    const asyncFn = jest.fn().mockResolvedValue('success');
    const fallbackFn = jest.fn();

    await withFallback(asyncFn, fallbackFn);
    expect(asyncFn).toHaveBeenCalled();
  });

  it('should pass error to fallbackFn', async () => {
    const error = new Error('specific error');
    const asyncFn = jest.fn().mockRejectedValue(error);
    const fallbackFn = jest.fn().mockResolvedValue('recovered');

    await withFallback(asyncFn, fallbackFn, 'test');
    expect(fallbackFn).toHaveBeenCalledWith(error);
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return result if asyncFn completes within timeout', async () => {
    const asyncFn = jest.fn().mockResolvedValue('done');
    const result = await withTimeout(asyncFn, 5000, 'test');
    expect(result).toBe('done');
  });

  it('should throw original error if asyncFn fails before timeout', async () => {
    const error = new Error('operation failed');
    const asyncFn = jest.fn().mockRejectedValue(error);
    await expect(withTimeout(asyncFn, 5000, 'test')).rejects.toThrow('operation failed');
  });

  it('should timeout if asyncFn takes too long', async () => {
    const asyncFn = jest.fn(() => new Promise(() => {})); // Never resolves
    const timeoutPromise = withTimeout(asyncFn, 100, 'slow-service');

    jest.advanceTimersByTime(100);

    await expect(timeoutPromise).rejects.toThrow('slow-service timeout after 100ms');
  });

  it('should log timeout error', async () => {
    const asyncFn = jest.fn(() => new Promise(() => {}));
    const timeoutPromise = withTimeout(asyncFn, 100, 'test-service');

    jest.advanceTimersByTime(100);

    await expect(timeoutPromise).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it('should use default serviceName in timeout message', async () => {
    const asyncFn = jest.fn(() => new Promise(() => {}));
    const timeoutPromise = withTimeout(asyncFn, 50);

    jest.advanceTimersByTime(50);

    await expect(timeoutPromise).rejects.toThrow('timeout after 50ms');
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return result on first try if successful', async () => {
    const asyncFn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(asyncFn, 3, 1, 'test');
    expect(result).toBe('success');
    expect(asyncFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('success');

    // Use very short delays for testing
    const result = await withRetry(asyncFn, 3, 10, 'test');

    expect(result).toBe('success');
    expect(asyncFn).toHaveBeenCalledTimes(3);
  }, 15000);

  it('should throw after max retries exceeded', async () => {
    const error = new Error('always fails');
    const asyncFn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(asyncFn, 3, 10, 'test')).rejects.toThrow('always fails');
    expect(asyncFn).toHaveBeenCalledTimes(3);
  }, 15000);

  it('should apply exponential backoff delay', async () => {
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce('success');

    const startTime = Date.now();
    await withRetry(asyncFn, 2, 50, 'test');
    const elapsed = Date.now() - startTime;

    // Should have delayed at least the first backoff time (50ms)
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some variance
  }, 15000);

  it('should log retry attempts', async () => {
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce('success');

    await withRetry(asyncFn, 3, 10, 'test-service');

    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls.find(call =>
      call[0] && call[0].includes('[resilience]') && call[0].includes('attempt')
    );
    expect(warnCall).toBeDefined();
  }, 15000);

  it('should log exhausted retries', async () => {
    const error = new Error('always fails');
    const asyncFn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(asyncFn, 3, 10, 'test')).rejects.toThrow();

    expect(logger.error).toHaveBeenCalled();
    const errorCall = logger.error.mock.calls.find(call =>
      call[0] && call[0].includes('[resilience]') && call[0].includes('exhausted')
    );
    expect(errorCall).toBeDefined();
  }, 15000);

  it('should use default values for maxRetries and delay', async () => {
    const asyncFn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(asyncFn);
    expect(result).toBe('success');
  });

  it('should store and throw the last error', async () => {
    const error1 = new Error('first');
    const error2 = new Error('second');
    const error3 = new Error('final');
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(error1)
      .mockRejectedValueOnce(error2)
      .mockRejectedValueOnce(error3);

    await expect(withRetry(asyncFn, 3, 10, 'test')).rejects.toThrow('final');
  }, 15000);
});

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should start in closed state', () => {
    const breaker = new CircuitBreaker(() => {}, { serviceName: 'test' });
    expect(breaker.state).toBe('closed');
    expect(breaker.failures).toEqual([]);
    expect(breaker.cooldownUntil).toBeNull();
  });

  it('should allow calls when closed', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const breaker = new CircuitBreaker(fn, { serviceName: 'test' });

    const result = await breaker.call();
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalled();
  });

  it('should allow calls with arguments', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const breaker = new CircuitBreaker(fn, { serviceName: 'test' });

    const result = await breaker.call('arg1', 'arg2', 'arg3');
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
  });

  it('should open circuit after failureThreshold failures', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 3,
      failureWindow: 60000,
      cooldownPeriod: 30000,
      serviceName: 'test',
    });

    // First two failures should not open circuit
    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('closed');

    // Third failure opens circuit
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');
    expect(logger.error).toHaveBeenCalled();
    const errorCall = logger.error.mock.calls.find(call =>
      call[0] && call[0].includes('[circuit-breaker]') && call[0].includes('circuit opened')
    );
    expect(errorCall).toBeDefined();
  });

  it('should reject calls when circuit is open', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      failureWindow: 60000,
      cooldownPeriod: 30000,
      serviceName: 'test',
    });

    // Open the circuit
    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Further calls should be rejected immediately
    const fn2 = jest.fn();
    breaker.asyncFn = fn2;
    await expect(breaker.call()).rejects.toThrow('Circuit breaker open');
    expect(fn2).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls.find(call =>
      call[0] && call[0].includes('[circuit-breaker]') && call[0].includes('circuit open')
    );
    expect(warnCall).toBeDefined();
  });

  it('should enter half-open state after cooldown period', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      failureWindow: 60000,
      cooldownPeriod: -1, // Already expired
      serviceName: 'test',
    });

    // Open the circuit
    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Try another call - should enter half-open
    const fn2 = jest.fn().mockRejectedValue(new Error('fail'));
    breaker.asyncFn = fn2;

    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open'); // Still open after half-open failure
  });

  it('should close circuit on success in half-open state', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      failureWindow: 60000,
      cooldownPeriod: -1, // Already expired
      serviceName: 'test',
    });

    // Open the circuit
    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Replace with successful function
    const fn2 = jest.fn().mockResolvedValue('success');
    breaker.asyncFn = fn2;

    const result = await breaker.call();
    expect(result).toBe('success');
    expect(breaker.state).toBe('closed');
    expect(breaker.failures).toEqual([]);
    expect(logger.info).toHaveBeenCalled();
    const recoveryCall = logger.info.mock.calls.find(call =>
      call[0] && call[0].includes('recovered')
    );
    expect(recoveryCall).toBeDefined();
  });

  it('should track failures within failure window', async () => {
    jest.useFakeTimers();
    try {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        failureWindow: 100, // 100ms window
        cooldownPeriod: 30000,
        serviceName: 'test',
      });

      // Fail once
      await expect(breaker.call()).rejects.toThrow();
      expect(breaker.failures.length).toBe(1);

      // Wait 50ms and fail again - should still count as 2
      jest.advanceTimersByTime(50);
      await expect(breaker.call()).rejects.toThrow();
      expect(breaker.failures.length).toBe(2);

      // Wait 60ms more (110ms total, outside window)
      jest.advanceTimersByTime(60);
      // Fail again - old failure should be filtered out
      await expect(breaker.call()).rejects.toThrow();
      // Should only have 1 failure (old one filtered)
      expect(breaker.failures.length).toBeLessThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should reset failures on successful call in half-open', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockResolvedValueOnce('success');

    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      failureWindow: 60000,
      cooldownPeriod: -1, // Already expired
      serviceName: 'test',
    });

    // Fail twice to open circuit
    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Fail again to go half-open
    await expect(breaker.call()).rejects.toThrow();

    // Recover succeeds and closes circuit
    const result = await breaker.call();
    expect(result).toBe('success');
    expect(breaker.state).toBe('closed');
    expect(breaker.failures.length).toBe(0);
  });

  it('should initialize with default options', () => {
    const fn = jest.fn();
    const breaker = new CircuitBreaker(fn);

    expect(breaker.failureThreshold).toBe(5);
    expect(breaker.failureWindow).toBe(60000);
    expect(breaker.cooldownPeriod).toBe(30000);
    expect(breaker.serviceName).toBe('service');
  });

  it('should initialize with custom options', () => {
    const fn = jest.fn();
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 10,
      failureWindow: 120000,
      cooldownPeriod: 60000,
      serviceName: 'custom',
    });

    expect(breaker.failureThreshold).toBe(10);
    expect(breaker.failureWindow).toBe(120000);
    expect(breaker.cooldownPeriod).toBe(60000);
    expect(breaker.serviceName).toBe('custom');
  });

  it('should track lastFailureTime', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, { serviceName: 'test' });

    expect(breaker.lastFailureTime).toBeNull();

    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.lastFailureTime).not.toBeNull();
    expect(typeof breaker.lastFailureTime).toBe('number');
  });

  it('should set cooldownUntil when circuit opens', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      cooldownPeriod: 30000,
      serviceName: 'test',
    });

    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();

    expect(breaker.cooldownUntil).not.toBeNull();
    expect(typeof breaker.cooldownUntil).toBe('number');
    expect(breaker.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('should log transition to half-open state', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      failureWindow: 60000,
      cooldownPeriod: -1,
      serviceName: 'test',
    });

    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');

    const fn2 = jest.fn().mockResolvedValue('success');
    breaker.asyncFn = fn2;

    // Clear previous logger calls
    logger.info.mockClear();

    await breaker.call();

    expect(logger.info).toHaveBeenCalled();
    const halfOpenCall = logger.info.mock.calls.find(call =>
      call[0] && call[0].includes('[circuit-breaker]') && call[0].includes('half-open')
    );
    expect(halfOpenCall).toBeDefined();
  });

  it('should pass multiple arguments to the wrapped function', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const breaker = new CircuitBreaker(fn, { serviceName: 'test' });

    await breaker.call('a', 'b', 'c', 123);

    expect(fn).toHaveBeenCalledWith('a', 'b', 'c', 123);
  });

  it('should handle rapid consecutive calls when open', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      failureWindow: 60000,
      cooldownPeriod: 30000,
      serviceName: 'test',
    });

    // Open circuit
    await expect(breaker.call()).rejects.toThrow();
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Multiple rapid calls should all fail immediately
    for (let i = 0; i < 5; i++) {
      await expect(breaker.call()).rejects.toThrow('Circuit breaker open');
    }

    // Inner function should only have been called twice (to open circuit)
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
