/**
 * API Versioning Middleware
 * Reads version from Accept-Version header or URL prefix (/v1/, /v2/).
 * Sets req.apiVersion and adds version/deprecation response headers.
 */

const SUPPORTED_VERSIONS = ['v1', 'v2'];
const CURRENT_VERSION = 'v2';

function apiVersionMiddleware(req, res, next) {
  let version = null;

  // 1. Check Accept-Version header
  const headerVersion = req.headers['accept-version'];
  if (headerVersion) {
    const normalized = headerVersion.startsWith('v') ? headerVersion : `v${headerVersion}`;
    if (SUPPORTED_VERSIONS.includes(normalized)) {
      version = normalized;
    }
  }

  // 2. Check URL prefix (overrides header if present in path)
  const pathMatch = req.path.match(/^\/(v\d+)\//);
  if (pathMatch && SUPPORTED_VERSIONS.includes(pathMatch[1])) {
    version = pathMatch[1];
  }

  // 3. Default to v1
  req.apiVersion = version || 'v1';

  // Response headers
  res.setHeader('X-API-Version', req.apiVersion);

  if (req.apiVersion === 'v1') {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Wed, 01 Jan 2027 00:00:00 GMT');
  } else {
    res.setHeader('Deprecation', 'false');
  }

  next();
}

module.exports = { apiVersionMiddleware, SUPPORTED_VERSIONS, CURRENT_VERSION };
