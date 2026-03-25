const { normalizePhone } = require('../utils/phone');

describe('normalizePhone', () => {
  it('should normalize 10-digit US number to +1XXXXXXXXXX', () => {
    expect(normalizePhone('2125551234')).toBe('+12125551234');
  });

  it('should normalize 10-digit with dashes', () => {
    expect(normalizePhone('212-555-1234')).toBe('+12125551234');
  });

  it('should normalize 10-digit with parentheses', () => {
    expect(normalizePhone('(212) 555-1234')).toBe('+12125551234');
  });

  it('should normalize 10-digit with spaces', () => {
    expect(normalizePhone('212 555 1234')).toBe('+12125551234');
  });

  it('should normalize 11-digit with leading 1 to +1XXXXXXXXXX', () => {
    expect(normalizePhone('12125551234')).toBe('+12125551234');
  });

  it('should handle already normalized format', () => {
    expect(normalizePhone('+12125551234')).toBe('+12125551234');
  });

  it('should handle international number with + prefix', () => {
    expect(normalizePhone('+442071234567')).toBe('+442071234567');
  });

  it('should return null for null input', () => {
    expect(normalizePhone(null)).toBe(null);
  });

  it('should return null for undefined input', () => {
    expect(normalizePhone(undefined)).toBe(null);
  });

  it('should return null for empty string', () => {
    expect(normalizePhone('')).toBe(null);
  });

  it('should return null for too short number', () => {
    expect(normalizePhone('123')).toBe(null);
  });

  it('should return null for 9-digit number', () => {
    expect(normalizePhone('2125551')).toBe(null);
  });

  it('should handle number with only special characters', () => {
    expect(normalizePhone('---()--')).toBe(null);
  });

  it('should extract digits and normalize mixed input', () => {
    expect(normalizePhone('1 (212) 555-1234')).toBe('+12125551234');
  });

  it('should handle numeric input', () => {
    expect(normalizePhone(2125551234)).toBe('+12125551234');
  });
});
