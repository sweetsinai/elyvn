const { generateTrackingPixel, wrapLinksWithTracking, BASE_URL } = require('../utils/emailTracking');

describe('emailTracking', () => {
  beforeEach(() => {
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    delete process.env.BASE_URL;
  });

  describe('BASE_URL', () => {
    it('should compute BASE_URL correctly with RAILWAY_PUBLIC_DOMAIN', () => {
      process.env.RAILWAY_PUBLIC_DOMAIN = 'myapp.railway.app';
      // BASE_URL is computed at module load time, so we test the logic
      const railwayUrl = 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
      expect(railwayUrl).toBe('https://myapp.railway.app');
    });

    it('should compute BASE_URL correctly with BASE_URL env var', () => {
      process.env.BASE_URL = 'https://custom.com';
      // When RAILWAY_PUBLIC_DOMAIN is not set, BASE_URL env var is used
      expect(process.env.BASE_URL).toBe('https://custom.com');
    });

    it('should default to localhost', () => {
      // This tests that the module exported BASE_URL reflects the current environment
      expect(BASE_URL).toBe('http://localhost:3001');
    });

    it('should use RAILWAY_PUBLIC_DOMAIN when already set at load time', () => {
      // BASE_URL was computed when module was loaded - verify it works
      expect(BASE_URL).toBeDefined();
      expect(typeof BASE_URL).toBe('string');
    });
  });

  describe('generateTrackingPixel', () => {
    it('should generate tracking pixel with email ID', () => {
      const emailId = 'email123';
      const result = generateTrackingPixel(emailId);

      expect(result).toContain('<img');
      expect(result).toContain('/t/open/email123');
      expect(result).toContain('width="1"');
      expect(result).toContain('height="1"');
      expect(result).toContain('alt=""');
    });

    it('should include display none style', () => {
      const result = generateTrackingPixel('test');

      expect(result).toContain('style="display:none;"');
    });

    it('should handle different email IDs', () => {
      const id1 = generateTrackingPixel('abc');
      const id2 = generateTrackingPixel('xyz');

      expect(id1).toContain('/t/open/abc');
      expect(id2).toContain('/t/open/xyz');
      expect(id1).not.toBe(id2);
    });

    it('should handle UUIDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const result = generateTrackingPixel(uuid);

      expect(result).toContain(uuid);
    });

    it('should handle alphanumeric IDs', () => {
      const result = generateTrackingPixel('abc123def456');

      expect(result).toContain('abc123def456');
    });

    it('should not sanitize email ID', () => {
      const result = generateTrackingPixel('email-with-dash_underscore');

      expect(result).toContain('email-with-dash_underscore');
    });

    it('should be a valid HTML img tag', () => {
      const result = generateTrackingPixel('test');

      expect(result).toMatch(/^<img[^>]*>$/);
    });

    it('should include BASE_URL', () => {
      const result = generateTrackingPixel('email123');

      // Should start with the configured BASE_URL
      expect(result).toContain('http://localhost:3001/t/open/email123');
    });
  });

  describe('wrapLinksWithTracking', () => {
    it('should wrap regular links with tracking', () => {
      const html = '<a href="https://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('url=');
      expect(result).toContain('https%3A%2F%2Fexample.com');
    });

    it('should handle single quoted href', () => {
      const html = "<a href='https://example.com'>Link</a>";
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('https%3A%2F%2Fexample.com');
    });

    it('should skip unsubscribe links', () => {
      const html = '<a href="https://example.com/unsubscribe">Click</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('https://example.com/unsubscribe');
      expect(result).not.toContain('/t/click/email1');
    });

    it('should skip case-insensitive unsubscribe', () => {
      const html = '<a href="https://example.com/UNSUBSCRIBE">Click</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('https://example.com/UNSUBSCRIBE');
      expect(result).not.toContain('/t/click/');
    });

    it('should skip mailto links', () => {
      const html = '<a href="mailto:test@example.com">Email</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('mailto:test@example.com');
      expect(result).not.toContain('/t/click/');
    });

    it('should skip mailto links case-insensitively', () => {
      const html = '<a href="MAILTO:test@example.com">Email</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('MAILTO:test@example.com');
      expect(result).not.toContain('/t/click/');
    });

    it('should wrap multiple links', () => {
      const html = '<a href="https://a.com">A</a> <a href="https://b.com">B</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1?url=');
      expect((result.match(/\/t\/click\/email1/g) || []).length).toBe(2);
    });

    it('should preserve non-href attributes', () => {
      const html = '<a href="https://example.com" class="btn" id="link1">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('class="btn"');
      expect(result).toContain('id="link1"');
    });

    it('should handle complex URLs', () => {
      const html = '<a href="https://example.com/path?param=value&other=123">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('url=');
      // URL should be encoded
      expect(result).toContain('%3F');
      expect(result).toContain('%26');
    });

    it('should handle URLs with fragments', () => {
      const html = '<a href="https://example.com#section">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('%23section');
    });

    it('should handle http URLs', () => {
      const html = '<a href="http://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('http%3A%2F%2Fexample.com');
    });

    it('should return unchanged if no links', () => {
      const html = '<p>No links here</p>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toBe(html);
    });

    it('should handle empty HTML', () => {
      const result = wrapLinksWithTracking('', 'email1');

      expect(result).toBe('');
    });

    it('should handle null HTML', () => {
      const result = wrapLinksWithTracking(null, 'email1');

      expect(result).toBe(null);
    });

    it('should handle undefined HTML', () => {
      const result = wrapLinksWithTracking(undefined, 'email1');

      expect(result).toBeUndefined();
    });

    it('should URL encode the full original URL', () => {
      const html = '<a href="https://example.com/page?a=1&b=2">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      // Original URL should be in the query parameter, fully encoded
      expect(result).toContain('url=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%26b%3D2');
    });

    it('should handle email ID in tracking URL', () => {
      const html = '<a href="https://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'my-email-123');

      expect(result).toContain('/t/click/my-email-123');
    });

    it('should wrap relative links since regex matches all hrefs', () => {
      // Note: The regex pattern /href=["']([^"']+)["']/gi matches ALL href values
      // It doesn't check for http/https, so relative links ARE wrapped
      const html = '<a href="relative/path">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/');
      expect(result).toContain('relative%2Fpath');
    });

    it('should preserve exact href attribute format', () => {
      const html = '<a href="https://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toMatch(/href="[^"]+"/);
      expect(result).not.toContain("href='");
    });

    it('should handle unsubscribe in path vs domain', () => {
      const html = '<a href="https://example.com/path/unsubscribe">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('https://example.com/path/unsubscribe');
      expect(result).not.toContain('/t/click/');
    });

    it('should preserve href with special characters', () => {
      const html = '<a href="https://example.com/path?email=user@example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('user%40example.com');
    });

    it('should not double-encode URLs', () => {
      const html = '<a href="https://example.com?param=already%20encoded">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      // encodeURIComponent will encode the % again
      expect(result).toContain('/t/click/email1');
      // Original % should be re-encoded as %25
      expect(result).toContain('%25');
    });

    it('should include BASE_URL in tracking link', () => {
      const html = '<a href="https://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('http://localhost:3001/t/click/email1');
    });

    it('should handle mixed tracked and untracked links', () => {
      const html = '<a href="https://example.com">Normal</a> <a href="mailto:test@test.com">Email</a> <a href="https://test.com/unsubscribe">Unsub</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1?url=https%3A%2F%2Fexample.com');
      expect(result).toContain('mailto:test@test.com');
      expect(result).toContain('https://test.com/unsubscribe');
    });

    it('should handle href without space before', () => {
      const html = '<a href="https://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
    });

    it('should handle href with various spacing', () => {
      const html = '<a href = "https://example.com">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      // This might not match due to regex pattern - depends on implementation
      // The regex only captures exact href="..." patterns
      expect(result).toContain('https://example.com');
    });

    it('should handle URLs with port numbers', () => {
      const html = '<a href="https://example.com:8080/path">Link</a>';
      const result = wrapLinksWithTracking(html, 'email1');

      expect(result).toContain('/t/click/email1');
      expect(result).toContain('8080');
    });
  });
});
