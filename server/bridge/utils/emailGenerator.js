const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

async function generateColdEmail(prospect) {
  const { business_name, industry, city, state, rating, review_count, website } = prospect;

  const BOOKING_LINK = process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo';
  const SENDER_NAME = process.env.OUTREACH_SENDER_NAME || 'Sohan';
  const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: `You write cold outreach emails for ELYVN, an AI receptionist service for service businesses.

The emails must be:
- Personal (reference the business by name, their city, their industry)
- Short (under 150 words)
- One clear CTA with this EXACT booking link: ${BOOKING_LINK}
- End with: "Book a 10-min demo here: ${BOOKING_LINK}" (always include the full URL)
- No spam words (free, guaranteed, act now)
- Professional but warm, written from ${SENDER_NAME}
- Subject line under 50 chars
- Sign off with ${SENDER_NAME}, ELYVN

Return JSON only: {"subject": "...", "body": "..."}`,
      messages: [{
        role: 'user',
        content: `Write a cold email for:
Business: ${business_name}
Industry: ${industry || 'service business'}
City: ${city}${state ? ', ' + state : ''}
Rating: ${rating || 'N/A'}/5 (${review_count || 0} reviews)
Website: ${website || 'N/A'}

The email should mention how AI answering can help them never miss a call and convert more leads. Include the booking link: ${BOOKING_LINK}`
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

    return { subject: parsed.subject, body };
  } catch (err) {
    console.error('[EmailGen] Error:', err.message);
    // Fallback template — always includes booking link
    return {
      subject: `${business_name} — never miss a customer call again`,
      body: `Hi,\n\nI noticed ${business_name} in ${city} and wanted to reach out. We help ${industry || 'service'} businesses answer every call with AI — so you never lose a lead to voicemail.\n\nWould you be open to a quick 10-minute demo?\n\nBook a time here: ${BOOKING_LINK}\n\nBest,\n${SENDER_NAME}\nELYVN`
    };
  }
}

module.exports = { generateColdEmail };
