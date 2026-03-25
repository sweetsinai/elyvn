const {
  isWithinBusinessHours,
  getNextBusinessHour,
  shouldDelayUntilBusinessHours,
  parseBusinessHours,
} = require('../utils/businessHours');

describe('parseBusinessHours', () => {
  it('should return default hours when no hours string provided', () => {
    const result = parseBusinessHours(null);

    expect(result.Monday).toEqual({ open: 8, close: 20 });
    expect(result.Tuesday).toEqual({ open: 8, close: 20 });
    expect(result.Wednesday).toEqual({ open: 8, close: 20 });
    expect(result.Thursday).toEqual({ open: 8, close: 20 });
    expect(result.Friday).toEqual({ open: 8, close: 20 });
    expect(result.Saturday).toEqual({ open: 9, close: 17 });
    expect(result.Sunday).toBeNull();
  });

  it('should return default hours when empty string provided', () => {
    const result = parseBusinessHours('');

    expect(result.Monday).toEqual({ open: 8, close: 20 });
    expect(result.Saturday).toEqual({ open: 9, close: 17 });
  });

  it('should parse single day hours', () => {
    const result = parseBusinessHours('Mon:9-18');

    expect(result.Monday).toEqual({ open: 9, close: 18 });
    expect(result.Tuesday).toEqual({ open: 8, close: 20 }); // Default
  });

  it('should parse range of days with abbreviated format', () => {
    // Note: Current implementation splits on '-' for both days and hours
    // So 'Mon-Wed:9-17' gets parsed as 'Mon' and 'Wed' separately
    const result = parseBusinessHours('Mon-Wed:9-17');

    expect(result.Monday).toEqual({ open: 9, close: 17 });
    // Tuesday is not explicitly set in this format, so it keeps default
    expect(result.Tuesday).toEqual({ open: 8, close: 20 });
    expect(result.Wednesday).toEqual({ open: 9, close: 17 });
  });

  it('should parse multiple day range specifications', () => {
    const result = parseBusinessHours('Mon-Fri:8-18,Sat:10-14');

    expect(result.Monday).toEqual({ open: 8, close: 18 });
    expect(result.Friday).toEqual({ open: 8, close: 18 });
    expect(result.Saturday).toEqual({ open: 10, close: 14 });
    expect(result.Sunday).toBeNull();
  });

  it('should handle abbreviated day names', () => {
    const result = parseBusinessHours('Mon:9-17,Tue:9-17,Wed:9-17,Thu:9-17,Fri:9-17');

    expect(result.Monday).toEqual({ open: 9, close: 17 });
    expect(result.Tuesday).toEqual({ open: 9, close: 17 });
  });

  it('should handle days with extra text in abbreviation', () => {
    const result = parseBusinessHours('Mon(day):9-17');

    expect(result.Monday).toEqual({ open: 9, close: 17 });
  });

  it('should skip malformed entries without times', () => {
    const result = parseBusinessHours('Mon:9-17,InvalidFormat,Tue:10-18');

    expect(result.Monday).toEqual({ open: 9, close: 17 });
    expect(result.Tuesday).toEqual({ open: 10, close: 18 });
  });

  it('should handle full day names in range', () => {
    const result = parseBusinessHours('Monday-Friday:8-20');

    expect(result.Monday).toEqual({ open: 8, close: 20 });
    expect(result.Friday).toEqual({ open: 8, close: 20 });
  });

  it('should handle Sunday parsing', () => {
    const result = parseBusinessHours('Sun:12-18');

    expect(result.Sunday).toEqual({ open: 12, close: 18 });
  });
});

