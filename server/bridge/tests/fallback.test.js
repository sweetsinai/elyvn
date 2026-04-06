/**
 * Tests for fallback.js
 * Tests template loading and variable substitution
 */

const path = require('path');
const fs = require('fs');
const { loadTemplate } = require('../utils/fallback');

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      readFile: jest.fn(),
    },
  };
});

describe('fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadTemplate', () => {
    test('loads and returns template content', async () => {
      const templateContent = 'Hello {name}, your appointment is at {time}';
      fs.promises.readFile.mockResolvedValue(templateContent);

      const result = await loadTemplate('client1', 'appointment', {
        name: 'John',
        time: '2 PM'
      });

      expect(result).toBe('Hello John, your appointment is at 2 PM');
    });

    test('returns null when template file does not exist', async () => {
      fs.promises.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await loadTemplate('client1', 'nonexistent', {});

      expect(result).toBeNull();
    });

    test('substitutes multiple variables', async () => {
      const template = '{greeting} {name}, your code is {code}. Your email is {email}.';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', {
        greeting: 'Hi',
        name: 'Alice',
        code: '12345',
        email: 'alice@example.com'
      });

      expect(result).toBe('Hi Alice, your code is 12345. Your email is alice@example.com.');
    });

    test('leaves unmapped variables as-is', async () => {
      const template = 'Hello {name}, your code is {code}.';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', { name: 'John' });

      expect(result).toBe('Hello John, your code is {code}.');
    });

    test('handles empty variables object', async () => {
      const template = 'Hello world';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', {});

      expect(result).toBe('Hello world');
    });

    test('handles null/undefined variable values', async () => {
      const template = 'Name: {name}, Code: {code}';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', {
        name: null,
        code: undefined,
        other: 'test'
      });

      expect(result).toBe('Name: , Code: ');
    });

    test('converts non-string values to strings', async () => {
      const template = 'Score: {score}, Active: {active}';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', {
        score: 95,
        active: true
      });

      expect(result).toBe('Score: 95, Active: true');
    });

    test('reads template file from correct path', async () => {
      fs.promises.readFile.mockResolvedValue('Template content');

      await loadTemplate('myclient', 'welcome', {});

      expect(fs.promises.readFile).toHaveBeenCalledWith(
        expect.stringContaining('myclient'),
        'utf8'
      );
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        expect.stringContaining('welcome.txt'),
        'utf8'
      );
    });

    test('handles read errors gracefully', async () => {
      fs.promises.readFile.mockRejectedValue(new Error('Permission denied'));

      const result = await loadTemplate('client1', 'test', {});

      expect(result).toBeNull();
    });

    test('replaces all occurrences of a variable', async () => {
      const template = 'Hello {name}, welcome {name}. {name} is great!';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', { name: 'John' });

      expect(result).toBe('Hello John, welcome John. John is great!');
    });

    test('handles special regex characters in variable names', async () => {
      const template = 'Value: {test.var}';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', { 'test.var': 'special' });

      expect(result).toBe('Value: special');
    });

    test('returns default empty variables when none provided', async () => {
      const template = 'Static text';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test');

      expect(result).toBe('Static text');
    });

    test('handles zero and false values correctly', async () => {
      const template = 'Count: {count}, Enabled: {enabled}';
      fs.promises.readFile.mockResolvedValue(template);

      const result = await loadTemplate('client1', 'test', {
        count: 0,
        enabled: false
      });

      expect(result).toBe('Count: 0, Enabled: false');
    });

    test('constructs correct template path with client and name', async () => {
      fs.promises.readFile.mockResolvedValue('content');

      await loadTemplate('client-abc', 'sms_followup', {});

      const callPath = fs.promises.readFile.mock.calls[0][0];
      expect(callPath).toContain('client-abc');
      expect(callPath).toContain('sms_followup.txt');
      expect(callPath).toContain('mcp/templates');
    });
  });
});
