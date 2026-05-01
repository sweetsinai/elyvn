'use strict';

const https = require('https');
const { logger } = require('./logger');
const { withRetry, withTimeout } = require('./resilience');

/**
 * Generic HTTP Client abstraction
 * Handles: JSON, Timeouts, Retries, Logging, and Correlation IDs
 */
class HttpClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || '';
    this.defaultHeaders = options.defaultHeaders || {};
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries || 0;
    this.serviceName = options.serviceName || 'HTTP';
  }

  async request(path, options = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...this.defaultHeaders, ...options.headers };
    const body = options.body;

    const executeRequest = async (signal) => {
      return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const requestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method,
          headers,
          signal,
        };

        const req = https.request(requestOptions, (res) => {
          let resBody = '';
          res.on('data', (chunk) => { resBody += chunk; });
          res.on('end', () => {
            const response = {
              status: res.statusCode,
              headers: res.headers,
              body: resBody,
            };

            if (res.headers['content-type']?.includes('application/json')) {
              try {
                response.data = JSON.parse(resBody);
              } catch (err) {
                response.parseError = err;
              }
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              const error = new Error(`${this.serviceName} request failed with status ${res.statusCode}`);
              error.status = res.statusCode;
              error.response = response;
              reject(error);
            }
          });
        });

        req.on('error', reject);

        if (body) {
          const payload = typeof body === 'string' ? body : JSON.stringify(body);
          if (!headers['Content-Type']) {
            req.setHeader('Content-Type', 'application/json');
          }
          req.setHeader('Content-Length', Buffer.byteLength(payload));
          req.write(payload);
        }
        req.end();
      });
    };

    const withTimeoutAndRetry = async () => {
      const callWithTimeout = (signal) => withTimeout(() => executeRequest(signal), this.timeoutMs, this.serviceName);
      
      if (this.maxRetries > 0) {
        return withRetry(() => callWithTimeout(), this.maxRetries, 1000, this.serviceName);
      }
      return callWithTimeout();
    };

    try {
      return await withTimeoutAndRetry();
    } catch (err) {
      logger.error(`[httpClient] ${method} ${url} failed:`, err.message);
      throw err;
    }
  }

  get(path, options = {}) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path, body, options = {}) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  put(path, body, options = {}) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  delete(path, options = {}) {
    return this.request(path, { ...options, method: 'DELETE' });
  }
}

module.exports = HttpClient;