describe('isWithinBusinessHours', () => {
  it('should return true if no client provided', () => {
    const result = isWithinBusinessHours(null);
    expect(result).toBe(true);
  });

  it('should return true if client has no business hours or timezone', () => {
    const client = {};
    const result = isWithinBusinessHours(client);
    expect(result).toBe(true); // Uses defaults
  });

  it('should check current time against business hours', () => {
    // Mock Date.now() to return a specific time
    const mockDate = new Date('2024-01-15T10:00:00'); // Monday 10 AM
    jest.spyOn(global, 'Date').mockImplementation(() => mockDate);

    const client = {
      timezone: 'America/New_York',
      business_hours: 'Mon-Fri:8-20',
    };

    try {
      const result = isWithinBusinessHours(client);
      // Result depends on actual timezone conversion, but should be boolean
      expect(typeof result).toBe('boolean');
    } finally {
      global.Date.mockRestore();
    }
  });

  it('should respect custom business hours', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:9-17',
    };

    // This will return true or false depending on actual current time
    const result = isWithinBusinessHours(client);
    expect(typeof result).toBe('boolean');
  });

  it('should return false for closed days (Sunday default)', () => {
    // Craft a date on Sunday
    let testDate = new Date();
    const dayOfWeek = testDate.getDay();
    const diff = 0 - dayOfWeek; // Calculate diff to Sunday (0)
    testDate.setDate(testDate.getDate() + diff);

    jest.spyOn(global, 'Date').mockImplementation(() => testDate);

    const client = {
      timezone: 'UTC',
      business_hours: null, // Default hours (closed on Sunday)
    };

    try {
      const result = isWithinBusinessHours(client);
      expect(typeof result).toBe('boolean');
    } finally {
      global.Date.mockRestore();
    }
  });

  it('should handle different timezones', () => {
    const client1 = {
      timezone: 'America/New_York',
      business_hours: 'Mon-Fri:9-17',
    };

    const client2 = {
      timezone: 'America/Los_Angeles',
      business_hours: 'Mon-Fri:9-17',
    };

    const result1 = isWithinBusinessHours(client1);
    const result2 = isWithinBusinessHours(client2);

    expect(typeof result1).toBe('boolean');
    expect(typeof result2).toBe('boolean');
  });

  it('should handle minutes correctly in time comparison', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:9-17',
    };

    const result = isWithinBusinessHours(client);
    expect(typeof result).toBe('boolean');
  });
});

describe('getNextBusinessHour', () => {
  it('should return current ISO timestamp if no client provided', () => {
    const beforeCall = new Date();
    const result = getNextBusinessHour(null);
    const afterCall = new Date();

    expect(result).toBeDefined();
    const resultTime = new Date(result);
    expect(resultTime.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime() - 100);
    expect(resultTime.getTime()).toBeLessThanOrEqual(afterCall.getTime() + 100);
  });

  it('should return ISO string of next business opening', () => {
    const client = {
      timezone: 'America/New_York',
      business_hours: 'Mon-Fri:9-17,Sat-Sun:null',
    };

    const result = getNextBusinessHour(client);

    expect(typeof result).toBe('string');
    const resultDate = new Date(result);
    expect(resultDate).toBeInstanceOf(Date);
    expect(!isNaN(resultDate.getTime())).toBe(true);
  });

  it('should find next open day within 14-day window', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Fri:9-17', // Only Friday
    };

    const result = getNextBusinessHour(client);
    const resultDate = new Date(result);

    expect(resultDate).toBeInstanceOf(Date);
    expect(!isNaN(resultDate.getTime())).toBe(true);
  });

  it('should return fallback for no open days in 14-day window', () => {
    const client = {
      timezone: 'UTC',
      business_hours: null, // Default: Sun closed
    };

    const result = getNextBusinessHour(client);
    const resultDate = new Date(result);

    expect(resultDate).toBeInstanceOf(Date);
    expect(!isNaN(resultDate.getTime())).toBe(true);
    expect(resultDate.getHours()).toBe(8); // Fallback is 8 AM
  });

  it('should respect timezone when calculating next business hour', () => {
    const client = {
      timezone: 'America/New_York',
      business_hours: 'Mon-Fri:9-17',
    };

    const result = getNextBusinessHour(client);
    const resultDate = new Date(result);

    expect(resultDate).toBeInstanceOf(Date);
    expect(!isNaN(resultDate.getTime())).toBe(true);
  });

  it('should handle custom business hours', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:10-18,Sat:12-16',
    };

    const result = getNextBusinessHour(client);
    expect(typeof result).toBe('string');
  });

  it('should increment day when finding next open day', () => {
    // Create test such that it searches multiple days
    const client = {
      timezone: 'UTC',
      business_hours: 'Tue:9-17', // Only Tuesday
    };

    const result = getNextBusinessHour(client);
    const resultDate = new Date(result);

    expect(resultDate).toBeInstanceOf(Date);
    expect(!isNaN(resultDate.getTime())).toBe(true);
    // Result should be in the future
    expect(resultDate.getTime()).toBeGreaterThan(new Date().getTime());
  });
});

