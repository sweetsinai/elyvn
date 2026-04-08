const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { logger } = require('./logger');

const anthropic = new Anthropic();

// P1: Sanitize prospect fields before prompt interpolation
function sanitizeField(str, maxLen = 100) {
  if (!str) return '';
  return String(str).replace(/[\r\n\t<>{}]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, maxLen);
}

async function generateColdEmail(prospect) {
  const {
    business_name: rawBusinessName,
    industry: rawIndustry,
    city: rawCity,
    state: rawState,
    rating,
    review_count,
    website: rawWebsite,
    owner_name: rawOwnerName,
  } = prospect;

  // P1: Sanitize all interpolated prospect fields
  const business_name = sanitizeField(rawBusinessName);
  const industry = sanitizeField(rawIndustry);
  const city = sanitizeField(rawCity);
  const state = sanitizeField(rawState);
  const website = sanitizeField(rawWebsite);

  const BOOKING_LINK = prospect._booking_link || config.outreach.bookingLink;
  const SENDER_NAME = prospect._sender_name || config.outreach.senderName;
  const MODEL = config.ai.model;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: `You write cold outreach emails for ELYVN, an AI receptionist service for service businesses.

The emails must be:
- Personal (reference the business by name, their city, their industry)
- Short (under 150 words)
- One clear CTA with this EXACT booking link: ${BOOKING_LINK}
- End with: "Book a 10-min demo here: ${BOOKING_LINK}" (always include the full URL)
- No spam words (free, guaranteed, act now)
- Professional but warm, written from ${SENDER_NAME}
- Sign off with ${SENDER_NAME}, ELYVN

Generate TWO alternative subject lines for A/B testing.

Return JSON only: {"subject_a": "...", "subject_b": "...", "body": "..."}`,
      messages: [{
        role: 'user',
        content: `Write a cold email for:
Business: ${business_name}
Industry: ${industry || 'service business'}
City: ${city}${state ? ', ' + state : ''}
Rating: ${rating || 'N/A'}/5 (${review_count || 0} reviews)
Website: ${website || 'N/A'}

The email should mention how AI answering can help them never miss a call and convert more leads. Include the booking link: ${BOOKING_LINK}

Generate two different subject lines (subject_a and subject_b) for A/B testing. Make them materially different in approach (e.g., one benefit-focused, one curiosity-focused).`
      }]
    });

    const text = resp.content[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    // P1: body is required — missing body is caught and falls to error fallback
    if (typeof result.body !== 'string') throw new Error('emailGenerator: body missing from Claude response');

    // Ensure booking link is in the body (safety net)
    let body = result.body;
    if (!body.includes(BOOKING_LINK)) {
      body += `\n\nBook a 10-min demo here: ${BOOKING_LINK}`;
    }

    // Subject fallback chain: result field → result.subject (legacy) → business_name fallback
    const subjectA = (typeof result.subject_a === 'string' ? result.subject_a : null)
      || (typeof result.subject === 'string' ? result.subject : null)
      || `${business_name} — never miss a customer call again`;
    const subjectB = (typeof result.subject_b === 'string' ? result.subject_b : null)
      || `Quick question about ${business_name}`;

    return {
      subject_a: subjectA.substring(0, 78),
      subject_b: subjectB.substring(0, 78),
      body
    };
  } catch (err) {
    logger.error('[EmailGen] Error:', err.message);
    // Fallback template — always includes booking link
    return {
      subject_a: `${business_name} — never miss a customer call again`,
      subject_b: `Quick question about ${business_name}`,
      body: `Hi,\n\nI noticed ${business_name} in ${city} and wanted to reach out. We help ${industry || 'service'} businesses answer every call with AI — so you never lose a lead to voicemail.\n\nWould you be open to a quick 10-minute demo?\n\nBook a time here: ${BOOKING_LINK}\n\nBest,\n${SENDER_NAME}\nELYVN`
    };
  }
}

/**
 * Pick variant A or B based on prospect index (even/odd)
 * @param {number} prospectIndex - Index of prospect in the list
 * @returns {string} 'A' or 'B'
 */
function pickVariant(prospectIndex) {
  return prospectIndex % 2 === 0 ? 'A' : 'B';
}

module.exports = { generateColdEmail, pickVariant };
