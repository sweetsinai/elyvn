/**
 * Backwards-compatibility shim — all validation logic lives in validators.js.
 * Existing imports of './validate' or '../utils/validate' continue to work unchanged.
 */

module.exports = require('./validators');