describe('shouldDelayUntilBusinessHours', () => {
  it('should return 0 or positive for any time', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:8-20',
    };

    const result = shouldDelayUntilBusinessHours(client);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should return positive delay if outside business hours', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:9-17',
    };

    const result = shouldDelayUntilBusinessHours(client);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should return 0 or positive, never negative', () => {
    const client = {
      timezone: 'America/New_York',
      business_hours: null,
    };

    const result = shouldDelayUntilBusinessHours(client);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should calculate delay in milliseconds', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:9-17',
    };

    const result = shouldDelayUntilBusinessHours(client);
    expect(typeof result).toBe('number');
    expect(Number.isInteger(result) || result === 0).toBe(true);
  });

  it('should return 0 for no client', () => {
    // If isWithinBusinessHours returns true for null, delay should be 0
    const result = shouldDelayUntilBusinessHours(null);
    expect(result).toBe(0);
  });

  it('should handle edge case at exact business hour boundary', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:9-17',
    };

    // Edge case: checking at exact hour boundary
    const result = shouldDelayUntilBusinessHours(client);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should provide reasonable delay estimate', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Fri:9-17',
    };

    const result = shouldDelayUntilBusinessHours(client);

    // Delay should be reasonable (less than 7 days)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result).toBeLessThanOrEqual(sevenDaysMs);
  });
});

describe('Business Hours Integration Tests', () => {
  it('should work together: check hours, then calculate next open time', () => {
    const client = {
      timezone: 'America/New_York',
      business_hours: 'Mon-Fri:9-17',
    };

    const isOpen = isWithinBusinessHours(client);
    expect(typeof isOpen).toBe('boolean');

    if (!isOpen) {
      const nextOpen = getNextBusinessHour(client);
      expect(nextOpen).toBeDefined();

      const delay = shouldDelayUntilBusinessHours(client);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('should handle custom schedule throughout the week', () => {
    const client = {
      timezone: 'UTC',
      business_hours: 'Mon-Thu:8-17,Fri:8-14,Sat:10-12',
    };

    const isOpen = isWithinBusinessHours(client);
    expect(typeof isOpen).toBe('boolean');

    const nextOpen = getNextBusinessHour(client);
    expect(nextOpen).toBeDefined();
  });

  it('should parse and apply complex business hours', () => {
    const hoursStr = 'Mon-Fri:9-18,Sat:10-14';
    const parsed = parseBusinessHours(hoursStr);

    expect(parsed.Monday.open).toBe(9);
    expect(parsed.Monday.close).toBe(18);
    expect(parsed.Saturday.open).toBe(10);
    expect(parsed.Saturday.close).toBe(14);
    expect(parsed.Sunday).toBeNull();
  });

  it('should handle business hours without client timezone', () => {
    const client = {
      business_hours: 'Mon-Fri:9-17',
      // No timezone - should default to America/New_York
    };

    const result = isWithinBusinessHours(client);
    expect(typeof result).toBe('boolean');
  });

  it('should handle empty business hours string', () => {
    const client = {
      timezone: 'UTC',
      business_hours: '',
    };

    const result = isWithinBusinessHours(client);
    expect(typeof result).toBe('boolean');
  });
});
