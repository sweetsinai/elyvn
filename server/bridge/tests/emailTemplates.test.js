const { wrapInTemplate, wrapWithCTA, escapeHtml } = require('../utils/emailTemplates');

describe('emailTemplates', () => {
  beforeEach(() => {
    delete process.env.BUSINESS_ADDRESS;
  });

  describe('escapeHtml', () => {
    it('should escape ampersands', () => {
      expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    it('should escape less than', () => {
      expect(escapeHtml('a < b')).toBe('a &lt; b');
    });

    it('should escape greater than', () => {
      expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('should escape quotes', () => {
      expect(escapeHtml('Say "hello"')).toBe('Say &quot;hello&quot;');
    });

    it('should escape multiple special characters', () => {
      expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
    });

    it('should handle empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should handle null', () => {
      expect(escapeHtml(null)).toBe('');
    });

    it('should handle undefined', () => {
      expect(escapeHtml(undefined)).toBe('');
    });

    it('should handle normal text', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
    });

    it('should convert non-string to string before escaping', () => {
      expect(escapeHtml(123)).toBe('123');
      expect(escapeHtml(true)).toBe('true');
    });
  });

  describe('wrapInTemplate', () => {
    it('should wrap plain text in HTML template', () => {
      const body = 'Hello World';
      const result = wrapInTemplate(body);

      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('</html>');
      expect(result).toContain('Hello World');
    });

    it('should convert paragraph breaks to HTML', () => {
      const body = 'First paragraph\n\nSecond paragraph';
      const result = wrapInTemplate(body);

      expect(result).toContain('<p style="margin: 0 0 16px 0; line-height: 1.6;">First paragraph</p>');
      expect(result).toContain('<p style="margin: 0 0 16px 0; line-height: 1.6;">Second paragraph</p>');
    });

    it('should handle multiple line breaks', () => {
      const body = 'Para 1\n\n\n\nPara 2';
      const result = wrapInTemplate(body);

      expect(result).toContain('<p style="margin: 0 0 16px 0; line-height: 1.6;">Para 1</p>');
      expect(result).toContain('<p style="margin: 0 0 16px 0; line-height: 1.6;">Para 2</p>');
    });

    it('should convert line breaks within paragraphs to <br>', () => {
      const body = 'Line 1\nLine 2';
      const result = wrapInTemplate(body);

      expect(result).toContain('Line 1<br>Line 2');
    });

    it('should convert URLs to clickable links', () => {
      const body = 'Check out https://example.com for more info';
      const result = wrapInTemplate(body);

      expect(result).toContain('<a href="https://example.com"');
      expect(result).toContain('https://example.com</a>');
      expect(result).toContain('style="color: #6C5CE7; text-decoration: underline;"');
    });

    it('should handle multiple URLs', () => {
      const body = 'Visit https://example.com or https://example.org';
      const result = wrapInTemplate(body);

      expect(result).toMatch(/<a href="https:\/\/example\.com"/);
      expect(result).toMatch(/<a href="https:\/\/example\.org"/);
    });

    it('should handle HTTP URLs', () => {
      const body = 'Go to http://example.com';
      const result = wrapInTemplate(body);

      expect(result).toContain('<a href="http://example.com"');
    });

    it('should not convert text that looks like URL but has no protocol', () => {
      const body = 'Just example.com text';
      const result = wrapInTemplate(body);

      // Should not create a link because no http(s)://
      expect(result).not.toContain('<a href="example.com"');
    });

    it('should escape HTML in body text', () => {
      const body = 'Test <script> & "malicious"';
      const result = wrapInTemplate(body);

      expect(result).toContain('Test &lt;script&gt; &amp; &quot;malicious&quot;');
      expect(result).not.toContain('<script>');
    });

    it('should include preheader when provided', () => {
      const body = 'Test body';
      const result = wrapInTemplate(body, { preheader: 'Preview text' });

      expect(result).toContain('display:none;font-size:1px;');
      expect(result).toContain('Preview text');
    });

    it('should escape preheader HTML', () => {
      const body = 'Test';
      const result = wrapInTemplate(body, { preheader: 'Test & <test>' });

      expect(result).toContain('Test &amp; &lt;test&gt;');
    });

    it('should not include preheader when empty', () => {
      const body = 'Test body';
      const result = wrapInTemplate(body, { preheader: '' });

      expect(result).not.toContain('display:none;font-size:1px;');
    });

    it('should include unsubscribe block when email provided', () => {
      const body = 'Test';
      const result = wrapInTemplate(body, { unsubscribeEmail: 'unsub@example.com' });

      expect(result).toContain('mailto:unsub@example.com?subject=unsubscribe');
      expect(result).toContain('Unsubscribe');
    });

    it('should escape unsubscribe email', () => {
      const body = 'Test';
      const result = wrapInTemplate(body, { unsubscribeEmail: 'test"@example.com' });

      expect(result).toContain('test&quot;@example.com');
    });

    it('should include business address in unsubscribe block', () => {
      process.env.BUSINESS_ADDRESS = '123 Main St, City, ST 12345';
      const body = 'Test';
      const result = wrapInTemplate(body, { unsubscribeEmail: 'unsub@example.com' });

      expect(result).toContain('123 Main St, City, ST 12345');
    });

    it('should not include unsubscribe block when no email', () => {
      const body = 'Test';
      const result = wrapInTemplate(body);

      expect(result).not.toContain('Unsubscribe');
      expect(result).not.toContain('mailto:');
    });

    it('should include business address without unsubscribe email', () => {
      process.env.BUSINESS_ADDRESS = '456 Elm St';
      const body = 'Test';
      const result = wrapInTemplate(body);

      expect(result).toContain('456 Elm St');
    });

    it('should include responsive meta tags', () => {
      const result = wrapInTemplate('Test');

      expect(result).toContain('viewport" content="width=device-width');
      expect(result).toContain('X-UA-Compatible');
    });

    it('should include brand styling', () => {
      const result = wrapInTemplate('Test');

      expect(result).toContain('border-collapse: collapse');
      expect(result).toContain('background-color: #f5f5f5');
    });

    it('should handle empty body', () => {
      const result = wrapInTemplate('');

      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('</html>');
    });

    it('should escape business address', () => {
      process.env.BUSINESS_ADDRESS = '<test> & "address"';
      const body = 'Test';
      const result = wrapInTemplate(body, { unsubscribeEmail: 'test@test.com' });

      expect(result).toContain('&lt;test&gt; &amp; &quot;address&quot;');
    });
  });

  describe('wrapWithCTA', () => {
    it('should create email with CTA button', () => {
      const result = wrapWithCTA(
        'Check this out',
        'Click Here',
        'https://example.com'
      );

      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('Check this out');
      expect(result).toContain('Click Here');
      expect(result).toContain('href="https://example.com"');
    });

    it('should escape CTA text', () => {
      const result = wrapWithCTA(
        'Test',
        'Button <script>',
        'https://example.com'
      );

      expect(result).toContain('Button &lt;script&gt;');
    });

    it('should escape CTA URL', () => {
      const result = wrapWithCTA(
        'Test',
        'Button',
        'https://example.com?q="test"'
      );

      expect(result).toContain('&quot;test&quot;');
    });

    it('should include signoff text when provided', () => {
      const result = wrapWithCTA(
        'Body text',
        'CTA',
        'https://example.com',
        'Best regards,\nJohn'
      );

      expect(result).toContain('Best regards,');
      expect(result).toContain('John');
    });

    it('should escape signoff HTML', () => {
      const result = wrapWithCTA(
        'Body',
        'CTA',
        'https://example.com',
        'Test <b>bold</b>'
      );

      expect(result).toContain('Test &lt;b&gt;bold&lt;/b&gt;');
    });

    it('should handle signoff with multiple lines', () => {
      const result = wrapWithCTA(
        'Body',
        'CTA',
        'https://example.com',
        'Line 1\nLine 2\nLine 3'
      );

      expect(result).toContain('Line 1<br>Line 2<br>Line 3');
    });

    it('should not include signoff row when empty', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com', '');

      const signoffRowCount = (result.match(/<tr>/g) || []).length;
      expect(result).not.toContain('undefined');
    });

    it('should include preheader when provided', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com', '', {
        preheader: 'Check this out',
      });

      expect(result).toContain('Check this out');
      expect(result).toContain('display:none;font-size:1px;');
    });

    it('should include unsubscribe block when email provided', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com', '', {
        unsubscribeEmail: 'test@example.com',
      });

      expect(result).toContain('mailto:test@example.com');
      expect(result).toContain('Unsubscribe');
    });

    it('should include business address in footer', () => {
      process.env.BUSINESS_ADDRESS = '789 Oak Ave';
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com', '', {
        unsubscribeEmail: 'test@example.com',
      });

      expect(result).toContain('789 Oak Ave');
    });

    it('should convert URLs in body to links', () => {
      const result = wrapWithCTA(
        'Visit https://example.com for details',
        'CTA',
        'https://cta.com'
      );

      expect(result).toContain('<a href="https://example.com"');
    });

    it('should include brand color in button', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com');

      expect(result).toContain('#6C5CE7');
    });

    it('should include MSO styling for Outlook', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com');

      expect(result).toContain('v:roundrect');
      expect(result).toContain('<!--[if mso]>');
      expect(result).toContain('<!--[if !mso]><!-->');
    });

    it('should format CTA with proper padding and border-radius', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com');

      expect(result).toContain('padding: 12px 32px');
      expect(result).toContain('border-radius: 6px');
      expect(result).toContain('font-weight: 600');
    });

    it('should handle empty body', () => {
      const result = wrapWithCTA('', 'CTA', 'https://example.com');

      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('CTA');
    });

    it('should parse paragraph breaks in body', () => {
      const result = wrapWithCTA('Para 1\n\nPara 2', 'CTA', 'https://example.com');

      expect(result).toContain('<p style="margin: 0 0 16px 0; line-height: 1.6;">Para 1</p>');
      expect(result).toContain('<p style="margin: 0 0 16px 0; line-height: 1.6;">Para 2</p>');
    });

    it('should handle internal line breaks', () => {
      const result = wrapWithCTA('Line 1\nLine 2', 'CTA', 'https://example.com');

      expect(result).toContain('Line 1<br>Line 2');
    });

    it('should include proper HTML structure', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com');

      expect(result).toContain('<html lang="en">');
      expect(result).toContain('<meta charset="utf-8">');
      expect(result).toContain('<body');
      expect(result).toContain('</body>');
      expect(result).toContain('</html>');
    });

    it('should accept empty options', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com', 'Sign', {});

      expect(result).toContain('Body');
      expect(result).toContain('CTA');
      expect(result).toContain('Sign');
    });

    it('should not include preheader div when not provided', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com');

      expect(result).not.toContain('display:none;font-size:1px;');
    });

    it('should escape special characters in preheader', () => {
      const result = wrapWithCTA('Body', 'CTA', 'https://example.com', '', {
        preheader: 'Test & <tag>',
      });

      expect(result).toContain('Test &amp; &lt;tag&gt;');
    });
  });
});
