/**
 * Centralized phone normalization — single source of truth.
 * Used by leadMemory, forms, speed-to-lead, and brain.
 */

function normalizePhone(raw) {
  if (!raw) return null;
  let cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.length === 11 && cleaned.startsWith('1')) cleaned = '+' + cleaned;
  else if (cleaned.length === 10) cleaned = '+1' + cleaned;
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  if (cleaned.replace(/\D/g, '').length < 10) return null;
  return cleaned;
}

module.exports = { normalizePhone };
