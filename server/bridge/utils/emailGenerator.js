const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const anthropic = new Anthropic();

async function generateColdEmail(prospect) {
  const { business_name, industry, city, state, rating, review_count, website } = prospect;

  const BOOKING_LINK = config.outreach.bookingLink;
  const SENDER_NAME = config.outreach.senderName;
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
    const parsed = JSON.parse(cleaned);

    // Ensure booking link is in the body (safety net)
    let body = parsed.body;
    if (!body.includes(BOOKING_LINK)) {
      body += `\n\nBook a 10-min demo here: ${BOOKING_LINK}`;
    }

    return {
      subject_a: parsed.subject_a || parsed.subject || `${business_name} — never miss a customer call again`,
      subject_b: parsed.subject_b || `Quick question about ${business_name}`,
      body
    };
  } catch (err) {
    console.error('[EmailGen] Error:', err.message);
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
