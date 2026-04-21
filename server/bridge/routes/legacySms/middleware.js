/**
 * Legacy SMS webhook signature verification middleware (Ed25519).
 */

const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');

function verifyLegacy SMSSignature(req, res, next) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[legacySms] TELNYX_PUBLIC_KEY not configured in production — rejecting');
      return next(new AppError('WEBHOOK_NOT_CONFIGURED', 'Webhook signature verification not configured', 500));
    }
    logger.warn('[legacySms] TELNYX_PUBLIC_KEY not configured — skipping signature validation');
    return next();
  }
  try {
    const crypto = require('crypto');
    const signature = req.headers['legacySms-signature-ed25519'];
    const timestamp = req.headers['legacySms-timestamp'];

    if (!signature || !timestamp) {
      if (process.env.NODE_ENV === 'production') {
        logger.warn('[legacySms] Missing signature headers in production — rejecting');
        return next(new AppError('MISSING_SIGNATURE', 'Missing webhook signature', 401));
      }
      logger.warn('[legacySms] Missing legacySms-signature-ed25519 or legacySms-timestamp header');
      return next(); // Allow through in dev — might be test webhook
    }

    // Reconstruct signed content: timestamp + raw body
    const body = req.rawBody || '';
    const signedContent = timestamp + body;

    // Verify Ed25519 signature
    const publicKeyObj = crypto.createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    });

    const signatureBuf = Buffer.from(signature, 'base64');
    const isValid = crypto.verify(
      null,
      Buffer.from(signedContent, 'utf-8'),
      publicKeyObj,
      signatureBuf
    );

    if (!isValid) {
      logger.error('[legacySms] Invalid webhook signature');
      return next(new AppError('INVALID_SIGNATURE', 'Invalid signature', 401));
    }

    // Replay prevention: reject stale or future-dated timestamps
    const tsMs = parseInt(timestamp, 10) * 1000; // Legacy SMS sends seconds
    const drift = Math.abs(Date.now() - tsMs);
    if (drift > 5 * 60 * 1000) {
      logger.warn('[legacySms] Webhook timestamp too old or too far in future — possible replay attack');
      return res.status(400).json({ error: 'Webhook timestamp too old — possible replay attack' });
    }

    next();
  } catch (err) {
    logger.error('[legacySms] Signature validation error:', err.message);
    return next(new AppError('SIGNATURE_VALIDATION_ERROR', 'Webhook signature validation failed', 401));
  }
}

module.exports = { verifyLegacy SMSSignature };
