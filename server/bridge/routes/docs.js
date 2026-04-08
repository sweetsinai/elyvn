/**
 * API Documentation Routes
 *
 * GET /api/docs      — OpenAPI 3.0 spec as JSON
 * GET /api/docs/ui   — Swagger UI (development only)
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const router = express.Router();

// Lazy-parse the YAML spec once and cache it
let specCache = null;

function loadSpec() {
  if (specCache) return specCache;
  const yamlPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
  // Use js-yaml if available, otherwise return the raw file path for streaming
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const yaml = require('js-yaml');
    specCache = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
  } catch (_yamlErr) {
    // js-yaml not installed — callers will stream the raw YAML instead
    specCache = null;
  }
  return specCache;
}

/**
 * GET /api/docs
 * Serves the OpenAPI spec as JSON (preferred by programmatic consumers).
 * If js-yaml is unavailable the raw YAML file is streamed with the correct
 * Content-Type so clients can still use it.
 */
router.get('/docs', (req, res) => {
  const spec = loadSpec();
  if (spec) {
    return res.json(spec);
  }
  // Fallback: stream the raw YAML
  const yamlPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
  res.setHeader('Content-Type', 'application/yaml');
  res.sendFile(yamlPath);
});

/**
 * GET /api/docs/ui
 * Swagger UI — only available in non-production environments.
 * Uses unpkg CDN assets so no additional npm package is required at runtime.
 */
router.get('/docs/ui', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Swagger UI is disabled in production',
    });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ELYVN API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`);
});

module.exports = router;
