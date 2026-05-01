/**
 * Email verification sender
 * Sends branded verification emails via SMTP
 */

const { getTransporter } = require('./emailTransport');
const { logger } = require('./logger');
const config = require('./config');

/**
 * Send a verification email with a branded HTML template
 * @param {string} toEmail - Recipient email address
 * @param {string} token - Verification token
 * @param {string} baseUrl - Base URL for the verification link
 */
async function sendVerificationEmail(toEmail, token, baseUrl) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('[verification] SMTP not configured — skipping verification email');
    return;
  }

  const verifyUrl = `${baseUrl}/auth/verify-email?token=${token}`;
  const fromName = config.smtp.fromName || 'ELYVN';
  const fromEmail = config.smtp.user;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#060608;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#060608;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="text-align:center;padding:30px 0;">
              <h1 style="color:#C9A962;font-family:'Cormorant Garamond',Georgia,serif;font-size:32px;font-weight:300;margin:0;letter-spacing:4px;">ELYVN</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color:#0f0f12;border-radius:12px;padding:40px;border:1px solid #1a1a1f;">
              <h2 style="color:#F5F5F0;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:300;margin:0 0 16px;">Verify Your Email</h2>
              <p style="color:#a0a0a0;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Welcome to ELYVN. Please confirm your email address to activate your account and access all features.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background-color:#C9A962;border-radius:8px;">
                    <a href="${verifyUrl}" style="display:inline-block;padding:14px 32px;color:#060608;text-decoration:none;font-size:15px;font-weight:600;letter-spacing:0.5px;">
                      Verify Email Address
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color:#666;font-size:13px;line-height:1.5;margin:0 0 16px;">
                Or copy this link into your browser:
              </p>
              <p style="color:#C9A962;font-size:13px;word-break:break-all;margin:0 0 24px;">
                ${verifyUrl}
              </p>
              <p style="color:#555;font-size:12px;margin:0;">
                This link expires in 24 hours. If you did not create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="text-align:center;padding:24px 0;">
              <p style="color:#444;font-size:12px;margin:0;">&copy; ${new Date().getFullYear()} ELYVN. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: toEmail,
    subject: 'Verify your ELYVN account',
    html,
  });

  logger.info(`[verification] Verification email sent to ${toEmail}`);
}

module.exports = { sendVerificationEmail };
