/**
 * HTML Email Templates for ELYVN
 * Professional, mobile-responsive email templates for cold outreach & transactional emails.
 */

const BRAND_COLOR = '#6C5CE7';
const BRAND_LIGHT = '#A29BFE';

/**
 * Wraps plain text body in a clean, responsive HTML email template.
 * @param {string} body - Plain text email body
 * @param {object} [options] - Optional config
 * @param {string} [options.preheader] - Preview text shown in inbox
 * @param {string} [options.unsubscribeEmail] - Unsubscribe mailto address
 * @returns {string} Full HTML email
 */
function wrapInTemplate(body, options = {}) {
  const { preheader = '', unsubscribeEmail = '' } = options;

  // Convert plain text to HTML paragraphs
  const htmlBody = body
    .split(/\n\n+/)
    .map(para => {
      const lines = para.split('\n').map(line => escapeHtml(line)).join('<br>');
      return `<p style="margin: 0 0 16px 0; line-height: 1.6;">${lines}</p>`;
    })
    .join('');

  // Convert URLs in body to clickable links
  const linkedBody = htmlBody.replace(
    /(https?:\/\/[^\s<)"]+)/g,
    '<a href="$1" style="color: ' + BRAND_COLOR + '; text-decoration: underline;">$1</a>'
  );

  const unsubscribeBlock = unsubscribeEmail
    ? `<p style="margin: 0; font-size: 12px; color: #999;">
        <a href="mailto:${escapeHtml(unsubscribeEmail)}?subject=unsubscribe" style="color: #999; text-decoration: underline;">Unsubscribe</a>
      </p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>ELYVN</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  ${preheader ? `<div style="display:none;font-size:1px;color:#f5f5f5;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 32px 32px 24px 32px; font-size: 15px; color: #333333; line-height: 1.6;">
              ${linkedBody}
            </td>
          </tr>
          <tr>
            <td style="padding: 0 32px 24px 32px; text-align: center;">
              ${unsubscribeBlock}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Create a CTA-focused email with a prominent button.
 * @param {string} body - Plain text before the CTA
 * @param {string} ctaText - Button text (e.g., "Book a Demo")
 * @param {string} ctaUrl - Button URL
 * @param {string} [signoff] - Text after button
 * @param {object} [options] - Same as wrapInTemplate options
 * @returns {string} Full HTML email
 */
function wrapWithCTA(body, ctaText, ctaUrl, signoff = '', options = {}) {
  const { preheader = '', unsubscribeEmail = '' } = options;

  const htmlBody = body
    .split(/\n\n+/)
    .map(para => {
      const lines = para.split('\n').map(line => escapeHtml(line)).join('<br>');
      return `<p style="margin: 0 0 16px 0; line-height: 1.6;">${lines}</p>`;
    })
    .join('');

  const linkedBody = htmlBody.replace(
    /(https?:\/\/[^\s<)"]+)/g,
    '<a href="$1" style="color: ' + BRAND_COLOR + '; text-decoration: underline;">$1</a>'
  );

  const signoffHtml = signoff
    ? signoff.split('\n').map(l => escapeHtml(l)).join('<br>')
    : '';

  const unsubscribeBlock = unsubscribeEmail
    ? `<p style="margin: 0; font-size: 12px; color: #999;">
        <a href="mailto:${escapeHtml(unsubscribeEmail)}?subject=unsubscribe" style="color: #999; text-decoration: underline;">Unsubscribe</a>
      </p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ELYVN</title>
  <style>
    body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  ${preheader ? `<div style="display:none;font-size:1px;color:#f5f5f5;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 32px 32px 16px 32px; font-size: 15px; color: #333333; line-height: 1.6;">
              ${linkedBody}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 8px 32px 24px 32px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${escapeHtml(ctaUrl)}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="10%" strokecolor="${BRAND_COLOR}" fillcolor="${BRAND_COLOR}">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(ctaText)}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${escapeHtml(ctaUrl)}" style="display: inline-block; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 6px; font-size: 15px; font-weight: 600; line-height: 1.4;">${escapeHtml(ctaText)}</a>
              <!--<![endif]-->
            </td>
          </tr>
          ${signoffHtml ? `
          <tr>
            <td style="padding: 0 32px 24px 32px; font-size: 15px; color: #333333; line-height: 1.6;">
              <p style="margin: 0;">${signoffHtml}</p>
            </td>
          </tr>` : ''}
          <tr>
            <td style="padding: 0 32px 24px 32px; text-align: center;">
              ${unsubscribeBlock}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { wrapInTemplate, wrapWithCTA, escapeHtml };
