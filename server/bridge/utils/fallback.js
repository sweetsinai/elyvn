const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '../../mcp/templates');

/**
 * Load and render a template file with variable substitution.
 * @param {string} clientId - Client ID (subdirectory name)
 * @param {string} templateName - Template name (without .txt extension)
 * @param {object} variables - Key-value pairs for substitution
 * @returns {string|null} Rendered template or null if file doesn't exist
 */
function loadTemplate(clientId, templateName, variables = {}) {
  const filePath = path.join(TEMPLATES_DIR, clientId, `${templateName}.txt`);

  try {
    if (!fs.existsSync(filePath)) {
      console.log(`[fallback] Template not found: ${filePath}`);
      return null;
    }

    let content = fs.readFileSync(filePath, 'utf8');

    // Replace all {variable_name} with values
    for (const [key, value] of Object.entries(variables)) {
      content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value ?? ''));
    }

    return content;
  } catch (err) {
    console.error('[fallback] loadTemplate error:', err);
    return null;
  }
}

module.exports = { loadTemplate };
