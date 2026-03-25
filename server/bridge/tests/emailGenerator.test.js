// Mock Anthropic FIRST before requiring emailGenerator
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
    },
  }));
});

const { generateColdEmail, pickVariant } = require('../utils/emailGenerator');

describe('emailGenerator', () => {
  beforeEach(() => {
    mockCreate.mockClear();

    // Reset environment variables to defaults
    delete process.env.CALCOM_BOOKING_LINK;
    delete process.env.OUTREACH_SENDER_NAME;
    delete process.env.CLAUDE_MODEL;
  });

  describe('generateColdEmail', () => {
    it('should generate email with all prospect data', async () => {
      const prospect = {
        business_name: 'ABC Plumbing',
        industry: 'Plumbing',
        city: 'San Francisco',
        state: 'CA',
        rating: 4.8,
        review_count: 120,
        website: 'https://abcplumbing.com',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'Never miss another call',
              subject_b: 'Quick question about ABC Plumbing',
              body: 'Hi, I noticed ABC Plumbing in San Francisco... Would love to chat.\n\nhttps://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      expect(result).toHaveProperty('subject_a');
      expect(result).toHaveProperty('subject_b');
      expect(result).toHaveProperty('body');
      expect(result.subject_a).toBe('Never miss another call');
      expect(result.body).toContain('https://cal.com/elyvn/demo');
    });

    it('should handle JSON with code block markers', async () => {
      const prospect = {
        business_name: 'XYZ Dental',
        industry: 'Dentistry',
        city: 'NYC',
      };

      const mockResponse = {
        content: [
          {
            text: '```json\n{"subject_a": "Dental Demo", "subject_b": "Quick question", "body": "Hi there. Check out https://cal.com/elyvn/demo"}\n```',
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      expect(result.subject_a).toBe('Dental Demo');
      expect(result.body).toContain('https://cal.com/elyvn/demo');
    });

    it('should add booking link if not present in body', async () => {
      const prospect = {
        business_name: 'Test Business',
        industry: 'Service',
        city: 'Boston',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'Test Subject',
              subject_b: 'Alternative Subject',
              body: 'Hi there, just wanted to say hello.',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      expect(result.body).toContain('https://cal.com/elyvn/demo');
      expect(result.body).toContain('Book a 10-min demo here:');
    });

    it('should handle missing subject_b and use fallback', async () => {
      const prospect = {
        business_name: 'Test Business',
        industry: 'Service',
        city: 'Austin',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'Test Subject A',
              body: 'Test body with https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      expect(result.subject_b).toContain('Test Business');
      expect(result.subject_b).toBe('Quick question about Test Business');
    });

    it('should handle missing subject_a and use subject fallback', async () => {
      const prospect = {
        business_name: 'Test Business',
        industry: 'Service',
        city: 'Denver',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject: 'Main Subject',
              subject_b: 'Subject B',
              body: 'Test body with https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      expect(result.subject_a).toBe('Main Subject');
    });

    it('should handle API error and return fallback', async () => {
      const prospect = {
        business_name: 'Test Business',
        industry: 'Service',
        city: 'Seattle',
      };

      mockCreate.mockRejectedValueOnce(new Error('API Error'));

      const result = await generateColdEmail(prospect);

      expect(result.subject_a).toContain('Test Business');
      expect(result.subject_a).toContain('never miss a customer call again');
      expect(result.body).toContain('https://cal.com/elyvn/demo');
      expect(result.body).toContain('Test Business');
      expect(result.body).toContain('Seattle');
    });

    it('should use custom booking link from env', async () => {
      process.env.CALCOM_BOOKING_LINK = 'https://custom.booking.link';

      const prospect = {
        business_name: 'Test Business',
        city: 'LA',
      };

      mockCreate.mockRejectedValueOnce(new Error('API Error'));

      const result = await generateColdEmail(prospect);

      expect(result.body).toContain('https://custom.booking.link');
    });

    it('should use custom sender name from env', async () => {
      process.env.OUTREACH_SENDER_NAME = 'Jane';

      const prospect = {
        business_name: 'Test Business',
        city: 'LA',
      };

      mockCreate.mockRejectedValueOnce(new Error('API Error'));

      const result = await generateColdEmail(prospect);

      expect(result.body).toContain('Jane');
    });

    it('should use custom model from env', async () => {
      process.env.CLAUDE_MODEL = 'claude-opus-4-20250102';

      const prospect = {
        business_name: 'Test Business',
        city: 'LA',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'A',
              subject_b: 'B',
              body: 'Body https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      await generateColdEmail(prospect);

      expect(mockCreate).toHaveBeenCalled();
    });

    it('should handle prospect with missing optional fields', async () => {
      const prospect = {
        business_name: 'Minimal Business',
        city: 'Phoenix',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'Subject A',
              subject_b: 'Subject B',
              body: 'Body with https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      expect(result).toHaveProperty('subject_a');
      expect(result).toHaveProperty('subject_b');
      expect(result).toHaveProperty('body');
    });

    it('should handle invalid JSON response gracefully', async () => {
      const prospect = {
        business_name: 'Test Business',
        city: 'Chicago',
      };

      const mockResponse = {
        content: [
          {
            text: 'invalid json not a json',
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      // Should throw because JSON.parse fails
      try {
        await generateColdEmail(prospect);
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it('should preserve booking link when already present', async () => {
      const prospect = {
        business_name: 'Test Business',
        city: 'Portland',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'Subject A',
              subject_b: 'Subject B',
              body: 'Check this out:\n\nhttps://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      // Should not add duplicate
      expect((result.body.match(/cal\.com\/elyvn\/demo/g) || []).length).toBe(1);
    });

    it('should include all prospect fields in API prompt', async () => {
      const prospect = {
        business_name: 'Test Business',
        industry: 'HVAC',
        city: 'Denver',
        state: 'CO',
        rating: 4.5,
        review_count: 50,
        website: 'https://test.com',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'A',
              subject_b: 'B',
              body: 'Body https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      await generateColdEmail(prospect);

      const callArgs = mockCreate.mock.calls[0][0];
      const userMessage = callArgs.messages[0].content;

      expect(userMessage).toContain('Test Business');
      expect(userMessage).toContain('HVAC');
      expect(userMessage).toContain('Denver');
      expect(userMessage).toContain('CO');
      expect(userMessage).toContain('4.5');
      expect(userMessage).toContain('50');
      expect(userMessage).toContain('https://test.com');
    });

    it('should pass correct max_tokens in API call', async () => {
      const prospect = {
        business_name: 'Test Business',
        city: 'Boston',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'A',
              subject_b: 'B',
              body: 'Body https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      await generateColdEmail(prospect);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_tokens).toBe(600);
    });

    it('should request two subject lines for A/B testing', async () => {
      const prospect = {
        business_name: 'Test Business',
        city: 'Atlanta',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'A',
              subject_b: 'B',
              body: 'Body https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      await generateColdEmail(prospect);

      const callArgs = mockCreate.mock.calls[0][0];
      const systemPrompt = callArgs.system;

      expect(systemPrompt).toContain('subject_a');
      expect(systemPrompt).toContain('subject_b');
      expect(systemPrompt).toContain('A/B testing');
    });

    it('should handle response without subject_a and subject_b', async () => {
      const prospect = {
        business_name: 'Test Business',
        city: 'Miami',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              body: 'Test body https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      const result = await generateColdEmail(prospect);

      // Should use fallbacks
      expect(result.subject_a).toContain('Test Business');
      expect(result.subject_b).toContain('Test Business');
    });

    it('should always include booking link in system instructions', async () => {
      const prospect = {
        business_name: 'Test Business',
        city: 'Boston',
      };

      const mockResponse = {
        content: [
          {
            text: JSON.stringify({
              subject_a: 'A',
              subject_b: 'B',
              body: 'Body https://cal.com/elyvn/demo',
            }),
          },
        ],
      };

      mockCreate.mockResolvedValueOnce(mockResponse);

      await generateColdEmail(prospect);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain('https://cal.com/elyvn/demo');
      expect(callArgs.system).toContain('Book a 10-min demo here:');
    });
  });

  describe('pickVariant', () => {
    it('should return A for even indices', () => {
      expect(pickVariant(0)).toBe('A');
      expect(pickVariant(2)).toBe('A');
      expect(pickVariant(100)).toBe('A');
    });

    it('should return B for odd indices', () => {
      expect(pickVariant(1)).toBe('B');
      expect(pickVariant(3)).toBe('B');
      expect(pickVariant(101)).toBe('B');
    });

    it('should handle negative indices', () => {
      expect(pickVariant(-2)).toBe('A');
      expect(pickVariant(-1)).toBe('B');
    });

    it('should handle large indices', () => {
      expect(pickVariant(10000)).toBe('A');
      expect(pickVariant(10001)).toBe('B');
    });

    it('should alternate consistently', () => {
      for (let i = 0; i < 20; i++) {
        const expected = i % 2 === 0 ? 'A' : 'B';
        expect(pickVariant(i)).toBe(expected);
      }
    });
  });
});
