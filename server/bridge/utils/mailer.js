/**
 * Centralized SMTP Transporter Management
 * Provides a shared nodemailer transporter instance for all modules
 */

const nodemailer = require('nodemailer');
const { logger } = require('./logger');

// Lazy-initialized singleton transporter
let transporter = null;

/**
 * Get or create the SMTP transporter
 * Ensures a single transporter instance across the application
 * @returns {object|null} Nodemailer transporter or null if SMTP not configured
 */
function getTransporter() {
  if (!transporter) {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true';

    if (!host || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      logger.warn('[mailer] SMTP not configured — transporter will be null');
      return null;
    }

    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    logger.info(`[mailer] Initialized transporter (${host}:${port}, secure=${secure})`);
  }

  return transporter;
}

module.exports = { getTransporter };
