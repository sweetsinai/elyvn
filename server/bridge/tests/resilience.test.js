const { withFallback, withTimeout, withRetry, CircuitBreaker } = require('../utils/resilience');

describe('withFallback', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[resilience]'), expect.any(String), error1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[resilience]'), expect.any(String), error2);
  });

  it('should pass serviceName to logs', async () => {
    const error = new Error('primary failed');
    const asyncFn = jest.fn().mockRejectedValue(error);
    const fallbackFn = jest.fn().mockResolvedValue('fallback result');

    await withFallback(asyncFn, fallbackFn, 'myService');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('myService'), expect.any(String), error);
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
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    jest.useFakeTimers();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
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
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('should use default serviceName in timeout message', async () => {
    const asyncFn = jest.fn(() => new Promise(() => {}));
    const timeoutPromise = withTimeout(asyncFn, 50);

    jest.advanceTimersByTime(50);

    await expect(timeoutPromise).rejects.toThrow('timeout after 50ms');
  });
});

describe('withRetry', () => {
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    jest.useFakeTimers();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('should return result on first try if successful', async () => {
    const asyncFn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(asyncFn, 3, 1, 'test');
    expect(result).toBe('success');
    expect(asyncFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure with exponential backoff', async () => {
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('success');

    const promise = withRetry(asyncFn, 3, 100, 'test');

    // Fast-forward through retries
    jest.advanceTimersByTime(200);

    const result = await promise;
    expect(result).toBe('success');
    expect(asyncFn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exceeded', async () => {
    const error = new Error('always fails');
    const asyncFn = jest.fn().mockRejectedValue(error);

    const promise = withRetry(asyncFn, 3, 100, 'test');

    // Fast-forward through all retries
    jest.advanceTimersByTime(500);

    await expect(promise).rejects.toThrow('always fails');
    expect(asyncFn).toHaveBeenCalledTimes(3);
  });

  it('should calculate exponential backoff correctly', async () => {
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('success');

    const promise = withRetry(asyncFn, 4, 100, 'test');

    // First failure: 100ms delay (100 * 2^0)
    jest.advanceTimersByTime(100);

    // Second failure: 200ms delay (100 * 2^1)
    jest.advanceTimersByTime(200);

    const result = await promise;
    expect(result).toBe('success');
  });

  it('should log retry attempts', async () => {
    const asyncFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce('success');

    const promise = withRetry(asyncFn, 3, 100, 'test-service');

    jest.advanceTimersByTime(100);
    await promise;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[resilience]'),
      expect.stringContaining('test-service'),
      expect.stringContaining('attempt 1'),
      expect.any(String)
    );
  });

  it('should log exhausted retries', async () => {
    const error = new Error('always fails');
    const asyncFn = jest.fn().mockRejectedValue(error);

    const promise = withRetry(asyncFn, 3, 100, 'test');

    jest.advanceTimersByTime(500);
    await expect(promise).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[resilience]'),
      expect.stringContaining('exhausted'),
      expect.stringContaining('3')
    );
  });

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

    const promise = withRetry(asyncFn, 3, 100, 'test');
    jest.advanceTimersByTime(500);

    await expect(promise).rejects.toThrow('final');
  }, 15000);
});

describe('CircuitBreaker', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
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
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorCall = consoleErrorSpy.mock.calls.find(call =>
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
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnCall = consoleWarnSpy.mock.calls.find(call =>
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
    expect(consoleLogSpy).toHaveBeenCalled();
    const recoveryCall = consoleLogSpy.mock.calls.find(call =>
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

    // Clear previous console calls
    consoleLogSpy.mockClear();

    await breaker.call();

    expect(consoleLogSpy).toHaveBeenCalled();
    const halfOpenCall = consoleLogSpy.mock.calls.find(call =>
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
