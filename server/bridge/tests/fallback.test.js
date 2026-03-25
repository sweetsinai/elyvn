/**
 * Tests for fallback.js
 * Tests template loading and variable substitution
 */

const path = require('path');
const fs = require('fs');
const { loadTemplate } = require('../utils/fallback');

jest.mock('fs');

describe('fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadTemplate', () => {
    test('loads and returns template content', () => {
      const templateContent = 'Hello {name}, your appointment is at {time}';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(templateContent);

      const result = loadTemplate('client1', 'appointment', {
        name: 'John',
        time: '2 PM'
      });

      expect(result).toBe('Hello John, your appointment is at 2 PM');
    });

    test('returns null when template file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      const result = loadTemplate('client1', 'nonexistent', {});

      expect(result).toBeNull();
    });

    test('substitutes multiple variables', () => {
      const template = '{greeting} {name}, your code is {code}. Your email is {email}.';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', {
        greeting: 'Hi',
        name: 'Alice',
        code: '12345',
        email: 'alice@example.com'
      });

      expect(result).toBe('Hi Alice, your code is 12345. Your email is alice@example.com.');
    });

    test('leaves unmapped variables as-is', () => {
      const template = 'Hello {name}, your code is {code}.';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', { name: 'John' });

      expect(result).toBe('Hello John, your code is {code}.');
    });

    test('handles empty variables object', () => {
      const template = 'Hello world';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', {});

      expect(result).toBe('Hello world');
    });

    test('handles null/undefined variable values', () => {
      const template = 'Name: {name}, Code: {code}';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', {
        name: null,
        code: undefined,
        other: 'test'
      });

      expect(result).toBe('Name: , Code: ');
    });

    test('converts non-string values to strings', () => {
      const template = 'Score: {score}, Active: {active}';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', {
        score: 95,
        active: true
      });

      expect(result).toBe('Score: 95, Active: true');
    });

    test('reads template file from correct path', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('Template content');

      loadTemplate('myclient', 'welcome', {});

      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('myclient'),
        'utf8'
      );
      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('welcome.txt'),
        'utf8'
      );
    });

    test('handles read errors gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = loadTemplate('client1', 'test', {});

      expect(result).toBeNull();
    });

    test('replaces all occurrences of a variable', () => {
      const template = 'Hello {name}, welcome {name}. {name} is great!';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', { name: 'John' });

      expect(result).toBe('Hello John, welcome John. John is great!');
    });

    test('handles special regex characters in variable names', () => {
      const template = 'Value: {test.var}';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', { 'test.var': 'special' });

      expect(result).toBe('Value: special');
    });

    test('returns default empty variables when none provided', () => {
      const template = 'Static text';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test');

      expect(result).toBe('Static text');
    });

    test('handles zero and false values correctly', () => {
      const template = 'Count: {count}, Enabled: {enabled}';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(template);

      const result = loadTemplate('client1', 'test', {
        count: 0,
        enabled: false
      });

      expect(result).toBe('Count: 0, Enabled: false');
    });

    test('constructs correct template path with client and name', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('content');

      loadTemplate('client-abc', 'sms_followup', {});

      const callPath = fs.readFileSync.mock.calls[0][0];
      expect(callPath).toContain('client-abc');
      expect(callPath).toContain('sms_followup.txt');
      expect(callPath).toContain('mcp/templates');
    });
  });
});
