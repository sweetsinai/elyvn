'use strict';

const { URL } = require('url');

/**
 * Check if a hostname or IP is in a private/reserved range.
 * This is a basic implementation to avoid external dependencies.
 * 
 * @param {string} host - The hostname or IP address to check
 * @returns {boolean} True if the host is private/reserved
 */
function isPrivateHost(host) {
  if (!host) return true;

  const lowerHost = host.toLowerCase();

  // Internal hostnames and special IPs
  const internalHosts = [
    'localhost',
    'localhost.localdomain',
    'internal',
    'metadata.google.internal',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::',
  ];

  if (internalHosts.includes(lowerHost)) {
    return true;
  }

  // Domain suffixes
  if (lowerHost.endsWith('.local') || lowerHost.endsWith('.internal')) {
    return true;
  }

  // IPv4 Private Ranges
  // 10.0.0.0 – 10.255.255.255
  // 172.16.0.0 – 172.31.255.255
  // 192.168.0.0 – 192.168.255.255
  // 127.0.0.0 - 127.255.255.255
  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = host.match(ipv4Pattern);
  if (match) {
    const octets = match.slice(1).map(Number);
    if (octets.some(o => o > 255)) return false; // Invalid IP

    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
  }

  return false;
}

/**
 * Validate a URL for SSRF protection.
 * 
 * @param {string} urlStr - The URL to validate
 * @returns {boolean} True if the URL is safe
 */
function isSafeUrl(urlStr) {
  try {
    if (!urlStr || typeof urlStr !== 'string') return false;
    const parsed = new URL(urlStr);
    
    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    return !isPrivateHost(parsed.hostname);
  } catch (err) {
    return false;
  }
}

module.exports = { isPrivateHost, isSafeUrl };
