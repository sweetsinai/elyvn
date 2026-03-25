const { withFallback, withTimeout, withRetry, CircuitBreaker } = require('../utils/resilience');

describe('withFallback', () => {
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
  });
});

describe('withTimeout', () => {
  it('should return result if asyncFn completes', async () => {
    const asyncFn = jest.fn().mockResolvedValue('done');
    const result = await withTimeout(asyncFn, 5000, 'test');
    expect(result).toBe('done');
  });

  it('should throw original error if asyncFn fails', async () => {
    const error = new Error('operation failed');
    const asyncFn = jest.fn().mockRejectedValue(error);
    await expect(withTimeout(asyncFn, 5000, 'test')).rejects.toThrow('operation failed');
  });
});

describe('withRetry', () => {
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

    const result = await withRetry(asyncFn, 3, 1, 'test');
    expect(result).toBe('success');
    expect(asyncFn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exceeded', async () => {
    const error = new Error('always fails');
    const asyncFn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(asyncFn, 3, 1, 'test')).rejects.toThrow('always fails');
    expect(asyncFn).toHaveBeenCalledTimes(3);
  });
});

describe('CircuitBreaker', () => {

  it('should start in closed state', () => {
    const breaker = new CircuitBreaker(() => {}, { serviceName: 'test' });
    expect(breaker.state).toBe('closed');
  });

  it('should allow calls when closed', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const breaker = new CircuitBreaker(fn, { serviceName: 'test' });

    const result = await breaker.call();
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalled();
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
  });

  it('should track failures within failure window', async () => {
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

    // Wait a bit and fail again - should still count as 2
    await new Promise(r => setTimeout(r, 50));
    await expect(breaker.call()).rejects.toThrow();
    expect(breaker.failures.length).toBe(2);
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
});
